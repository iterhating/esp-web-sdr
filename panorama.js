'use strict';
// Panorama & survey: sweep every frequency the chip can reach with burst
// captures, stitch the windows onto one grid and rank the strongest signals.
//
// Each frequency is seen by two overlapping windows at different offsets from
// their LOs. LO leakage, I/Q images and other LO-relative artifacts land at a
// different absolute frequency in each window, so the stitched value is the
// smaller of the two (per-window max-hold first, so bursty signals still need
// to show in both). Chip spurs coherent with the crystal do not move with the
// LO; they are flagged from the band plan's measured list and by shape.

// ---- pure helpers (tested) ------------------------------------------------------
// Window centres (whole MHz) stepping `step` across [start, stop]; every
// frequency then lies within +-step of two centres.
function planWindows(start, stop, step = 15) {
  const out = [];
  for (let c = Math.floor(start - step / 2); c <= Math.ceil(stop + step / 2); c += step) out.push(c);
  return out;
}

class Panorama {
  // start/stop in MHz, res in Hz; keep = usable |offset| range in MHz.
  constructor(start, stop, { res = 25000, keep = [0.6, 15.5], step = 15 } = {}) {
    this.start = start * 1e6;
    this.stop = stop * 1e6;
    this.res = res;
    this.keep = keep;
    this.n = Math.ceil((this.stop - this.start) / res) + 1;
    this.windows = planWindows(start, stop, step);
    this.hold = new Map(); // centre -> Float32Array(n) per-window max-hold (linear) or NaN
    this.last = new Map(); // centre -> latest linear
    this.avg = null;
    this.max = null;
    this.activity = new Float32Array(this.n);
    this.sweeps = 0;
  }
  hz(i) {
    return this.start + i * this.res;
  }
  // Add one capture: spectrum in dB (fftshifted), centre MHz, sample rate Hz.
  add(centre, spectrumDb, rate) {
    const N = spectrumDb.length,
      binHz = rate / N,
      cur = new Float32Array(this.n).fill(NaN);
    for (let k = 0; k < N; k++) {
      const off = (k - N / 2) * binHz,
        a = Math.abs(off) / 1e6;
      if (a < this.keep[0] || a > this.keep[1]) continue;
      const i = Math.round((centre * 1e6 + off - this.start) / this.res);
      if (i < 0 || i >= this.n) continue;
      const lin = 10 ** (spectrumDb[k] / 10);
      if (!(cur[i] >= lin)) cur[i] = lin;
    }
    this.last.set(centre, cur);
    let h = this.hold.get(centre);
    if (!h) this.hold.set(centre, (h = cur.slice()));
    else for (let i = 0; i < this.n; i++) if (!(h[i] >= cur[i])) h[i] = Number.isNaN(cur[i]) ? h[i] : cur[i];
  }
  // Combine the latest windows into one sweep: min across covering windows
  // (consensus), or max (any window saw it).
  combine(source = this.last, any = false) {
    const out = new Float32Array(this.n).fill(NaN);
    for (const w of source.values())
      for (let i = 0; i < this.n; i++) {
        const v = w[i];
        if (Number.isNaN(v)) continue;
        if (Number.isNaN(out[i]) || (any ? v > out[i] : v < out[i])) out[i] = v;
      }
    return out;
  }
  // Finish a sweep: update averages, max-hold and activity; returns dB arrays.
  endSweep(alpha = 0.7, thresholdDb = 10) {
    // Activity counts a sweep if either window saw the signal: listed peaks are
    // already confirmed by consensus, and a burst rarely hits both windows.
    const cur = this.combine(),
      seen = this.combine(this.last, true),
      floor = median(cur);
    this.sweeps++;
    if (!this.avg) {
      this.avg = cur.slice();
      this.max = cur.slice();
    }
    const thr = floor * 10 ** (thresholdDb / 10),
      a = 1 / Math.min(this.sweeps, 20);
    for (let i = 0; i < this.n; i++) {
      const v = cur[i];
      if (Number.isNaN(v)) continue;
      this.avg[i] = Number.isNaN(this.avg[i]) ? v : alpha * this.avg[i] + (1 - alpha) * v;
      if (!(this.max[i] >= v)) this.max[i] = v;
      this.activity[i] += a * ((seen[i] > thr ? 1 : 0) - this.activity[i]);
    }
    return { cur, floor };
  }
  // Consensus of per-window max-holds: catches bursty signals over many sweeps.
  heldConsensus() {
    return this.combine(this.hold);
  }
}

function median(arr) {
  const v = Array.from(arr).filter((x) => !Number.isNaN(x));
  if (!v.length) return NaN;
  v.sort((a, b) => a - b);
  return v[v.length >> 1];
}

// Local maxima at least `thresholdDb` above the median floor, `minSepHz`
// apart, strongest first. values: linear power; returns frequency, level and
// -6 dB width.
function findPeaks(values, startHz, resHz, { thresholdDb = 10, minSepHz = 200e3, max = 40 } = {}) {
  const floor = median(values),
    thr = floor * 10 ** (thresholdDb / 10),
    cand = [];
  for (let i = 1; i < values.length - 1; i++) {
    const v = values[i];
    if (!(v > thr) || !(v >= values[i - 1]) || !(v > values[i + 1])) continue;
    cand.push(i);
  }
  cand.sort((a, b) => values[b] - values[a]);
  const out = [];
  // A wide signal (an LTE carrier, a Wi-Fi channel) has many local maxima:
  // each accepted peak claims its whole region above the detection threshold,
  // and later candidates inside a claimed region are part of that signal.
  for (const i of cand) {
    const f = startHz + i * resHz;
    if (out.some((p) => (i >= p.lo && i <= p.hi) || Math.abs(p.hz - f) < minSepHz)) continue;
    let lo = i,
      hi = i;
    while (lo > 0 && values[lo - 1] > thr) lo--;
    while (hi < values.length - 1 && values[hi + 1] > thr) hi++;
    // Occupied width: the span holding 99 % of the region's power.
    let total = 0;
    for (let k = lo; k <= hi; k++) total += values[k];
    let acc = 0,
      a = lo,
      b = hi;
    for (let k = lo; k <= hi; k++) if ((acc += values[k]) >= 0.005 * total) {
      a = k;
      break;
    }
    acc = 0;
    for (let k = hi; k >= lo; k--) if ((acc += values[k]) >= 0.005 * total) {
      b = k;
      break;
    }
    out.push({
      hz: startHz + ((a + b) / 2) * resHz,
      peakHz: f,
      db: 10 * Math.log10(values[i]),
      snr: 10 * Math.log10(values[i] / floor),
      widthHz: (b - a + 1) * resHz,
      index: i,
      lo,
      hi,
    });
    if (out.length >= max) break;
  }
  return out;
}

// Crystal-coherent chip spurs: the band plan's measured lines, plus narrow,
// always-on lines on an 8 MHz grid (the common divisor of the S3's 40 and
// 48 MHz clock families). Returns a reason string or ''.
function spurReason(peak, activity, family, userSpurs = []) {
  const mhz = peak.hz / 1e6;
  for (const s of (typeof CHIP_SPURS !== 'undefined' && CHIP_SPURS[family]) || [])
    if (Math.abs(mhz - s.mhz) < 0.05) return s.label;
  for (const u of userSpurs) if (Math.abs(mhz - u) < 0.05) return 'marked as spur';
  const grid = Math.abs(mhz / 8 - Math.round(mhz / 8)) * 8;
  if (grid < 0.03 && peak.widthHz <= 75e3 && activity > 0.9) return 'probable clock harmonic (8 MHz grid)';
  return '';
}
