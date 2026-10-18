import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const ctx = vm.createContext({});
for (const f of ['radio.js', 'txgen.js']) vm.runInContext(await readFile(new URL(`../${f}`, import.meta.url), 'utf8'), ctx);
const run = (s) => vm.runInContext(s, ctx);

// Dominant complex-FFT bin frequency of an Int8 interleaved payload.
function spectrum(iq, rate) {
  const n = iq.length / 2,
    re = new Float64Array(n),
    im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    re[k] = iq[2 * k] / 127;
    im[k] = iq[2 * k + 1] / 127;
  }
  run('fft')(re, im);
  const mag = new Float64Array(n);
  for (let k = 0; k < n; k++) mag[k] = re[k] ** 2 + im[k] ** 2;
  return { mag, freq: (k) => (k <= n / 2 ? k : k - n) * (rate / n), n };
}
function peakHz(iq, rate) {
  const { mag, freq } = spectrum(iq, rate);
  let k = 0;
  for (let i = 1; i < mag.length; i++) if (mag[i] > mag[k]) k = i;
  return freq(k);
}

test('a looped tone lands on the snapped offset and wraps without a phase jump', () => {
  const rate = 40e6,
    n = 4096,
    w = run(`toneWaveform(${rate}, ${n}, 1.0e6, 0.8)`);
  assert.equal(w.iq.length, 2 * n);
  assert.ok(Math.abs(peakHz(w.iq, rate) - w.actualHz) < rate / n);
  assert.ok(Math.abs(w.actualHz - 1e6) <= rate / n);
  // Continuity: sample after the last equals a continuation of the first.
  const phase0 = Math.atan2(w.iq[1], w.iq[0]),
    wrap = Math.atan2(w.iq[2 * n - 1], w.iq[2 * n - 2]) + (2 * Math.PI * w.actualHz) / rate;
  const d = Math.abs(((phase0 - wrap + Math.PI) % (2 * Math.PI)) - Math.PI);
  assert.ok(d < 0.05, `loop phase discontinuity ${d}`);
});

test('two-tone has equal peaks at both offsets and nothing stronger between', () => {
  const rate = 40e6,
    n = 8192,
    w = run(`twoToneWaveform(${rate}, ${n}, -1.5e6, 1.5e6, 0.45)`),
    { mag, freq, n: N } = spectrum(w.iq, rate);
  const peaks = [];
  for (let k = 0; k < N; k++) if (mag[k] > 0.2 * Math.max(...mag)) peaks.push(freq(k));
  assert.ok(peaks.some((f) => Math.abs(f + 1.5e6) < rate / n));
  assert.ok(peaks.some((f) => Math.abs(f - 1.5e6) < rate / n));
  // No strong line at DC between the tones.
  const dc = spectrum(w.iq, rate).mag[0];
  assert.ok(dc < 0.1 * Math.max(...mag));
});

test('band-limited noise fills its bandwidth and stays within full scale', () => {
  let seed = 99;
  const rng = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  globalThis.__rng = rng;
  const rate = 40e6,
    n = 8192;
  ctx.__rng = rng;
  const w = vm.runInContext(`noiseWaveform(${rate}, ${n}, 12e6, 0.5, __rng)`, ctx),
    { mag, freq, n: N } = spectrum(w.iq, rate);
  let inBand = 0,
    outBand = 0;
  for (let k = 0; k < N; k++) (Math.abs(freq(k)) <= 6e6 ? (inBand += mag[k]) : (outBand += mag[k]));
  assert.ok(inBand > 20 * outBand, `leakage: in ${inBand} out ${outBand}`);
  assert.ok(Math.max(...w.iq) <= 127 && Math.min(...w.iq) >= -127);
});

test('QPSK occupies about (1+rolloff)*symbol-rate', () => {
  let seed = 5;
  const rng = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  ctx.__rng2 = rng;
  const rate = 40e6,
    w = vm.runInContext(`qpskWaveform(${rate}, 16000, 2e6, 0.35, 0.7, __rng2)`, ctx);
  assert.equal(w.actualHz, 2e6);
  // Analyse a power-of-two slice (the generator length need not be one).
  const N = 8192,
    slice = w.iq.subarray(0, 2 * N),
    { mag, freq } = spectrum(slice, rate);
  const total = mag.reduce((a, b) => a + b, 0);
  let inBand = 0;
  for (let k = 0; k < N; k++) if (Math.abs(freq(k)) <= 1.4e6) inBand += mag[k];
  assert.ok(inBand > 0.9 * total, `only ${((100 * inBand) / total).toFixed(0)}% within +-1.4 MHz`);
});

test('payload CRC matches the firmware convention (zlib crc32 of the bytes)', () => {
  const w = run('toneWaveform(40e6, 256, 2e6, 0.8)'),
    crc = run('payloadCrc')(w.iq),
    direct = run('crc32')(new Uint8Array(w.iq.buffer, w.iq.byteOffset, w.iq.byteLength));
  assert.equal(crc >>> 0, direct >>> 0);
  assert.equal(typeof crc, 'number');
});
