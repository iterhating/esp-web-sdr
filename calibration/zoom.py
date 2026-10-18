"""High-resolution look at a frequency: tune off-center at several LOs and
report the strongest persistent line, its width, and its mirror image.

A real signal keeps its absolute frequency as the LO moves; a receiver spur
moves with the LO. The image of a line at +x appears at -x with a level set by
I/Q gain/phase imbalance.
"""
import sys

import numpy as np

from espsdr import ESPSDR

port = sys.argv[1] if len(sys.argv) > 1 else "COM17"
target = float(sys.argv[2]) if len(sys.argv) > 2 else 2448.0
gain = int(sys.argv[3]) if len(sys.argv) > 3 else 60
rate, nfft = 16e6, 16384
sdr = ESPSDR(port)
sdr.set_gain(gain)
f_rel = (np.arange(nfft) - nfft // 2) * rate / nfft
w = np.blackman(16380)
for lo in (int(target) - 5, int(target) - 3, int(target) + 3, int(target) + 5):
    sdr.tune(lo, 13)
    acc = np.zeros(nfft)
    for _ in range(40):
        iq = sdr.capture(rate=rate, bits=10)
        iq = iq - iq.mean()
        acc += np.abs(np.fft.fftshift(np.fft.fft(iq * w, nfft))) ** 2
    p = 10 * np.log10(acc / 40 / w.sum() ** 2 + 1e-14)
    off = (target - lo) * 1e6
    win = np.abs(f_rel - off) < 400e3
    k = np.argmax(np.where(win, p, -999))
    peak_hz = lo * 1e6 + f_rel[k]
    above = np.where(win & (p > p[k] - 3))[0]
    width = (f_rel[above[-1]] - f_rel[above[0]]) if len(above) else 0
    img = np.argmax(np.where(np.abs(f_rel + f_rel[k]) < 20e3, p, -999))
    floor = np.median(p)
    print(f"LO {lo}: line at {peak_hz/1e6:.4f} MHz ({p[k]:.1f} dBFS, -3dB width {width/1e3:.1f} kHz, "
          f"SNR {p[k]-floor:.1f} dB), image at {(lo*1e6+f_rel[img])/1e6:.4f} MHz {p[img]:.1f} dBFS "
          f"-> IRR {p[k]-p[img]:.1f} dB")
sdr.tune(2442, 0)
sdr.set_gain(None)
