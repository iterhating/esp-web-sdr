'use strict';
// Continuous decimated I/Q (IQS, ESP32-S3) on top of BurstSerialRadio.
//
// The 16 MS/s ring is low-pass filtered and decimated on the chip and sent as
// CRC-checked IQS1 frames whose header carries the decimated sample index, so
// every gap is measured exactly. Tuning combines whole-MHz FREQ, a FOFS PLL
// offset in kHz and a host-side NCO for the sub-kHz rest; the LO sits fs/4
// (4 MHz) below the wanted centre and firmware mode 2 rotates by j^n, so LO
// leakage and the 1/f hump at 0 Hz IF fall outside the output band.

const IQS_RING_RATE = 16000000;
const IQS_RING_CODE = 6;
const IQS_LO_OFFSET = IQS_RING_RATE / 4;
const IQS_DECIMATIONS = [64, 128, 256, 512, 1024];

// Output sample rates the S3 can stream, highest first.
function iqsRates() {
  return IQS_DECIMATIONS.map((d) => IQS_RING_RATE / d);
}

// Split a centre frequency into FREQ MHz, FOFS kHz and a residual for the NCO.
function iqsTuning(centerHz) {
  const lo = centerHz - IQS_LO_OFFSET,
    mhz = Math.round(lo / 1e6),
    khz = Math.max(-1000, Math.min(1000, Math.round((lo - mhz * 1e6) / 1e3)));
  return { mhz, khz, residualHz: lo - mhz * 1e6 - khz * 1e3 };
}

class IqStreamDecoder {
  constructor(bits, shift) {
    this.bits = bits;
    // Firmware output is the 10-bit sample x 32, rounded >> shift.
    this.scale = 2 ** shift / 16384;
    this.bytes = new Uint8Array();
    this.crcErrors = 0;
    this.nextIndex = null;
    this.lostSamples = 0;
  }
  feed(bytes) {
    const joined = new Uint8Array(this.bytes.length + bytes.length);
    joined.set(this.bytes);
    joined.set(bytes, this.bytes.length);
    this.bytes = joined;
    const events = [];
    let at = 0;
    while (this.bytes.length - at >= 6) {
      const b = this.bytes.subarray(at);
      const tag = String.fromCharCode(b[0], b[1], b[2], b[3]);
      const result = tag === 'IQS1' ? this.parseFrame(b) : tag === 'IQSE' ? this.parseEnd(b) : { used: 1 };
      if (!result) break;
      if (result.event) events.push(result.event);
      at += result.used;
    }
    this.bytes = this.bytes.slice(at);
    return events;
  }
  // "IQSEND <12 numbers>\n" ends a stream (same fields as SPECEND).
  parseEnd(b) {
    const end = b.indexOf(10);
    if (end < 0) return b.length > 256 ? { used: 1 } : null;
    const report = String.fromCharCode(...b.subarray(0, end)).trim();
    if (!/^IQSEND(?: \d+){12}$/.test(report)) return { used: 1 };
    return { used: end + 1, event: { report, status: Number(report.split(' ')[1]) } };
  }
  // IQS1: 24-byte header, interleaved I/Q payload, CRC32 of header + payload.
  parseFrame(b) {
    if (b.length < 24) return null;
    const dv = new DataView(b.buffer, b.byteOffset, 24),
      samples = dv.getUint16(16, true),
      bits = b[18],
      payload = bits === 16 ? samples * 4 : bits === 8 ? samples * 2 : samples;
    if (bits !== this.bits || payload > 4096) return { used: 1 };
    const length = 24 + payload + 4;
    if (b.length < length) return null;
    if (crc32(b.subarray(0, length - 4)) !== new DataView(b.buffer, b.byteOffset + length - 4, 4).getUint32(0, true)) {
      this.crcErrors++;
      return { used: 1 };
    }
    const index = Number(dv.getBigUint64(8, true));
    const gap = this.nextIndex === null ? 0 : index - this.nextIndex;
    if (gap > 0) this.lostSamples += gap;
    this.nextIndex = index + samples;
    // Conjugate: the raw stream has RF above the LO at negative frequency.
    const iq = new Float32Array(2 * samples),
      s = this.scale;
    if (bits === 16) {
      const p = new DataView(b.buffer, b.byteOffset + 24, payload);
      for (let j = 0; j < samples; j++) {
        iq[2 * j] = p.getInt16(4 * j, true) * s;
        iq[2 * j + 1] = -p.getInt16(4 * j + 2, true) * s;
      }
    } else if (bits === 8) {
      for (let j = 0; j < samples; j++) {
        iq[2 * j] = ((b[24 + 2 * j] << 24) >> 24) * s;
        iq[2 * j + 1] = -((b[25 + 2 * j] << 24) >> 24) * s;
      }
    } else {
      for (let j = 0; j < samples; j++) {
        const v = b[24 + j];
        iq[2 * j] = (((v & 15) << 28) >> 28) * s;
        iq[2 * j + 1] = -((v << 24) >> 28) * s;
      }
    }
    const header = {
      frame: dv.getUint32(4, true),
      index,
      samples,
      gap: gap > 0 ? gap : 0,
      flags: b[19],
      decimation: dv.getUint16(20, true),
      gain: b[22],
      shift: b[23],
    };
    return { used: length, event: { header, iq } };
  }
}

// Stream until shouldStop() turns true. c: { centerHz, rate, bits, shift,
// gainMode, gain }. onBlock(iq, header, info) gets conjugated float I/Q
// already mixed by the sub-kHz residual, so 0 Hz is exactly centerHz.
BurstSerialRadio.prototype.iqStream = function (c, onBlock, shouldStop) {
  return this.run(async () => {
    if (this.family !== 'S3') throw Error('Continuous I/Q needs an ESP32-S3 on its native USB port.');
    const decimation = IQS_RING_RATE / c.rate;
    if (!IQS_DECIMATIONS.includes(decimation)) throw Error('Unsupported stream rate');
    const bits = c.bits === 16 ? 16 : 8,
      shift = Number.isInteger(c.shift) ? c.shift : 15 - bits;
    const t = iqsTuning(c.centerHz);
    // Always resend: the board keeps FOFS across host reconnects. It applies
    // from the next tune, so force one.
    await this.command(`FOFS ${t.khz}`);
    await this.line('OK');
    this.frequency = null;
    // The narrowest analog filter (about +-7 MHz) still passes LO + 4 MHz.
    await this.tune(t.mhz, this.bandwidthRange ? this.bandwidthRange[0] : 0);
    const gain = await this.setGain(c.gainMode, c.gain);
    const decoder = new IqStreamDecoder(bits, shift);
    let ended = false,
      stopping = false,
      count = 0,
      phase = 0;
    const step = (-2 * Math.PI * t.residualHz) / c.rate;
    this.lossy = true;
    this.hostDropped = 0;
    try {
      await this.command(`IQS 0 ${decimation} ${bits} ${IQS_RING_CODE} ${shift} 2`);
      const head = (await this.line('IQS ')).split(' ');
      const info = {
        rate: Number(head[1]),
        decimation: Number(head[2]),
        bits: Number(head[3]),
        shift: Number(head[4]),
        mode: Number(head[5]),
        loMHz: Number(head[6]),
        centerHz: c.centerHz,
        tuning: t,
        gain,
        crcErrors: 0,
        lostSamples: 0,
      };
      if (info.decimation !== decimation || info.bits !== bits || info.mode !== 2)
        throw Error(`Unexpected IQS header: ${head.join(' ')}`);
      for (;;) {
        if ((++count & 15) === 0) await yieldTask();
        if (!stopping && shouldStop()) {
          stopping = true;
          await this.command('');
        }
        const events = decoder.feed(
          await this.read(Math.max(1, Math.min(this.queued, 16384)), performance.now() + 5000),
        );
        if (decoder.crcErrors !== info.crcErrors) {
          info.crcErrors = decoder.crcErrors;
          this.onCaptureError?.();
        }
        info.lostSamples = decoder.lostSamples;
        info.hostDropped = this.hostDropped;
        for (const event of events) {
          if (event.report) {
            ended = true;
            info.report = event.report;
            if (event.status) throw Error(`I/Q stream stopped: ${event.report}`);
            return info;
          }
          const iq = event.iq;
          if (step) {
            // Keep phase continuous across gaps by advancing over lost samples.
            phase += step * event.header.gap;
            for (let j = 0; j < iq.length; j += 2) {
              const cr = Math.cos(phase),
                ci = Math.sin(phase),
                re = iq[j],
                im = iq[j + 1];
              iq[j] = re * cr - im * ci;
              iq[j + 1] = re * ci + im * cr;
              phase += step;
            }
            phase %= 2 * Math.PI;
          }
          onBlock(iq, event.header, info);
        }
      }
    } finally {
      this.lossy = false;
      if (!ended && !this.failed && this.writer) {
        try {
          await this.command('');
          const deadline = performance.now() + 2000;
          while (!ended) {
            const events = decoder.feed(await this.read(Math.max(1, Math.min(this.queued, 16384)), deadline));
            ended = events.some((event) => event.report);
          }
        } catch (error) {
          // An unknown stream boundary must not be reused for ordinary commands.
          this.failed = error;
        }
      }
      // Burst capture and other pages assume whole-MHz tuning.
      if (ended && !this.failed && this.writer) {
        await this.command('FOFS 0');
        await this.line('OK');
        this.frequency = null;
      }
    }
  });
};
