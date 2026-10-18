import sys
import time

import numpy as np

from espsdr import ESPSDR, psd

sdr = ESPSDR(sys.argv[1] if len(sys.argv) > 1 else "COM17")
print(sdr.info, sdr.caps)
print(sdr.query("LIMITS?"))
sdr.tune(2437)
sdr.set_gain(None)
for rate in (80e6, 40e6, 16e6):
    t = time.perf_counter()
    iq = sdr.capture(rate=rate)
    dt = time.perf_counter() - t
    p = psd(iq)
    print(f"{rate/1e6:4.0f} MS/s n={len(iq)} {dt*1000:5.0f} ms  rms={np.sqrt(np.mean(np.abs(iq)**2)):.3f}  "
          f"dc={abs(iq.mean()):.4f}  psd median={np.median(p):.1f} max={p.max():.1f} dBFS")
sdr.close()
