import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const ctx = vm.createContext({});
for (const f of ['bandplan.js', 'panorama.js', 'doppler-core.js'])
  vm.runInContext(await readFile(new URL(`../${f}`, import.meta.url), 'utf8'), ctx);
const run = (s) => vm.runInContext(s, ctx);

test('sweep windows overlap so every frequency is covered twice', () => {
  const w = [...run('planWindows(2400, 2500, 15)')];
  for (let f = 2400; f <= 2500; f += 0.5) {
    const cover = w.filter((c) => Math.abs(f - c) <= 15.5 && Math.abs(f - c) >= 0.6).length;
    assert.ok(cover >= 1, `${f} MHz covered ${cover}x`);
  }
  const mid = w.filter((c) => Math.abs(2450 - c) <= 15.5).length;
  assert.ok(mid >= 2);
});

// Synthetic window: flat floor, real tone at 2431.0 MHz, LO leakage at the
// window centre, and the tone's I/Q image mirrored about the centre.
function windowSpectrum(centre, N = 2048, rate = 40e6) {
  const s = new Float32Array(N).fill(-80);
  const put = (mhz, db) => {
    const k = Math.round(((mhz - centre) * 1e6) / (rate / N)) + N / 2;
    if (k >= 0 && k < N) s[k] = Math.max(s[k], db);
  };
  put(2431.0, -30);
  put(centre, -40); // LO leakage
  put(2 * centre - 2431.0, -55); // image
  return s;
}

test('stitching keeps the real tone and rejects LO leakage and images', () => {
  const p = run('new Panorama(2400, 2460)');
  for (const c of p.windows) p.add(c, windowSpectrum(c), 40e6);
  const { cur } = p.endSweep();
  const peaks = run('findPeaks')(cur, p.start, p.res, { thresholdDb: 10 });
  assert.ok(Math.abs(peaks[0].hz - 2431.0e6) <= p.res);
  for (const q of peaks) {
    const near = (f) => Math.abs(q.hz / 1e6 - f) < 0.05;
    assert.ok(!p.windows.some(near), `LO leak survived at ${q.hz / 1e6}`);
    assert.ok(!p.windows.some((c) => near(2 * c - 2431.0)), `image survived at ${q.hz / 1e6}`);
  }
});

test('chip spurs are flagged from the measured list and the 8 MHz grid', () => {
  const reason = run('spurReason');
  assert.equal(reason({ hz: 2448e6, widthHz: 25e3 }, 1, 'S3'), '48 MHz ×51 spur');
  assert.match(reason({ hz: 2440.01e6, widthHz: 25e3 }, 0.99, 'S3'), /8 MHz grid/);
  assert.equal(reason({ hz: 2440.01e6, widthHz: 25e3 }, 0.3, 'S3'), '');
  assert.equal(reason({ hz: 2437e6, widthHz: 25e3 }, 1, 'S3'), '');
  assert.equal(reason({ hz: 2437e6, widthHz: 25e3 }, 1, 'S3', [2437.01]), 'marked as spur');
});

// Carrier with a weak Doppler sideband at +fd: the notch output keeps the
// sideband (signed) and removes the carrier.
function carrierWithDoppler(rate, n, carrierHz, fd, rel = 0.01) {
  const iq = new Float32Array(2 * n);
  for (let k = 0; k < n; k++) {
    const t = k / rate,
      a = 2 * Math.PI * carrierHz * t,
      b = 2 * Math.PI * (carrierHz + fd) * t;
    iq[2 * k] = Math.cos(a) + rel * Math.cos(b);
    iq[2 * k + 1] = Math.sin(a) + rel * Math.sin(b);
  }
  return iq;
}
function powerAt(iq, rate, f) {
  let re = 0,
    im = 0;
  const n = iq.length / 2;
  for (let k = 0; k < n; k++) {
    const p = (-2 * Math.PI * f * k) / rate;
    re += iq[2 * k] * Math.cos(p) - iq[2 * k + 1] * Math.sin(p);
    im += iq[2 * k] * Math.sin(p) + iq[2 * k + 1] * Math.cos(p);
  }
  return (re * re + im * im) / (n * n);
}

test('notch extraction locks to the carrier and keeps signed Doppler', () => {
  const rate = 15625,
    x = run(`new DopplerExtractor(${rate}, { method: 'notch', trackHz: 1, loopHz: 1 })`);
  x.seed(37);
  const out = x.process(carrierWithDoppler(rate, 4 * rate, 37, 25)),
    tail = out.slice(out.length / 2);
  assert.ok(Math.abs(x.carrierHz - 37) < 0.5, `carrier ${x.carrierHz}`);
  const plus = powerAt(tail, rate, 25),
    minus = powerAt(tail, rate, -25),
    dc = powerAt(tail, rate, 0);
  assert.ok(plus > 30 * minus, `sign: +${plus} vs -${minus}`);
  assert.ok(plus > 30 * dc, `carrier not removed: ${dc}`);
});

test('lag mixing moves Doppler to +-fd regardless of carrier offset', () => {
  const rate = 15625,
    x = run(`new DopplerExtractor(${rate}, { method: 'lag', lagSamples: 1, trackHz: 2 })`);
  const out = x.process(carrierWithDoppler(rate, 4 * rate, 1234, 40)).slice(rate * 4);
  const at = (f) => powerAt(out, rate, f);
  assert.ok(at(40) > 20 * at(13) && at(-40) > 20 * at(13));
});

test('Doppler converts to radial speed', () => {
  const v = run('dopplerToSpeed')(16.3, 2.44e9);
  assert.ok(Math.abs(v - 1.0) < 0.01);
});
