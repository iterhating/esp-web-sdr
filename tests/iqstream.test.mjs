import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const read = (f) => readFile(new URL(`../${f}`, import.meta.url), 'utf8');
const ctx = vm.createContext({ performance });
for (const f of ['radio.js', 'iqstream.js', 'dsp.js']) vm.runInContext(await read(f), ctx);
const crc32 = vm.runInContext('crc32', ctx);
const decoder = (bits, shift) => vm.runInContext(`new IqStreamDecoder(${bits}, ${shift})`, ctx);

function frame({ seq = 0, index = 0, samples, bits = 8, flags = 0, values }) {
  const payload = bits === 16 ? samples * 4 : samples * 2,
    b = new Uint8Array(24 + payload + 4),
    v = new DataView(b.buffer);
  b.set([73, 81, 83, 49]);
  v.setUint32(4, seq, true);
  v.setBigUint64(8, BigInt(index), true);
  v.setUint16(16, samples, true);
  b[18] = bits;
  b[19] = flags;
  v.setUint16(20, 64, true);
  b[22] = 0;
  b[23] = 7;
  for (let j = 0; j < 2 * samples; j++)
    if (bits === 16) v.setInt16(24 + 2 * j, values[j], true);
    else v.setInt8(24 + j, values[j]);
  v.setUint32(24 + payload, crc32(b.subarray(0, 24 + payload)), true);
  return b;
}

test('IQS1 frames decode with scaling, conjugation and exact gap accounting', () => {
  const d = decoder(8, 7);
  const a = frame({ index: 0, samples: 2, values: [64, -32, -128, 127] }),
    b = frame({ seq: 1, index: 10, samples: 1, values: [1, 1] });
  const joined = new Uint8Array([...a, 0x55, ...b]); // stray byte between frames
  const events = [];
  for (let i = 0; i < joined.length; i += 5) events.push(...d.feed(joined.subarray(i, i + 5)));
  assert.equal(events.length, 2);
  // 8-bit with shift 7: full scale 16384 >> 7 = 128.
  assert.deepEqual([...events[0].iq], [0.5, 0.25, -1, -127 / 128]);
  assert.equal(events[1].header.gap, 8);
  assert.equal(d.lostSamples, 8);
  assert.equal(d.crcErrors, 0);
});

test('IQS1 frames with a bad CRC are counted and skipped; the end report is parsed', () => {
  const d = decoder(16, 0),
    f = frame({ samples: 1, bits: 16, values: [16384, -8192] });
  f[30] ^= 1;
  const report = new TextEncoder().encode('IQSEND 0 1 2 3 4 5 6 7 8 9 10 11\n');
  const events = d.feed(new Uint8Array([...f, ...report]));
  assert.equal(d.crcErrors, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 0);
});

test('tuning splits a centre into whole-MHz LO, FOFS kHz and a sub-kHz residual', () => {
  const t = (hz) => ({ ...vm.runInContext(`iqsTuning(${hz})`, ctx) });
  assert.deepEqual(t(2448e6), { mhz: 2444, khz: 0, residualHz: 0 });
  const u = t(2448.123456e6);
  assert.equal(u.mhz, 2444);
  assert.equal(u.khz, 123);
  assert.ok(Math.abs(u.residualHz - 456) < 1e-3);
  const w = t(2448.7e6);
  assert.equal(w.mhz * 1e6 + w.khz * 1e3 + w.residualHz + 4e6, 2448.7e6);
  assert.ok(Math.abs(w.khz) <= 500);
});

// Dominant frequency of a real signal by DFT magnitude over a coarse grid.
function dominant(x, rate, maxHz) {
  let best = 0,
    bestF = 0;
  for (let f = 50; f <= maxHz; f += 10) {
    let re = 0,
      im = 0;
    for (let n = 0; n < x.length; n++) {
      re += x[n] * Math.cos((2 * Math.PI * f * n) / rate);
      im -= x[n] * Math.sin((2 * Math.PI * f * n) / rate);
    }
    const m = re * re + im * im;
    if (m > best) {
      best = m;
      bestF = f;
    }
  }
  return bestF;
}
function tone(rate, n, f, extra = () => 0) {
  const iq = new Float32Array(2 * n);
  for (let k = 0; k < n; k++) {
    const ph = (2 * Math.PI * f * k) / rate + extra(k);
    iq[2 * k] = 0.3 * Math.cos(ph);
    iq[2 * k + 1] = 0.3 * Math.sin(ph);
  }
  return iq;
}
const demod = (rate, opts) => vm.runInContext(`new Demodulator(${rate}, ${JSON.stringify(opts)})`, ctx);

test('USB and LSB put a carrier offset from the dial at the matching audio pitch', () => {
  const rate = 62500;
  const usb = demod(rate, { mode: 'USB', offset: 10000 }),
    a = usb.process(tone(rate, 20000, 11000)).slice(2000);
  assert.ok(Math.abs(dominant(a, usb.audioRate, 3000) - 1000) <= 10);
  const lsb = demod(rate, { mode: 'LSB', offset: 10000 }),
    b = lsb.process(tone(rate, 20000, 8500)).slice(2000);
  assert.ok(Math.abs(dominant(b, lsb.audioRate, 3000) - 1500) <= 10);
  // The opposite sideband is rejected.
  const c = usb.process(tone(rate, 20000, 9000)).slice(2000);
  const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
  assert.ok(rms(c) < 0.05 * rms(a), `opposite sideband ${rms(c)} vs ${rms(a)}`);
});

test('NFM recovers the modulating tone and CW beats at the chosen pitch', () => {
  const rate = 125000,
    fm = demod(rate, { mode: 'NFM', offset: -20000 }),
    dev = 2500,
    fmod = 800;
  const iq = tone(rate, 40000, -20000, (k) => (dev / fmod) * Math.sin((2 * Math.PI * fmod * k) / rate));
  const a = fm.process(iq).slice(1000);
  assert.ok(Math.abs(dominant(a, fm.audioRate, 3000) - fmod) <= 10);
  const cw = demod(rate, { mode: 'CW', offset: 5000, cwPitch: 600 }),
    b = cw.process(tone(rate, 40000, 5100)).slice(2000);
  assert.ok(Math.abs(dominant(b, cw.audioRate, 2000) - 700) <= 10);
});

test('parabolic peak interpolation recovers a fractional bin', () => {
  const ip = vm.runInContext('interpolatePeak', ctx),
    curve = [0, 1, 2, 3, 4].map((i) => -((i - 2.3) ** 2));
  assert.ok(Math.abs(ip(curve, 2) - 2.3) < 1e-9);
});
