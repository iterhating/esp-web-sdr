"""Measure the analog filter's noise-shaped passband for each BANDWIDTH setting.

At thermal-limited gain the noise PSD follows the filter response; the median
over many captures rejects bursty traffic.
"""
import json
import sys

import numpy as np

from espsdr import ESPSDR, psd

port = sys.argv[1] if len(sys.argv) > 1 else "COM17"
freq = int(sys.argv[2]) if len(sys.argv) > 2 else 2442
gain = int(sys.argv[3]) if len(sys.argv) > 3 else 72
nfft = 512
rate = 80e6
sdr = ESPSDR(port)
sdr.set_gain(gain)
f = (np.arange(nfft) - nfft // 2) * rate / nfft / 1e6
out = {}
for bw in [13, 16, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 69, 0]:
    sdr.tune(freq, bw)
    spectra = np.array([psd(sdr.capture(rate=rate, bits=10), nfft) for _ in range(16)])
    shape = np.median(spectra, axis=0)
    # Reference: median level within +-3 MHz, excluding the DC bins.
    ref_mask = (np.abs(f) < 3) & (np.abs(f) > 0.4)
    ref = np.median(shape[ref_mask])
    rel = shape - ref
    edges = []
    for side in (1, -1):
        idx = np.where((side * f > 1) & (rel < -3))[0]
        edges.append(float(abs(f[idx[0] if side == 1 else idx[-1]])) if len(idx) else float("nan"))
    out[bw] = dict(edge_pos=edges[0], edge_neg=edges[1], ref=float(ref), shape=rel.tolist())
    print(f"BANDWIDTH {bw:2d}: -3 dB at +{edges[0]:5.1f} / -{edges[1]:5.1f} MHz  (in-band floor {ref:6.1f} dBFS)")
sdr.tune(freq, 0)
sdr.set_gain(None)
json.dump(dict(freq=freq, gain=gain, rate=rate, f_mhz=f.tolist(), settings=out), open("bandwidth_sweep.json", "w"))
