'use strict';
// Doppler extraction around a carrier in a complex baseband stream.
//
// methods:
//  notch     - a second-order PLL locks onto the carrier and moves it to 0 Hz;
//              a one-pole low-pass (trackHz) estimates the carrier and is
//              subtracted. What remains is the signed Doppler spectrum relative
//              to the carrier (approaching > 0, receding < 0).
//  lag       - z[n] conj(z[n-D]): the carrier becomes a constant, Doppler
//              terms appear at +-fd (sign is lost), immune to carrier drift.
//  envelope  - |z|^2 minus its mean: amplitude beating, unsigned.
// Output is complex at the input rate, with the carrier at 0 Hz.
// The PLL and the carrier estimate must be much slower than the slowest
// Doppler of interest, or they follow the beat and fold it to -fd.

class DopplerExtractor {
  constructor(rate, { method = 'notch', trackHz = 1, loopHz = 1, lagSamples = 1 } = {}) {
    this.rate = rate;
    this.method = method;
    this.lag = Math.max(1, lagSamples | 0);
    this.hist = new Float32Array(2 * this.lag);
    this.hp = 0;
    // PLL: critically damped loop, natural frequency ~ loopHz.
    const wn = (2 * Math.PI * loopHz) / rate;
    this.kp = 2 * 0.707 * wn;
    this.ki = wn * wn;
    this.theta = 0;
    this.omega = 0;
    this.a = 1 - Math.exp((-2 * Math.PI * trackHz) / rate);
    this.ci = 0;
    this.cq = 0;
    this.mean = 0;
    this.locked = 0;
  }
  // Seed the PLL with a known carrier offset (Hz) from the peak finder.
  seed(offsetHz) {
    this.omega = (2 * Math.PI * offsetHz) / this.rate;
  }
  get carrierHz() {
    return (this.omega * this.rate) / (2 * Math.PI);
  }
  process(iq) {
    const out = new Float32Array(iq.length);
    for (let j = 0; j < iq.length; j += 2) {
      let re = iq[j],
        im = iq[j + 1];
      if (this.method === 'notch') {
        const c = Math.cos(this.theta),
          s = Math.sin(this.theta),
          yr = re * c + im * s,
          yi = im * c - re * s;
        // Phase error weighted by amplitude keeps the loop quiet in deep fades.
        const err = Math.atan2(yi, yr),
          mag = Math.hypot(yr, yi);
        this.omega += this.ki * err;
        this.theta += this.omega + this.kp * err;
        if (this.theta > Math.PI) this.theta -= 2 * Math.PI;
        else if (this.theta < -Math.PI) this.theta += 2 * Math.PI;
        this.locked += 0.001 * (Math.abs(err) < 0.3 && mag > 0 ? 1 - this.locked : -this.locked);
        this.ci += this.a * (yr - this.ci);
        this.cq += this.a * (yi - this.cq);
        out[j] = yr - this.ci;
        out[j + 1] = yi - this.cq;
      } else if (this.method === 'lag') {
        const k = 2 * this.hp,
          dr = this.hist[k],
          di = this.hist[k + 1];
        this.hist[k] = re;
        this.hist[k + 1] = im;
        this.hp = (this.hp + 1) % this.lag;
        const pr = re * dr + im * di,
          pi = im * dr - re * di;
        this.ci += this.a * (pr - this.ci);
        this.cq += this.a * (pi - this.cq);
        out[j] = pr - this.ci;
        out[j + 1] = pi - this.cq;
      } else {
        const p = re * re + im * im;
        this.mean += this.a * (p - this.mean);
        out[j] = p - this.mean;
        out[j + 1] = 0;
      }
    }
    return out;
  }
}

// Doppler shift to radial speed: monostatic (out and back) halves the path.
function dopplerToSpeed(fdHz, carrierHz, monostatic = true) {
  return (fdHz * 299792458) / carrierHz / (monostatic ? 2 : 1);
}
