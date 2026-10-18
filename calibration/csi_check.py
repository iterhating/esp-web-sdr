"""Smoke-test the CSI firmware: INFO, then receive for a few seconds and summarise sources.

usage: csi_check.py PORT [CHANNEL] [SECONDS]
"""
import collections
import sys
import time

import serial

port = sys.argv[1] if len(sys.argv) > 1 else "COM17"
ch = int(sys.argv[2]) if len(sys.argv) > 2 else 6
seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 8
s = serial.Serial(port, 115200, timeout=1)
time.sleep(1.5)
s.reset_input_buffer()
for cmd in ("STOP", "INFO", f"CH {ch}", "RX"):
    s.write((cmd + "\n").encode())
t0, lines, other = time.time(), [], []
buf = b""
while time.time() - t0 < seconds:
    buf += s.read(s.in_waiting or 1)
    *done, buf = buf.split(b"\n")
    for raw in done:
        line = raw.decode(errors="replace").strip()
        (lines if line.startswith("CSI_DATA,") else other).append(line)
s.write(b"STOP\n")
s.close()
print("control:", [x for x in other if x][:6])
by = collections.defaultdict(list)
lens = collections.Counter()
for line in lines:
    f = line.split(",")
    by[f[2]].append(int(f[3]))
    lens[(int(f[5]), int(f[22]))] += 1
print(f"{len(lines)} CSI lines in {seconds:.0f} s on channel {ch} ({len(lines)/seconds:.1f}/s)")
print("(sig_mode, csi bytes) counts:", dict(lens))
for mac, rssi in sorted(by.items(), key=lambda kv: -len(kv[1]))[:10]:
    print(f"  source #{list(by).index(mac):2d}: {len(rssi):5d} frames, median RSSI {sorted(rssi)[len(rssi)//2]} dBm")
