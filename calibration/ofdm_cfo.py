"""CFO of 802.11 OFDM packets in recordings, from L-STF (coarse) then L-LTF (fine).

The STF plateau is located with the lag-0.8us autocorrelation; the LTF's two
3.2 us symbols follow 8 us after the STF start and refine CFO to +-156 kHz.
Only packets whose STF start lies inside the capture are used.
"""
import sys

import numpy as np


def ofdm_packets(iq_all, fs, min_width=14e6):
    L, LT = int(round(0.8e-6 * fs)), int(round(3.2e-6 * fs))
    out = []
    for ci, iq in enumerate(iq_all):
        iq = iq - iq.mean()
        p = np.convolve(np.abs(iq) ** 2, np.ones(int(fs / 1e6)) / (fs / 1e6), mode="same")
        pdb = 10 * np.log10(p + 1e-14)
        floor = np.percentile(pdb, 20)
        on = pdb > floor + 10
        e = np.flatnonzero(np.diff(np.r_[0, on.astype(np.int8), 0]))
        for a, b in zip(e[::2], e[1::2]):
            if a == 0 or b - a < int(20e-6 * fs):
                continue
            seg = iq[a:b]
            n = 512
            k = len(seg) // n
            spec = (np.abs(np.fft.fft(seg[: k * n].reshape(k, n) * np.hanning(n), axis=1)) ** 2).mean(0)
            sdb = np.fft.fftshift(10 * np.log10(spec + 1e-14))
            f = (np.arange(n) - n / 2) * fs / n
            sel = np.flatnonzero(sdb > sdb.max() - 10)
            if f[sel[-1]] - f[sel[0]] < min_width:
                continue
            s0 = max(0, a - int(2e-6 * fs))
            x = iq[s0:s0 + int(24e-6 * fs)]
            c = x[:-L] * np.conj(x[L:])
            win = 4 * L
            num = np.convolve(c, np.ones(win), "valid")
            den = np.convolve(np.abs(x[L:]) ** 2, np.ones(win), "valid")
            m = np.abs(num) / (den + 1e-12)
            if m[: int(6e-6 * fs)].max() < 0.9:
                continue
            k0 = int(np.argmax(m[: int(6e-6 * fs)]))
            coarse = -np.angle(num[k0]) * fs / (2 * np.pi * L)
            # Find STF end: metric falls below 0.5 after the plateau.
            plateau = np.flatnonzero(m[k0:] < 0.5)
            stf_end = k0 + (plateau[0] if len(plateau) else int(8e-6 * fs)) + win // 2
            t = np.arange(len(x)) / fs
            y = x * np.exp(-2j * np.pi * coarse * t)
            g = stf_end + int(1.6e-6 * fs)  # skip the LTF's 1.6 us guard
            if g + 2 * LT > len(y):
                continue
            fine = -np.angle(np.sum(y[g:g + LT] * np.conj(y[g + LT:g + 2 * LT]))) * fs / (2 * np.pi * LT)
            out.append(dict(cap=ci, start_us=a / fs * 1e6, stf_metric=float(m[k0]), coarse_hz=float(coarse),
                            cfo_hz=float(coarse + fine), snr_db=float(pdb[a:b].mean() - floor),
                            power_dbfs=float(10 * np.log10(np.mean(np.abs(seg) ** 2)))))
    return out


if __name__ == "__main__":
    for path in sys.argv[1:]:
        d = np.load(path)
        pk = ofdm_packets(d["iq"], float(d["rate"]))
        print(f"{path}: {len(pk)} OFDM preambles")
        for r in pk:
            print(f"  cap {r['cap']:3d} t={r['start_us']:6.1f}us stf={r['stf_metric']:.3f} coarse {r['coarse_hz']/1e3:+7.1f} "
                  f"-> CFO {r['cfo_hz']/1e3:+7.1f} kHz  snr {r['snr_db']:.1f} dB  {r['power_dbfs']:.1f} dBFS")
