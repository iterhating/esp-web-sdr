"""Detect 802.11 packets per 2.4 GHz channel and measure carrier frequency offset.

OFDM (11g/n): L-STF repeats every 0.8 us, so the lag-32 autocorrelation at
40 MS/s is near 1 across the preamble and its angle gives CFO (+-625 kHz).
DSSS (11b): the DBPSK preamble's square has a spectral line at 2*CFO.
A transmitter's CFO is a stable fingerprint, and the median CFO across many
independent transmitters estimates the ESP's own LO error.
"""
import json
import sys

import numpy as np

from espsdr import ESPSDR

port = sys.argv[1] if len(sys.argv) > 1 else "COM17"
captures = int(sys.argv[2]) if len(sys.argv) > 2 else 120
gain = int(sys.argv[3]) if len(sys.argv) > 3 else 54
FS = 40e6
L = 32  # STF period at 40 MS/s


def bursts(iq, floor_db, min_len=400):
    """Return (start, stop) of segments whose 1 us power exceeds floor+12 dB."""
    p = np.convolve(np.abs(iq) ** 2, np.ones(40) / 40, mode="same")
    on = 10 * np.log10(p + 1e-14) > floor_db + 12
    edges = np.flatnonzero(np.diff(np.r_[0, on.astype(np.int8), 0]))
    return [(a, b) for a, b in zip(edges[::2], edges[1::2]) if b - a >= min_len]


def occupied(seg):
    n = 1024
    spec = np.fft.fftshift(np.abs(np.fft.fft(seg[: len(seg) // n * n].reshape(-1, n) * np.hanning(n), axis=1)) ** 2).mean(0) \
        if len(seg) >= n else np.fft.fftshift(np.abs(np.fft.fft(seg * np.hanning(len(seg)), n)) ** 2)
    sdb = 10 * np.log10(spec + 1e-14)
    f = (np.arange(n) - n / 2) * FS / n
    top = np.percentile(sdb, 98)
    sel = np.flatnonzero(sdb > top - 10)
    return float((f[sel[0]] + f[sel[-1]]) / 2), float(f[sel[-1]] - f[sel[0]])


def ofdm_cfo(seg):
    a = seg[:-L] * np.conj(seg[L:])
    win = 128
    num = np.convolve(a, np.ones(win), mode="valid")
    den = np.convolve(np.abs(seg[L:]) ** 2, np.ones(win), mode="valid")
    metric = np.abs(num) / (den + 1e-12)
    k = int(np.argmax(metric[: min(len(metric), 600)]))
    # x[n] * conj(x[n+L]) = exp(-j 2 pi f L / fs)
    return float(metric[k]), float(-np.angle(num[k]) * FS / (2 * np.pi * L))


def dsss_cfo(seg):
    sq = seg[:4096] ** 2 if len(seg) >= 4096 else seg ** 2
    n = 1 << 16
    s = np.abs(np.fft.fft(sq * np.hanning(len(sq)), n))
    f = np.fft.fftfreq(n, 1 / FS)
    band = np.abs(f) < 600e3
    k = np.flatnonzero(band)[np.argmax(s[band])]
    return float(s[k] / np.median(s[band])), float(f[k] / 2)


sdr = ESPSDR(port)
sdr.set_gain(gain)
packets = []
for ch in range(1, 14):
    fc = 2407 + 5 * ch
    sdr.tune(fc, 35)
    n_ofdm = n_dsss = 0
    for _ in range(captures):
        iq = sdr.capture(rate=FS, bits=10)
        iq = iq - iq.mean()
        floor = 10 * np.log10(np.percentile(np.abs(iq) ** 2, 30) + 1e-14)
        for a, b in bursts(iq, floor):
            seg = iq[a:b]
            center, width = occupied(seg)
            pwr = 10 * np.log10(np.mean(np.abs(seg) ** 2) + 1e-14)
            rec = dict(ch=ch, fc=fc, start_us=a / 40, dur_us=(b - a) / 40, center_khz=center / 1e3,
                       width_mhz=width / 1e6, power_dbfs=pwr, clipped=bool(np.max(np.abs(seg.real)) > 0.99))
            m, cfo = ofdm_cfo(seg)
            if m > 0.85 and 13e6 < width < 21e6 and abs(center) < 2e6 and a > 0:
                rec.update(kind="ofdm", metric=m, cfo_hz=cfo)
                n_ofdm += 1
            elif 8e6 < width < 24e6 and abs(center) < 2e6:
                q, cfo = dsss_cfo(seg)
                if q > 30:
                    rec.update(kind="dsss", metric=q, cfo_hz=cfo)
                    n_dsss += 1
                else:
                    rec.update(kind="wide?")
            else:
                rec.update(kind="narrow" if width < 3e6 else "other")
            packets.append(rec)
    print(f"ch{ch:2d} {fc}: OFDM preambles {n_ofdm:3d}  DSSS {n_dsss:3d}", flush=True)
sdr.tune(2442, 0)
sdr.set_gain(None)
json.dump(dict(gain=gain, captures=captures, packets=packets), open("wifi_scan.json", "w"))
