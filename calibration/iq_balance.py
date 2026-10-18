"""Blind I/Q imbalance estimate and image-rejection check.

Receiver noise is circular, so E[z^2] ~ 0 for a balanced receiver. The
correction  z' = z + w * conj(z)  with  w = -E[z^2] / (E[|z|^2] + |E[|z|^2]|)
(Anttila-style one-tap compensator, solved in closed form) drives E[z'^2]
to zero. Verified on a CW line: image level at -f before and after.

usage: iq_balance.py RECORDING.npz LINE_MHZ
"""
import json
import sys

import numpy as np


def estimate_w(iq_all):
    z = iq_all - iq_all.mean(axis=1, keepdims=True)
    c = np.mean(z * z)
    p = np.mean(np.abs(z) ** 2)
    # Solve E[(z + w z*)^2] = 0  ->  c + 2 w p + w^2 conj(c) = 0, small-root.
    disc = np.sqrt(p * p - np.abs(c) ** 2)
    return -c / (p + disc)


def image_rejection(iq_all, fs, lo_mhz, line_mhz, w=0.0):
    nfft = 16384
    win = np.blackman(iq_all.shape[1])
    acc = np.zeros(nfft)
    for z in iq_all:
        z = z - z.mean()
        z = z + w * np.conj(z)
        acc += np.abs(np.fft.fftshift(np.fft.fft(z * win, nfft))) ** 2
    p = 10 * np.log10(acc + 1e-14)
    f = (np.arange(nfft) - nfft // 2) * fs / nfft
    off = (line_mhz - lo_mhz) * 1e6
    k = np.argmin(np.abs(f - off))
    k = k - 3 + np.argmax(p[k - 3:k + 4])
    ki = np.argmin(np.abs(f + f[k]))
    ki = ki - 3 + np.argmax(p[ki - 3:ki + 4])
    floor = np.median(p)
    return float(p[k] - p[ki]), float(p[ki] - floor)


if __name__ == "__main__":
    d = np.load(sys.argv[1])
    line = float(sys.argv[2])
    iq, fs, lo = d["iq"], float(d["rate"]), int(d["freq"])
    z = iq - iq.mean(axis=1, keepdims=True)
    i, q = z.real, z.imag
    gain_db = 10 * np.log10(np.mean(q ** 2) / np.mean(i ** 2))
    phase_deg = np.degrees(np.arcsin(np.mean(i * q) / np.sqrt(np.mean(i ** 2) * np.mean(q ** 2))))
    dc = iq.mean()
    w = estimate_w(iq)
    before, img_snr_before = image_rejection(iq, fs, lo, line)
    after, img_snr_after = image_rejection(iq, fs, lo, line, w)
    print(f"DC offset {dc.real:+.4f}{dc.imag:+.4f}j FS ({20*np.log10(abs(dc)+1e-12):.1f} dBFS)")
    print(f"gain imbalance {gain_db:+.3f} dB, phase skew {phase_deg:+.3f} deg, w = {w.real:+.5f}{w.imag:+.5f}j")
    print(f"image rejection on {line} MHz line: {before:.1f} dB -> {after:.1f} dB "
          f"(image {img_snr_before:.1f} -> {img_snr_after:.1f} dB above floor)")
    json.dump(dict(lo=lo, rate=fs, gain_db=float(gain_db), phase_deg=float(phase_deg), w=[float(w.real), float(w.imag)],
                   dc=[float(dc.real), float(dc.imag)], irr_before=before, irr_after=after),
              open(sys.argv[1].replace(".npz", "_iq.json"), "w"), indent=1)
