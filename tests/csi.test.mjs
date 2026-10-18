import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const ctx = vm.createContext({});
vm.runInContext(await readFile(new URL('../csi.js', import.meta.url), 'utf8'), ctx);
const { parseCsiLine, lltf, sanitizePhase } = ctx;

// Build an LLTF buffer (imag, real pairs in FFT order 0..31, -32..-1) from a
// function of the signed sub-carrier index.
function line(fn, extra = {}) {
  const data = [];
  for (let k = 0; k < 64; k++) {
    const s = k < 32 ? k : k - 64,
      [re, im] = fn(s);
    data.push(Math.round(im), Math.round(re));
  }
  const head = [7, 'aa:bb:cc:00:11:22', -41, 11, 1, 0, 0, 0, 1, 0, 0, 0, 0, -95, 0, 6, 0, 123456, 0, 60, 0,
    data.length, extra.firstInvalid ?? 0];
  return `CSI_DATA,${head.join(',')},"[${data.join(',')}]"`;
}

test('esp-csi CSV lines parse into metadata and signed CSI bytes', () => {
  const rec = parseCsiLine(line(() => [3, -4]));
  assert.equal(rec.seq, 7);
  assert.equal(rec.mac, 'aa:bb:cc:00:11:22');
  assert.equal(rec.rssi, -41);
  assert.equal(rec.channel, 6);
  assert.equal(rec.timestamp, 123456);
  assert.equal(rec.data.length, 128);
  assert.equal(rec.data[0], -4); // imaginary first
  assert.equal(rec.data[1], 3);
  assert.equal(parseCsiLine('CSI_DATA,1,2'), null);
  assert.equal(parseCsiLine(line(() => [3, -4]).replace('aa:bb', '<b>:bb')), null);
});

test('LLTF sub-carriers come out ordered -32..31 with amplitude and phase', () => {
  const { amp, phase } = lltf(parseCsiLine(line((s) => [s, 0])));
  assert.equal(amp[32 + 5], 5);
  assert.equal(amp[32 - 7], 7);
  assert.ok(Math.abs(phase[32 - 7] - Math.PI) < 1e-6); // Float32 storage
  assert.equal(phase[32 + 5], 0);
});

test('motion detector learns a still baseline, flags motion and releases with hysteresis', () => {
  const det = vm.runInContext('new MotionDetector({ windowS: 1, threshold: 2.5, release: 1.6, holdS: 1 })', ctx);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  // 20 packets/s; a fixed multipath profile with small noise, or with a
  // moving reflector modulating part of the profile.
  const packet = (t, moving, gain) =>
    Float32Array.from({ length: 64 }, (_, i) => {
      const s = i - 32,
        base = 40 + 15 * Math.cos(0.35 * s),
        move = moving ? 10 * Math.cos(0.2 * s + 2 * Math.PI * 1.3 * t) : 0;
      return gain * (base + move + 0.4 * rnd());
    });
  const events = [];
  det.calibrate(0, 5);
  for (let n = 0; n < 20 * 30; n++) {
    const t = n / 20,
      moving = t >= 10 && t < 18,
      gain = n % 50 < 25 ? 1 : 1.6; // AGC steps must not look like motion
    const e = det.push(packet(t, moving, gain), t);
    if (e) events.push({ ...e });
  }
  assert.equal(events[0].type, 'calibrated');
  const motion = events.find((e) => e.type === 'motion'),
    still = events.find((e) => e.type === 'still');
  assert.ok(motion && motion.t >= 10 && motion.t < 11.5, `motion at ${motion?.t}`);
  assert.ok(still && still.t > 18 && still.t < 21.5, `still at ${still?.t}`);
  assert.equal(events.filter((e) => e.type === 'motion').length, 1, 'no false triggers from gain steps');
});

test('phase sanitizing removes the per-packet timing slope and offset', () => {
  // Pure linear phase across sub-carriers (timing offset) plus a constant.
  const rec = parseCsiLine(line((s) => [60 * Math.cos(0.3 * s + 1), 60 * Math.sin(0.3 * s + 1)]));
  const clean = sanitizePhase(lltf(rec).phase);
  for (const s of [-26, -10, 1, 13, 26]) assert.ok(Math.abs(clean[s + 32]) < 0.05, `s=${s}: ${clean[s + 32]}`);
});
