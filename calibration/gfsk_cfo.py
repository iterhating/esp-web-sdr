"""Precise carrier offsets of narrowband GFSK bursts (Bluetooth Classic / BLE).

Each burst is mixed down by its coarse integer-MHz channel, low-pass filtered
to +-700 kHz, and the mean of the FM discriminator over the burst gives the
carrier offset (whitened GFSK payloads are close to zero-mean).
"""
import sys

import numpy as np
from scipy.signal import firwin, lfilter

TAPS = None


def burst_cfos(iq_all, fs, lo_mhz, min_us=20, snr_db=15):
    global TAPS
    if TAPS is None or TAPS[0] != fs:
        TAPS = (fs, firwin(129, 700e3, fs=fs))
    taps = TAPS[1]
    out = []
    t = np.arange(iq_all.shape[1]) / fs
    for ci, iq in enumerate(iq_all):
        iq = iq - iq.mean()
        p = np.convolve(np.abs(iq) ** 2, np.ones(int(fs / 1e6)) / (fs / 1e6), mode="same")
        pdb = 10 * np.log10(p + 1e-14)
        floor = np.percentile(pdb, 20)
        on = pdb > floor + snr_db
        e = np.flatnonzero(np.diff(np.r_[0, on.astype(np.int8), 0]))
        for a, b in zip(e[::2], e[1::2]):
            if b - a < fs * min_us * 1e-6:
                continue
            seg = iq[a:b]
            n = 1 << int(np.ceil(np.log2(max(len(seg), 4096))))
            spec = np.abs(np.fft.fft(seg * np.hanning(len(seg)), n)) ** 2
            f = np.fft.fftfreq(n, 1 / fs)
            # Occupied width check: GFSK bursts fit in ~1.5 MHz.
            sdb = 10 * np.log10(spec + 1e-14)
            sel = sdb > sdb.max() - 10
            width = f[sel].max() - f[sel].min()
            if width > 2e6:
                continue
            coarse = np.sum(f * spec) / np.sum(spec)
            ch_mhz = int(round(lo_mhz + coarse / 1e6))
            mix = seg * np.exp(-2j * np.pi * (ch_mhz - lo_mhz) * 1e6 * t[a:b])
            y = lfilter(taps, 1, mix)[len(taps):]
            if len(y) < 64:
                continue
            ph = np.angle(y[1:] * np.conj(y[:-1]))
            inst = ph * fs / (2 * np.pi)
            dev = np.percentile(np.abs(inst - np.median(inst)), 90)
            out.append(dict(cap=ci, ch_mhz=ch_mhz, cfo_hz=float(np.mean(inst)), median_hz=float(np.median(inst)),
                            dev_hz=float(dev), dur_us=(b - a) / fs * 1e6, snr_db=float(pdb[a:b].mean() - floor),
                            start_us=a / fs * 1e6))
    return out


if __name__ == "__main__":
    allrows = []
    for path in sys.argv[1:]:
        d = np.load(path)
        rows = burst_cfos(d["iq"], float(d["rate"]), int(d["freq"]))
        for r in rows:
            r["lo"] = int(d["freq"])
        allrows += rows
    cfo = np.array([r["cfo_hz"] for r in allrows])
    print(f"{len(allrows)} GFSK bursts")
    for r in sorted(allrows, key=lambda r: r["cfo_hz"]):
        print(f" LO {r['lo']} ch {r['ch_mhz']} cfo {r['cfo_hz']/1e3:+7.1f} kHz (median {r['median_hz']/1e3:+7.1f}) "
              f"dev90 {r['dev_hz']/1e3:5.0f} kHz dur {r['dur_us']:6.1f} us snr {r['snr_db']:4.1f} dB")
    print("CFO kHz percentiles 10/50/90:", np.percentile(cfo, [10, 50, 90]).round(-2) / 1e3)
