"""Record raw I/Q bursts to .npz for offline analysis.

usage: record.py PORT FREQ_MHZ COUNT [RATE_MSPS] [GAIN] [BANDWIDTH]
"""
import sys
import time

import numpy as np

from espsdr import ESPSDR

port, freq, count = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
rate = float(sys.argv[4]) * 1e6 if len(sys.argv) > 4 else 40e6
gain = int(sys.argv[5]) if len(sys.argv) > 5 else 54
bw = int(sys.argv[6]) if len(sys.argv) > 6 else 35
sdr = ESPSDR(port)
sdr.set_gain(gain)
sdr.tune(freq, bw)
caps, stamps = [], []
for _ in range(count):
    stamps.append(time.time())
    caps.append(sdr.capture(rate=rate, bits=10))
sdr.tune(2442, 0)
sdr.set_gain(None)
name = f"rec_{freq}_{int(rate/1e6)}M_g{gain}.npz"
np.savez_compressed(name, iq=np.array(caps), t=np.array(stamps), freq=freq, rate=rate, gain=gain, bw=bw)
print(name, np.array(caps).shape)
