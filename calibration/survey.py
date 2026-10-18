"""Band survey of 2.4 GHz ISM: per-MHz occupancy, mean and max-hold power.

Steps 40 MS/s windows across 2392-2492 MHz at fixed manual gain, keeping only
the inner +-15 MHz of each window where the filter (BANDWIDTH 35) is flat.
"""
import json
import sys
import time

import numpy as np

from espsdr import ESPSDR, psd

port = sys.argv[1] if len(sys.argv) > 1 else "COM17"
captures = int(sys.argv[2]) if len(sys.argv) > 2 else 150
gain = int(sys.argv[3]) if len(sys.argv) > 3 else 54
rate, nfft = 40e6, 256  # 156.25 kHz bins; 16380 samples -> 127 FFT frames per capture
sdr = ESPSDR(port)
sdr.set_gain(gain)
f_rel = (np.arange(nfft) - nfft // 2) * rate / nfft / 1e6
keep = np.abs(f_rel) <= 15
centers = list(range(2400, 2490, 15))  # windows overlap by 15 MHz at the edges kept

bins, mean_p, max_p, frames_all = [], [], [], []
for c in centers:
    sdr.tune(c, 35)
    frame_psds = []
    t0 = time.time()
    for _ in range(captures):
        iq = sdr.capture(rate=rate, bits=10)
        iq = iq - iq.mean()
        w = np.hanning(nfft)
        fr = iq[: len(iq) // nfft * nfft].reshape(-1, nfft) * w
        frame_psds.append(np.abs(np.fft.fftshift(np.fft.fft(fr, axis=1), axes=1)) ** 2 / w.sum() ** 2)
    fp = 10 * np.log10(np.maximum(np.concatenate(frame_psds), 1e-14))[:, keep]
    frames_all.append(fp)
    bins.append(c + f_rel[keep])
    print(f"{c} MHz: {fp.shape[0]} frames in {time.time()-t0:.1f}s", flush=True)
sdr.tune(2442, 0)
sdr.set_gain(None)

bins = np.concatenate(bins)
order = np.argsort(bins)
# Merge overlapping bins: each frequency appears in at most two windows.
mhz = np.arange(2385, 2500)
floor = np.median(np.concatenate([np.median(f, 0) for f in frames_all]))
result = []
for m in mhz:
    cols = []
    for b, fp in zip(np.split(bins, np.cumsum([f.shape[1] for f in frames_all])[:-1]), frames_all):
        sel = (b >= m - 0.5) & (b < m + 0.5)
        if sel.any():
            cols.append(fp[:, sel].max(axis=1))
    if not cols:
        continue
    v = np.concatenate(cols)
    result.append(dict(mhz=int(m), occupancy=float(np.mean(v > floor + 10)),
                       mean=float(10 * np.log10(np.mean(10 ** (v / 10)))),
                       p99=float(np.percentile(v, 99)), max=float(v.max())))
json.dump(dict(gain=gain, floor=float(floor), captures=captures, mhz=result), open("survey.json", "w"), indent=1)
print(f"floor {floor:.1f} dBFS/bin")
for r in result:
    bar = "#" * int(r["occupancy"] * 60)
    print(f"{r['mhz']} occ={r['occupancy']*100:5.1f}% p99={r['p99']:6.1f} max={r['max']:6.1f} {bar}")
