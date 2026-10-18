'use strict';
// Host-side DSP for the continuous I/Q page: windowed-sinc FIR design, a
// decimating channel filter and AM/FM/SSB/CW demodulators. Pure functions and
// classes so tests can exercise them without a browser.

// Low-pass FIR taps (Blackman-windowed sinc), cutoff in cycles/sample, unity DC gain.
function lowpassTaps(cutoff, n) {
  n |= 1;
  const m = (n - 1) / 2,
    taps = new Float32Array(n);
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const x = k - m,
      sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x),
      w = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (n - 1));
    taps[k] = sinc * w;
    sum += taps[k];
  }
  for (let k = 0; k < n; k++) taps[k] /= sum;
  return taps;
}

// Audio-path decimation so the demodulator runs near (but not below) the
// rate the channel needs; Chrome accepts AudioContext rates from 3 to 768 kHz.
function demodDecimation(rate, bandwidth) {
  const need = Math.max(2.4 * bandwidth, 16000);
  return Math.max(1, Math.floor(rate / need));
}

const DEMOD_DEFAULTS = {
  AM: { bandwidth: 10000 },
  NFM: { bandwidth: 12500 },
  WFM: { bandwidth: 180000 },
  USB: { bandwidth: 2800 },
  LSB: { bandwidth: 2800 },
  CW: { bandwidth: 500 },
  RAW: { bandwidth: 20000 },
};

class Demodulator {
  // mode: AM | NFM | WFM | USB | LSB | CW | RAW (I as audio, for testing).
  constructor(rate, { mode = 'NFM', offset = 0, bandwidth, squelch = -200, cwPitch = 700 } = {}) {
    this.rate = rate;
    this.mode = mode;
    this.offset = offset;
    this.bandwidth = Math.min(bandwidth ?? DEMOD_DEFAULTS[mode].bandwidth, rate * 0.9);
    this.squelch = squelch;
    this.cwPitch = cwPitch;
    this.decimation = demodDecimation(rate, this.bandwidth);
    this.audioRate = rate / this.decimation;
    // SSB/CW: put the wanted sideband's centre at 0 Hz before filtering, then
    // move it back to audio after decimation.
    const half = this.bandwidth / 2;
    this.preShift = mode === 'USB' ? half : mode === 'LSB' ? -half : 0;
    this.postShift = mode === 'USB' ? half : mode === 'LSB' ? -half : mode === 'CW' ? cwPitch : 0;
    const n = Math.min(511, Math.max(31, Math.round((6 * rate) / Math.max(this.bandwidth, 1))));
    this.taps = lowpassTaps(Math.min(0.49, half / rate), n);
    this.histI = new Float32Array(this.taps.length);
    this.histQ = new Float32Array(this.taps.length);
    this.pos = 0;
    this.phase = 0;
    this.post = 0;
    this.skip = 0;
    this.prevI = 1;
    this.prevQ = 0;
    this.dc = 0;
    this.agc = 1e-3;
    this.level = -200; // channel power, dBFS
  }
  // iq: interleaved float I/Q at this.rate. Returns audio at this.audioRate.
  process(iq) {
    const taps = this.taps,
      L = taps.length,
      hi = this.histI,
      hq = this.histQ,
      D = this.decimation,
      step = (-2 * Math.PI * (this.offset + this.preShift)) / this.rate,
      postStep = (2 * Math.PI * this.postShift) / this.audioRate,
      out = new Float32Array(Math.ceil(iq.length / 2 / D) + 1);
    let n = 0,
      power = 0,
      count = 0;
    for (let j = 0; j < iq.length; j += 2) {
      const c = Math.cos(this.phase),
        s = Math.sin(this.phase);
      this.phase += step;
      if (this.phase > Math.PI) this.phase -= 2 * Math.PI;
      else if (this.phase < -Math.PI) this.phase += 2 * Math.PI;
      hi[this.pos] = iq[j] * c - iq[j + 1] * s;
      hq[this.pos] = iq[j] * s + iq[j + 1] * c;
      this.pos = (this.pos + 1) % L;
      if (++this.skip < D) continue;
      this.skip = 0;
      // Polyphase-free decimation: evaluate the FIR only for kept outputs.
      let yi = 0,
        yq = 0;
      for (let k = 0, p = this.pos; k < L; k++) {
        yi += taps[k] * hi[p];
        yq += taps[k] * hq[p];
        if (++p === L) p = 0;
      }
      power += yi * yi + yq * yq;
      count++;
      out[n++] = this.demod(yi, yq, postStep);
    }
    if (count) this.level = 10 * Math.log10(power / count + 1e-20);
    const audio = out.subarray(0, n);
    if (this.level < this.squelch) audio.fill(0);
    return audio;
  }
  demod(yi, yq, postStep) {
    let v;
    switch (this.mode) {
      case 'AM':
        v = Math.hypot(yi, yq);
        this.dc += 0.001 * (v - this.dc);
        v -= this.dc;
        break;
      case 'NFM':
      case 'WFM': {
        // Discriminator: angle of y[n] conj(y[n-1]), scaled so peak deviation
        // (half the channel bandwidth) reaches about full scale.
        const re = yi * this.prevI + yq * this.prevQ,
          im = yq * this.prevI - yi * this.prevQ;
        this.prevI = yi;
        this.prevQ = yq;
        return (Math.atan2(im, re) * this.audioRate) / (Math.PI * this.bandwidth);
      }
      case 'USB':
      case 'LSB':
      case 'CW': {
        const c = Math.cos(this.post),
          s = Math.sin(this.post);
        this.post += postStep;
        if (this.post > Math.PI) this.post -= 2 * Math.PI;
        else if (this.post < -Math.PI) this.post += 2 * Math.PI;
        v = yi * c - yq * s;
        break;
      }
      default:
        v = yi;
    }
    // Peak-following AGC for amplitude modes: fast attack, slow release.
    const a = Math.abs(v);
    this.agc = a > this.agc ? this.agc + 0.05 * (a - this.agc) : this.agc * 0.99995;
    return (0.5 * v) / Math.max(this.agc, 1e-6);
  }
}

// Peak search with parabolic interpolation on dB values: fractional bin index.
function interpolatePeak(values, i) {
  if (i <= 0 || i >= values.length - 1) return i;
  const a = values[i - 1],
    b = values[i],
    c = values[i + 1],
    d = a - 2 * b + c;
  return d ? i + (0.5 * (a - c)) / d : i;
}

// SigMF metadata for a complex float32 little-endian recording.
function sigmfMeta({ rate, centerHz, datetime, description = '', gain = '' }) {
  return {
    global: {
      'core:datatype': 'cf32_le',
      'core:sample_rate': rate,
      'core:version': '1.0.0',
      'core:hw': 'ESP32-S3 (ESP-SDR IQS stream)',
      'core:recorder': 'ESP-WebSDR zoom',
      'core:description': description,
    },
    captures: [{ 'core:sample_start': 0, 'core:frequency': centerHz, 'core:datetime': datetime }],
    annotations: gain ? [{ 'core:sample_start': 0, 'core:comment': `gain ${gain}` }] : [],
  };
}
