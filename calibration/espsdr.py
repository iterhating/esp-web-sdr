"""Minimal host driver for ESP-SDR burst firmware (protocol 6) over serial.

Mirrors radio.js: CAP16 payloads are signed 8-bit I then Q, CAP20 payloads are
10-bit I/Q packed LSB-first; Q is negated so positive frequencies lie above
the LO.
"""
import re
import time
import zlib

import numpy as np
import serial

# Index into this table is the rate code sent in CAP16/CAP20 (radio.js RATE_CODES).
RATE_CODES = [80e6, 40e6, 20e6, 10e6, 8e6, 4e6, 16e6, 32e6, 10666667, 6.4e6]
MAX_SAMPLES = 16380


class ESPSDR:
    def __init__(self, port="COM17", baud=2000000, timeout=3.0):
        self.s = serial.Serial(port, baud, timeout=timeout)
        self.frequency = None
        self.gain = None
        self.bandwidth = None
        time.sleep(0.3)
        self.sync()
        self.info = self.query("INFO", prefix="")
        self.caps = self.query("CAPS").split()[1:]

    def close(self):
        self.s.close()

    def _line(self, prefix=""):
        deadline = time.monotonic() + self.s.timeout
        while time.monotonic() < deadline:
            raw = self.s.readline()
            if not raw:
                continue
            text = raw.decode(errors="replace").strip()
            if text.startswith("ERR "):
                raise RuntimeError(text)
            if text.startswith(prefix):
                return text
        raise TimeoutError(f"no reply starting with {prefix!r}")

    def command(self, line, expect="OK"):
        self.s.write((line + "\n").encode())
        return self._line(expect)

    def query(self, line, prefix=None):
        self.s.write((line + "\n").encode())
        return self._line(line.rstrip("?").split()[0] if prefix is None else prefix)

    def sync(self):
        """Drain stale bytes (e.g. boot log) and resynchronize on an echoed nonce."""
        self.s.reset_input_buffer()
        nonce = int(time.time() * 1000)
        self.s.write(f"SYNC {nonce}\n".encode())
        self._line(f"SYNC {nonce}")

    def tune(self, mhz, bandwidth=0):
        if self.frequency != mhz:
            self.command(f"FREQ {int(mhz)}")
            self.frequency = mhz
        if self.bandwidth != bandwidth:
            self.command(f"BANDWIDTH {int(bandwidth)}")
            self.bandwidth = bandwidth

    def set_gain(self, index=None):
        """None selects hardware AGC; an int selects a manual PHY gain-table index."""
        setting = "HARDWARE" if index is None else f"MANUAL {int(index)}"
        if setting != self.gain:
            self.command(f"GAIN {setting}")
            self.gain = setting

    def capture(self, n=MAX_SAMPLES, rate=40e6, bits=8):
        code = RATE_CODES.index(rate)
        for attempt in range(4):
            self.s.write(f"CAP{bits * 2} {n} {code}\n".encode())
            header = self._line("DATA ")
            m = re.fullmatch(r"DATA (\d+) ([0-9a-fA-F]{1,8}) (\d+)", header)
            count = int(m.group(1))
            size = (count * bits * 2 + 7) // 8
            payload = self.s.read(size)
            if len(payload) == size and zlib.crc32(payload) == int(m.group(2), 16):
                return decode_iq(payload, count, bits)
            self.sync()
        raise RuntimeError("capture failed CRC after 4 attempts")


def decode_iq(payload, n, bits):
    b = np.frombuffer(payload, dtype=np.uint8)
    if bits == 8:
        v = b[: 2 * n].view(np.int8).astype(np.float32) / 128
        return v[0::2] - 1j * v[1::2]
    # 20-bit words packed LSB-first: I bits 0-9, Q bits 10-19.
    bitstream = np.unpackbits(b, bitorder="little")[: n * 20].reshape(n, 20)
    weights = 1 << np.arange(10)
    i = (bitstream[:, :10] * weights).sum(1)
    q = (bitstream[:, 10:] * weights).sum(1)
    i = np.where(i >= 512, i - 1024, i) / 512
    q = np.where(q >= 512, q - 1024, q) / 512
    return (i - 1j * q).astype(np.complex64)


def psd(iq, nfft=1024):
    """Welch PSD (Hann, 50% overlap), DC-removed, fftshifted; returns dBFS/bin."""
    iq = iq - iq.mean()
    w = np.hanning(nfft)
    hop = nfft // 2
    frames = [iq[k:k + nfft] * w for k in range(0, len(iq) - nfft + 1, hop)]
    p = np.mean([np.abs(np.fft.fft(f)) ** 2 for f in frames], axis=0) / (w.sum() ** 2)
    return np.fft.fftshift(10 * np.log10(np.maximum(p, 1e-14)))
