"""Print burst statistics from a recording to tune the packet detectors."""
import sys

import numpy as np

d = np.load(sys.argv[1])
iq_all, fs = d["iq"], float(d["rate"])
L = int(round(0.8e-6 * fs))
rows = []
for ci, iq in enumerate(iq_all):
    iq = iq - iq.mean()
    p = np.convolve(np.abs(iq) ** 2, np.ones(int(fs / 1e6)) / (fs / 1e6), mode="same")
    pdb = 10 * np.log10(p + 1e-14)
    floor = np.percentile(pdb, 20)
    on = pdb > floor + 10
    e = np.flatnonzero(np.diff(np.r_[0, on.astype(np.int8), 0]))
    for a, b in zip(e[::2], e[1::2]):
        if b - a < fs * 4e-6:
            continue
        seg = iq[a:b]
        n = 512
        k = max(1, len(seg) // n)
        spec = (np.abs(np.fft.fft(seg[: k * n].reshape(k, n) * np.hanning(n), axis=1)) ** 2).mean(0) if len(seg) >= n else \
            np.abs(np.fft.fft(seg * np.hanning(len(seg)), n)) ** 2
        sdb = np.fft.fftshift(10 * np.log10(spec + 1e-14))
        f = (np.arange(n) - n / 2) * fs / n
        sel = np.flatnonzero(sdb > sdb.max() - 10)
        width = f[sel[-1]] - f[sel[0]]
        center = (f[sel[-1]] + f[sel[0]]) / 2
        x = seg[: min(len(seg), 2000)]
        a1 = x[:-L] * np.conj(x[L:])
        win = 4 * L
        num = np.convolve(a1, np.ones(win), "valid")
        den = np.convolve(np.abs(x[L:]) ** 2, np.ones(win), "valid")
        m = np.abs(num) / (den + 1e-12)
        rows.append((ci, a / fs * 1e6, (b - a) / fs * 1e6, center / 1e6, width / 1e6,
                     pdb[a:b].mean() - floor, m[: int(fs * 20e-6)].max() if len(m) else 0, a == 0, b == len(iq)))
r = np.array(rows, dtype=float)
print(f"{len(iq_all)} captures, {len(r)} bursts >=4us; {int(r[:,7].sum())} start at capture start, {int(r[:,8].sum())} run to end")
print("dur_us   pct:", np.percentile(r[:, 2], [10, 50, 90]).round(1))
print("width_MHz pct:", np.percentile(r[:, 4], [10, 50, 90]).round(2))
print("center_MHz pct:", np.percentile(r[:, 3], [10, 50, 90]).round(2))
print("SNR pct:", np.percentile(r[:, 5], [10, 50, 90]).round(1))
print("STF metric pct:", np.percentile(r[:, 6], [10, 50, 90, 99]).round(3))
hist, edges = np.histogram(r[:, 4], bins=[0, 1.5, 3, 6, 10, 14, 18, 22, 40])
print("width histogram:", dict(zip([f"{edges[i]}-{edges[i+1]}" for i in range(len(hist))], hist.tolist())))
for row in r[np.argsort(-r[:, 5])][:15]:
    print(" cap %3d t=%6.1fus dur=%6.1fus c=%+6.2fMHz w=%5.2fMHz snr=%5.1fdB stf=%.3f" % tuple(row[:7]))
