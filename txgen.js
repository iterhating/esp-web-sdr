'use strict';
// Transmit waveform synthesis for the ESP-SDR fork's REPLAY16/LOOP16/TX16 path.
// Every generator returns { iq, n, rate, actualHz } where iq is an Int8Array of
// 2*n interleaved signed bytes (I then Q), the format the firmware expects: one
// payload is uploaded once and the modem repeats it, so each waveform is built
// to wrap continuously at the loop boundary.
//
// Offsets are snapped to a multiple of rate/n (an integer number of cycles
// across the buffer) so a looped tone has no phase jump. Amplitude is a
// fraction of full scale; keep headroom below 1 to avoid hard clipping.

function clampByte(x) {
  return x < -127 ? -127 : x > 127 ? 127 : Math.round(x);
}

// Pack interleaved float I/Q (|.|<=1) into the signed-8-bit payload.
function packIQ(re, im) {
  const n = re.length,
    iq = new Int8Array(2 * n);
  for (let k = 0; k < n; k++) {
    iq[2 * k] = clampByte(re[k] * 127);
    iq[2 * k + 1] = clampByte(im[k] * 127);
  }
  return iq;
}

// Snap an offset to an integer number of cycles over n samples at `rate`.
function snapHz(offsetHz, rate, n) {
  return Math.round((offsetHz * n) / rate) * (rate / n);
}

function toneWaveform(rate, n, offsetHz = 0, amp = 0.8) {
  const f = snapHz(offsetHz, rate, n),
    re = new Float64Array(n),
    im = new Float64Array(n),
    w = (2 * Math.PI * f) / rate;
  for (let k = 0; k < n; k++) {
    re[k] = amp * Math.cos(w * k);
    im[k] = amp * Math.sin(w * k);
  }
  return { iq: packIQ(re, im), n, rate, actualHz: f };
}

function twoToneWaveform(rate, n, f1 = -1e6, f2 = 1e6, amp = 0.45) {
  const a = snapHz(f1, rate, n),
    b = snapHz(f2, rate, n),
    re = new Float64Array(n),
    im = new Float64Array(n),
    wa = (2 * Math.PI * a) / rate,
    wb = (2 * Math.PI * b) / rate;
  for (let k = 0; k < n; k++) {
    re[k] = amp * (Math.cos(wa * k) + Math.cos(wb * k));
    im[k] = amp * (Math.sin(wa * k) + Math.sin(wb * k));
  }
  return { iq: packIQ(re, im), n, rate, actualHz: [a, b] };
}

// Linear FM sweep over +-bw/2. A triangle (up then down) keeps instantaneous
// frequency continuous across the loop boundary.
function chirpWaveform(rate, n, bwHz = 10e6, amp = 0.8) {
  const re = new Float64Array(n),
    im = new Float64Array(n),
    half = n >> 1;
  let phase = 0;
  for (let k = 0; k < n; k++) {
    const frac = k < half ? k / half : (n - k) / half, // 0..1..0
      f = (frac - 0.5) * bwHz;
    phase += (2 * Math.PI * f) / rate;
    re[k] = amp * Math.cos(phase);
    im[k] = amp * Math.sin(phase);
  }
  return { iq: packIQ(re, im), n, rate, actualHz: bwHz };
}

// Band-limited complex Gaussian noise: white noise shaped by a brick-wall mask
// in the frequency domain, so its occupied bandwidth is controlled and it wraps.
// n must be a power of two (uses an FFT); the other generators accept any n.
function noiseWaveform(rate, n, bwHz = 20e6, amp = 0.5, rng = Math.random) {
  const re = new Float64Array(n),
    im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    // Box-Muller for Gaussian samples.
    const u = Math.max(1e-12, rng()),
      v = rng();
    const r = Math.sqrt(-2 * Math.log(u));
    re[k] = r * Math.cos(2 * Math.PI * v);
    im[k] = r * Math.sin(2 * Math.PI * v);
  }
  fft(re, im);
  const keep = Math.min(n, Math.round((bwHz * n) / rate));
  for (let k = 0; k < n; k++) {
    const f = k <= n / 2 ? k : k - n;
    if (Math.abs(f) > keep / 2) {
      re[k] = 0;
      im[k] = 0;
    }
  }
  ifft(re, im);
  let peak = 1e-9;
  for (let k = 0; k < n; k++) peak = Math.max(peak, Math.abs(re[k]), Math.abs(im[k]));
  const g = amp / peak;
  for (let k = 0; k < n; k++) {
    re[k] *= g;
    im[k] *= g;
  }
  return { iq: packIQ(re, im), n, rate, actualHz: (keep * rate) / n };
}

// Root-raised-cosine QPSK with random symbols. Symbol count divides evenly into
// n so the symbol stream wraps; shaping is circular for a clean loop.
function qpskWaveform(rate, n, symRateHz = 1e6, rolloff = 0.35, amp = 0.7, rng = Math.random) {
  const sps = Math.max(2, Math.round(rate / symRateHz)),
    syms = Math.floor(n / sps),
    actualSym = rate / sps;
  const si = new Float64Array(syms),
    sq = new Float64Array(syms),
    c = Math.SQRT1_2;
  for (let s = 0; s < syms; s++) {
    si[s] = rng() < 0.5 ? c : -c;
    sq[s] = rng() < 0.5 ? c : -c;
  }
  // RRC taps spanning +-span symbols.
  const span = 6,
    taps = rrc(rolloff, sps, span);
  const len = syms * sps,
    re = new Float64Array(len),
    im = new Float64Array(len);
  for (let s = 0; s < syms; s++) {
    const base = s * sps;
    for (let t = -span * sps; t <= span * sps; t++) {
      const idx = ((base + t) % len + len) % len,
        h = taps[t + span * sps];
      re[idx] += si[s] * h;
      im[idx] += sq[s] * h;
    }
  }
  let peak = 1e-9;
  for (let k = 0; k < len; k++) peak = Math.max(peak, Math.abs(re[k]), Math.abs(im[k]));
  const g = amp / peak,
    rf = new Float64Array(len),
    imf = new Float64Array(len);
  for (let k = 0; k < len; k++) {
    rf[k] = re[k] * g;
    imf[k] = im[k] * g;
  }
  return { iq: packIQ(rf, imf), n: len, rate, actualHz: actualSym };
}

function rrc(beta, sps, span) {
  const n = 2 * span * sps + 1,
    taps = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i - span * sps) / sps;
    let h;
    if (Math.abs(t) < 1e-8) h = 1 - beta + (4 * beta) / Math.PI;
    else if (Math.abs(Math.abs(4 * beta * t) - 1) < 1e-8)
      h = (beta / Math.SQRT2) * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * beta)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * beta)));
    else
      h = (Math.sin(Math.PI * t * (1 - beta)) + 4 * beta * t * Math.cos(Math.PI * t * (1 + beta))) /
        (Math.PI * t * (1 - (4 * beta * t) ** 2));
    taps[i] = h;
  }
  return taps;
}

// Inverse FFT via the forward FFT in radio.js (conjugate, transform, scale).
function ifft(re, im) {
  const n = re.length;
  for (let k = 0; k < n; k++) im[k] = -im[k];
  fft(re, im);
  for (let k = 0; k < n; k++) {
    re[k] /= n;
    im[k] = -im[k] / n;
  }
}

// crc32 of the payload bytes, as the firmware's zlib.crc32 expects.
function payloadCrc(iq) {
  return crc32(new Uint8Array(iq.buffer, iq.byteOffset, iq.byteLength));
}
