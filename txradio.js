'use strict';
// Transmit transport for the ESP-SDR fork (esp32s3-tx / C5). Continuous output
// (REPLAY16 and CW) needs a keepalive within 5 s or the firmware drops RF and
// restores the receiver, so a TxSession owns a timer that renews the lease and
// stops cleanly. All radio I/O goes through the BurstSerialRadio command queue.

// Upload one REPLAY16 waveform and start repeating it. waveform: { iq, n, rate }.
BurstSerialRadio.prototype.replayStart = function (freqMHz, waveform) {
  return this.run(async () => {
    if (!['S3', 'C5'].includes(this.family)) throw Error('Transmit needs the esp32s3-tx (or C5) firmware.');
    if (!this.hasReplay) throw Error('This firmware does not advertise REPLAY. Flash the transmit profile.');
    await this.command('FREQ ' + Math.round(freqMHz));
    await this.line('OK');
    this.frequency = Math.round(freqMHz);
    const crc = (payloadCrc(waveform.iq) >>> 0).toString(16);
    await this.command(`REPLAY16 ${waveform.n} ${waveform.rate} ${crc}`);
    await this.line('READY');
    await this.writer.write(new Uint8Array(waveform.iq.buffer, waveform.iq.byteOffset, waveform.iq.byteLength));
    const r = await this.line();
    if (!r.startsWith('PLAYING')) throw Error(`Transmit rejected: ${r}`);
    this.transmitting = 'replay';
  });
};
BurstSerialRadio.prototype.cwStart = function (freqMHz) {
  return this.run(async () => {
    if (!this.hasCw) throw Error('This firmware does not advertise CW. Flash the transmit profile.');
    await this.command('FREQ ' + Math.round(freqMHz));
    await this.line('OK');
    this.frequency = Math.round(freqMHz);
    await this.command('CW START');
    await this.line('OK');
    this.transmitting = 'cw';
  });
};
BurstSerialRadio.prototype.transmitKeepalive = function () {
  return this.run(async () => {
    if (!this.transmitting) return;
    await this.command(this.transmitting === 'cw' ? 'CW KEEP' : 'REPLAY KEEP');
    await this.line('OK');
  });
};
BurstSerialRadio.prototype.transmitStop = function () {
  return this.run(async () => {
    if (!this.transmitting) return;
    const was = this.transmitting;
    this.transmitting = null;
    await this.command(was === 'cw' ? 'CW STOP' : 'REPLAY STOP');
    await this.line('OK').catch(() => {});
    this.frequency = null; // RF stop restores the receiver config
  });
};

// Session that keeps a transmission alive and reports lease renewals / errors.
class TxSession {
  constructor(radio, { onTick, onError } = {}) {
    this.radio = radio;
    this.onTick = onTick;
    this.onError = onError;
    this.timer = null;
    this.mode = null;
    this.startedAt = 0;
  }
  async startCW(freqMHz) {
    await this.stop();
    await this.radio.cwStart(freqMHz);
    this._arm('cw');
  }
  async startWaveform(freqMHz, waveform) {
    await this.stop();
    await this.radio.replayStart(freqMHz, waveform);
    this._arm('waveform');
  }
  _arm(mode) {
    this.mode = mode;
    this.startedAt = performance.now();
    // Renew at 3 s; the firmware lease is 5 s.
    this.timer = setInterval(async () => {
      try {
        await this.radio.transmitKeepalive();
        this.onTick?.((performance.now() - this.startedAt) / 1000);
      } catch (e) {
        this.stop();
        this.onError?.(e);
      }
    }, 3000);
  }
  get active() {
    return !!this.mode;
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.mode = null;
    await this.radio.transmitStop().catch(() => {});
  }
}
