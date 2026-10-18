"""Confirm the ESP transmits over the air using the laptop's own Bluetooth radio.

BLE advertising uses channels 37/38/39 at 2402/2426/2480 MHz. This counts the
advertisements the laptop hears in three phases: quiet, then while the ESP
sweeps a CW tone across those three channels, then quiet again. If the ESP
radiates, the laptop misses advertisements during the sweep and recovers after.

Narrowband CW (one channel at a time) keeps this contained; it briefly reduces
BLE reception on the swept channels near the laptop. Run only on hardware you
are authorized to transmit from.

usage: tx_verify_ble.py [--port COM17] [--phase 15] [--channels 37,38,39] [--noise]
"""
import argparse
import asyncio
import statistics
import threading
import time

import serial
from bleak import BleakScanner

ADV_MHZ = {37: 2402, 38: 2426, 39: 2480}


class Transmitter(threading.Thread):
    """Sweeps a CW tone across the given advertising channels until stopped."""

    def __init__(self, port, channels, dwell=0.4):
        super().__init__(daemon=True)
        self.port = port
        self.freqs = [ADV_MHZ[c] for c in channels]
        self.dwell = dwell
        self._halt = threading.Event()
        self.error = None

    def _cmd(self, s, line, expect="OK", timeout=2):
        s.write((line + "\n").encode())
        end = time.time() + timeout
        while time.time() < end:
            r = s.readline().decode(errors="replace").strip()
            if r.startswith(expect):
                return r
            if r.startswith("ERR"):
                raise RuntimeError(f"{line}: {r}")
        raise TimeoutError(line)

    def run(self):
        try:
            s = serial.Serial(self.port, 2000000, timeout=1)
            time.sleep(0.3)
            s.reset_input_buffer()
            i, last_keep = 0, 0.0
            while not self._halt.is_set():
                f = self.freqs[i % len(self.freqs)]
                i += 1
                self._cmd(s, "CW STOP")
                self._cmd(s, f"FREQ {f}")
                self._cmd(s, "CW START")
                t0 = time.time()
                while time.time() - t0 < self.dwell and not self._halt.is_set():
                    if time.time() - last_keep > 2:
                        self._cmd(s, "CW KEEP")
                        last_keep = time.time()
                    time.sleep(0.05)
            self._cmd(s, "CW STOP")
            self._cmd(s, "RELEASE", expect="")
            s.close()
        except Exception as e:  # noqa: BLE001 - surface to main thread
            self.error = e

    def stop(self):
        self._halt.set()


async def count_adverts(seconds):
    hits = []

    def cb(dev, adv):
        hits.append((dev.address, adv.rssi, time.time()))

    async with BleakScanner(cb, scanning_mode="active"):
        await asyncio.sleep(seconds)
    rate = len(hits) / seconds
    devices = len({h[0] for h in hits})
    rssi = statistics.median(h[1] for h in hits) if hits else None
    return dict(adverts=len(hits), rate=rate, devices=devices, rssi=rssi)


async def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", default="COM17")
    p.add_argument("--phase", type=float, default=15)
    p.add_argument("--channels", default="37,38,39")
    args = p.parse_args()
    channels = [int(c) for c in args.channels.split(",")]

    print(f"Phase 1/3: baseline ({args.phase:.0f}s, radio quiet)…", flush=True)
    before = await count_adverts(args.phase)
    print(f"  {before['adverts']} adverts, {before['rate']:.1f}/s, {before['devices']} devices, median RSSI {before['rssi']}")

    print(f"Phase 2/3: ESP sweeping CW across channels {channels} ({args.phase:.0f}s)…", flush=True)
    tx = Transmitter(args.port, channels)
    tx.start()
    time.sleep(1)
    during = await count_adverts(args.phase)
    tx.stop()
    tx.join(timeout=3)
    print(f"  {during['adverts']} adverts, {during['rate']:.1f}/s, {during['devices']} devices, median RSSI {during['rssi']}")
    if tx.error:
        print(f"  transmitter error: {tx.error}")

    print(f"Phase 3/3: recovery ({args.phase:.0f}s, radio quiet)…", flush=True)
    after = await count_adverts(args.phase)
    print(f"  {after['adverts']} adverts, {after['rate']:.1f}/s, {after['devices']} devices, median RSSI {after['rssi']}")

    baseline = (before["rate"] + after["rate"]) / 2
    drop = 1 - during["rate"] / baseline if baseline else 0
    print(f"\nadvert rate: {before['rate']:.1f} → {during['rate']:.1f} → {after['rate']:.1f} /s "
          f"(quiet avg {baseline:.1f})")
    if baseline < 2:
        print("Inconclusive: too few BLE advertisers nearby to measure. Move near a phone/beacon and retry.")
    elif drop > 0.25 and during["rate"] < after["rate"]:
        print(f"CONFIRMED: reception fell {100*drop:.0f}% during transmit and recovered — the ESP is radiating.")
    else:
        print(f"Not confirmed: reception changed only {100*drop:.0f}%. Check antenna, raise amplitude, or move the "
              f"ESP closer to the laptop.")


if __name__ == "__main__":
    asyncio.run(main())
