"""Sweep manual gain indices; record noise floor, peak, RMS and clipping per index."""
import json
import sys

import numpy as np

from espsdr import ESPSDR, psd

port = sys.argv[1] if len(sys.argv) > 1 else "COM17"
freq = int(sys.argv[2]) if len(sys.argv) > 2 else 2442
sdr = ESPSDR(port)
sdr.tune(freq)
rows = []
for g in range(0, 83, 2):
    sdr.set_gain(g)
    floors, peaks, rms, clip = [], [], [], []
    for _ in range(8):
        iq = sdr.capture(rate=40e6, bits=10)
        p = psd(iq, 512)
        floors.append(np.percentile(p, 20))
        peaks.append(p.max())
        rms.append(np.sqrt(np.mean(np.abs(iq) ** 2)))
        clip.append(np.mean((np.abs(iq.real) >= 511 / 512) | (np.abs(iq.imag) >= 511 / 512)))
    row = dict(gain=g, floor=float(np.median(floors)), peak=float(np.max(peaks)),
               rms=float(np.median(rms)), clip=float(np.max(clip)))
    rows.append(row)
    print(f"g={g:2d} floor={row['floor']:6.1f} peak={row['peak']:6.1f} dBFS rms={row['rms']:.4f} clip={row['clip']:.4f}")
sdr.set_gain(None)
json.dump(dict(freq=freq, rows=rows), open(f"gain_sweep_{freq}.json", "w"), indent=1)
