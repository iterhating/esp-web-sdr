"""Verify the IQS stream on hardware: gaps, CRC, delivered rate and tuning sign.

Tunes so the chip's fixed 2448.000 MHz spur should land at a known offset,
streams, and reports where it actually appears. Mirrors iqstream.js: LO =
centre - 4 MHz split into FREQ MHz + FOFS kHz, firmware mode 2, conjugated
samples.

usage: iqs_check.py PORT [CENTRE_MHZ ...]
"""
import struct
import sys
import time
import zlib

import numpy as np

from espsdr import ESPSDR

SPUR = 2448.0e6


def stream(sdr, centre_hz, rate=250000, bits=8, shift=4, seconds=2.0):
    lo = centre_hz - 4e6
    mhz = round(lo / 1e6)
    khz = round((lo - mhz * 1e6) / 1e3)
    residual = lo - mhz * 1e6 - khz * 1e3
    sdr.command(f"FOFS {khz}")
    sdr.frequency = None
    sdr.tune(mhz, 13)
    dec = int(16e6 // rate)
    sdr.s.write(f"IQS 0 {dec} {bits} 6 {shift} 2\n".encode())
    head = sdr._line("IQS ")
    buf = b""
    frames, crc_bad, gaps, nxt = [], 0, 0, None
    t0 = time.time()
    while time.time() - t0 < seconds:
        buf += sdr.s.read(sdr.s.in_waiting or 1)
        while True:
            k = buf.find(b"IQS1")
            if k < 0 or len(buf) - k < 24:
                break
            magic, seq, index, n, b, flags, d, gain, sh = struct.unpack_from("<IIQHBBHBB", buf, k)
            size = n * (4 if b == 16 else 2)
            end = k + 24 + size + 4
            if len(buf) < end:
                break
            if zlib.crc32(buf[k:end - 4]) != struct.unpack_from("<I", buf, end - 4)[0]:
                crc_bad += 1
                buf = buf[k + 1:]
                continue
            if nxt is not None and index != nxt:
                gaps += index - nxt
            nxt = index + n
            raw = np.frombuffer(buf[k + 24:end - 4], dtype=np.int16 if b == 16 else np.int8).astype(np.float32)
            frames.append(raw[0::2] - 1j * raw[1::2])
            buf = buf[end:]
    elapsed = time.time() - t0
    sdr.s.write(b"\n")
    deadline = time.time() + 2
    tail = b""
    while time.time() < deadline and b"IQSEND" not in tail:
        tail += sdr.s.read(sdr.s.in_waiting or 1)
    sdr.s.reset_input_buffer()
    sdr.command("FOFS 0")
    sdr.frequency = None
    iq = np.concatenate(frames) * (2 ** shift / 16384)
    if residual:
        iq *= np.exp(-2j * np.pi * residual / rate * np.arange(len(iq)))
    return iq, dict(head=head, rate=rate, samples=len(iq), elapsed=elapsed, gaps=gaps, crc_bad=crc_bad,
                    fofs=khz, lo_mhz=mhz)


if __name__ == "__main__":
    port = sys.argv[1] if len(sys.argv) > 1 else "COM17"
    centres = [float(x) * 1e6 for x in sys.argv[2:]] or [2448.000e6, 2448.050e6, 2447.877e6, 2448.0005e6]
    sdr = ESPSDR(port)
    sdr.set_gain(54)
    for c in centres:
        iq, st = stream(sdr, c)
        n = 1 << int(np.floor(np.log2(len(iq))))
        x = iq[-n:]
        w = np.blackman(n)
        p = np.fft.fftshift(np.abs(np.fft.fft(x * w)) ** 2) / w.sum() ** 2
        f = (np.arange(n) - n // 2) * st["rate"] / n
        k = int(np.argmax(p))
        found = c + f[k]
        print(f"centre {c/1e6:.6f} MHz (LO {st['lo_mhz']} MHz {st['fofs']:+d} kHz): {st['samples']} samples in "
              f"{st['elapsed']:.2f} s = {st['samples']/st['elapsed']/1e3:.1f} kS/s, gaps {st['gaps']}, CRC bad {st['crc_bad']}; "
              f"strongest line at {found/1e6:.6f} MHz ({10*np.log10(p[k]):.1f} dBFS), "
              f"expected spur offset {(SPUR-c)/1e3:+.3f} kHz, seen {f[k]/1e3:+.3f} kHz")
    sdr.set_gain(None)
    sdr.close()
