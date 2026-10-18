"""Frequency-hopping feasibility: catch rate, channel revisits and per-packet stability.

Finds narrowband (Bluetooth-like) bursts anywhere in wideband captures,
measures each one's RF channel, carrier offset (FM discriminator mean),
amplitude and amplitude flatness, then groups by transmitter (carrier-offset
cluster) and channel to see how often a (device, channel) pair is revisited
and how repeatable its amplitude is: the inputs a hop-based sensing scheme
would have to work with.

usage: fh_analyze.py RECORDING.npz
"""
import collections
import sys

import numpy as np
from scipy.signal import firwin, lfilter

d = np.load(sys.argv[1])
iq_all, fs, lo, stamps = d["iq"], float(d["rate"]), int(d["freq"]), d["t"]
NB = 128  # 625 kHz bins at 80 MS/s
taps = firwin(161, 600e3, fs=fs)
f_bins = (np.arange(NB) - NB // 2) * fs / NB
packets = []
for ci, iq in enumerate(iq_all):
    z = iq - iq.mean()
    frames = z[: len(z) // NB * NB].reshape(-1, NB) * np.hanning(NB)
    p = np.abs(np.fft.fftshift(np.fft.fft(frames, axis=1), axes=1)) ** 2
    mean = p.mean(0)
    floor = np.median(mean)
    for k in np.flatnonzero(mean > 30 * floor):
        if not (mean[k] >= mean[max(0, k - 1)] and mean[k] >= mean[min(NB - 1, k + 1)]):
            continue
        f_rf = lo * 1e6 + f_bins[k]
        ch = int(round((f_rf / 1e6) - 2402))
        if not 0 <= ch <= 78 or abs(lo + f_bins[k] / 1e6 - (2402 + ch)) > 0.45:
            continue
        t = np.arange(len(z)) / fs
        y = lfilter(taps, 1, z * np.exp(-2j * np.pi * ((2402 + ch) * 1e6 - lo * 1e6) * t))[len(taps):]
        env = np.abs(y)
        on = env > 0.5 * env.max()
        if on.sum() < fs * 20e-6:
            continue
        seg = y[on]
        inst = np.angle(seg[1:] * np.conj(seg[:-1])) * fs / (2 * np.pi)
        packets.append(dict(cap=ci, t=float(stamps[ci]), ch=ch, cfo=float(np.mean(inst)),
                            amp=float(np.sqrt(np.mean(env[on] ** 2))), flat=float(np.std(env[on]) / np.mean(env[on])),
                            dur_us=float(on.sum() / fs * 1e6)))

span = stamps[-1] - stamps[0]
caught = len({p["cap"] for p in packets})
print(f"{len(iq_all)} captures over {span:.1f} s ({len(iq_all)/span:.1f}/s), each {len(iq_all[0])/fs*1e6:.0f} us; "
      f"{len(packets)} hop packets in {caught} captures ({100*caught/len(iq_all):.0f} % of captures)")
chans = collections.Counter(p["ch"] for p in packets)
print(f"channels seen: {len(chans)} of 79; per-channel hits median {np.median(list(chans.values())):.0f}, max {max(chans.values())}")
cfo = np.array([p["cfo"] for p in packets])
hist, edges = np.histogram(cfo / 1e3, bins=np.arange(-200, 220, 20))
print("carrier offset histogram (kHz):", {f"{edges[i]:+.0f}": int(h) for i, h in enumerate(hist) if h})
# Transmitter groups by carrier offset (40 kHz clusters).
groups = collections.defaultdict(list)
for p in packets:
    groups[int(np.floor(p["cfo"] / 40e3))].append(p)
for g, ps in sorted(groups.items(), key=lambda kv: -len(kv[1]))[:4]:
    c = np.array([q["cfo"] for q in ps])
    by_ch = collections.defaultdict(list)
    for q in ps:
        by_ch[q["ch"]].append(q)
    revisits, amp_cv, ch_spread = [], [], []
    for ch, qs in by_ch.items():
        qs.sort(key=lambda q: q["t"])
        revisits += list(np.diff([q["t"] for q in qs]))
        a = np.array([q["amp"] for q in qs])
        if len(a) >= 3:
            amp_cv.append(np.std(a) / np.mean(a))
    per_ch = np.array([np.mean([q["amp"] for q in v]) for v in by_ch.values()])
    print(f"group CFO {np.median(c)/1e3:+.0f} kHz: {len(ps)} packets on {len(by_ch)} channels, "
          f"median dur {np.median([q['dur_us'] for q in ps]):.0f} us, in-packet envelope ripple {100*np.median([q['flat'] for q in ps]):.1f} %; "
          f"same-channel revisit median {np.median(revisits) if revisits else float('nan'):.2f} s, "
          f"same-channel amplitude repeatability {100*np.median(amp_cv) if amp_cv else float('nan'):.1f} %, "
          f"across-channel amplitude spread {100*np.std(per_ch)/np.mean(per_ch):.0f} % (multipath fringe)")
