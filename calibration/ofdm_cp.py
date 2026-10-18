"""Cross-check OFDM CFO with cyclic-prefix correlation over the data symbols.

Each 4 us OFDM symbol's 0.8 us guard repeats its last 0.8 us, so
sum x[n] conj(x[n+3.2us]) over guard windows has angle -2 pi f 3.2us
(unambiguous to +-156 kHz). The STF coarse estimate picks the branch.
"""
import sys

import numpy as np

from ofdm_cfo import ofdm_packets

d = np.load(sys.argv[1])
iq_all, fs = d["iq"], float(d["rate"])
N = int(round(3.2e-6 * fs))
G = int(round(0.8e-6 * fs))
for r in ofdm_packets(iq_all, fs):
    z = iq_all[r["cap"]] - iq_all[r["cap"]].mean()
    a = int(r["start_us"] * fs / 1e6)
    body = z[a + int(16e-6 * fs):]  # past L-STF + L-LTF
    p = np.convolve(np.abs(body) ** 2, np.ones(G), "same")
    on = np.flatnonzero(p > 0.25 * np.median(p[: int(20e-6 * fs)]))
    body = body[: on[-1] if len(on) else len(body)]
    c = body[:-N] * np.conj(body[N:])
    m = np.abs(np.convolve(c, np.ones(G), "valid"))
    # Symbol timing: fold the CP metric modulo the 4 us symbol period.
    S = N + G
    k = len(m) // S * S
    phase = int(np.argmax(m[:k].reshape(-1, S).sum(0)))
    acc = sum(c[s:s + G].sum() for s in range(phase, len(c) - G, S))
    cp = -np.angle(acc) * fs / (2 * np.pi * N)
    span = fs / N
    branch = cp + span * np.round((r["coarse_hz"] - cp) / span)
    print(f"cap {r['cap']:4d} {r['power_dbfs']:.1f} dBFS  STF {r['coarse_hz']/1e3:+7.1f}  STF+LTF {r['cfo_hz']/1e3:+7.1f}  "
          f"CP {branch/1e3:+7.1f} kHz over {(len(c)-phase)//S} symbols")
