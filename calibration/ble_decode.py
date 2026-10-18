"""Decode BLE 1M advertising packets from raw I/Q and measure each one's CFO.

Pipeline: burst detect -> low-pass -> FM discriminator -> correlate against the
preamble + advertising access address (0x8E89BED6) for timing -> least-squares
fit inst_freq = cfo + dev * template over those 40 known bits -> slice the
rest, de-whiten, check CRC-24, parse the advertising PDU.

usage: ble_decode.py RECORDING.npz [CHANNEL_INDEX]
"""
import json
import sys
from collections import defaultdict

import numpy as np
from scipy.signal import firwin, lfilter

ACCESS = 0x8E89BED6
RF_TO_INDEX = {2402: 37, 2426: 38, 2480: 39}
PDU_TYPES = {0: "ADV_IND", 1: "ADV_DIRECT_IND", 2: "ADV_NONCONN_IND", 3: "SCAN_REQ", 4: "SCAN_RSP",
             5: "CONNECT_IND", 6: "ADV_SCAN_IND", 7: "ADV_EXT_IND"}
COMPANIES = {0x004C: "Apple", 0x0006: "Microsoft", 0x0075: "Samsung", 0x00E0: "Google", 0x02E5: "Espressif"}


def lsb_bits(value, nbits):
    return [(value >> k) & 1 for k in range(nbits)]


def whitening(nbits, channel):
    # Spec LFSR x^7 + x^4 + 1: position 0 = 1, positions 1..6 = channel MSB..LSB; output from position 6.
    reg = [1] + [(channel >> (5 - k)) & 1 for k in range(6)]
    out = []
    for _ in range(nbits):
        o = reg[6]
        out.append(o)
        reg = [o, reg[0], reg[1], reg[2], reg[3] ^ o, reg[4], reg[5]]
    return np.array(out, dtype=np.uint8)


def crc24(bits, init=0x555555):
    reg = [(init >> k) & 1 for k in range(24)]  # position 0 = LSB
    for b in bits:
        fb = reg[23] ^ b
        reg = [fb] + reg[:23]
        for k in (1, 3, 4, 6, 9, 10):
            reg[k] ^= fb
    return [reg[23 - k] for k in range(24)]  # transmitted from position 23 first


def bits_to_bytes(bits):
    return bytes(int(sum(int(bits[8 * i + k]) << k for k in range(8))) for i in range(len(bits) // 8))


def parse_ad(data):
    out, i = {}, 0
    while i < len(data):
        n = data[i]
        if n == 0 or i + 1 + n > len(data):
            break
        t, v = data[i + 1], data[i + 2:i + 1 + n]
        if t in (0x08, 0x09):
            out["name"] = v.decode(errors="replace")
        elif t == 0xFF and len(v) >= 2:
            cid = v[0] | v[1] << 8
            out["company"] = COMPANIES.get(cid, f"0x{cid:04X}")
            out["mfg_type"] = v[2] if len(v) > 2 else None
        elif t == 0x0A and len(v) == 1:
            out["tx_power"] = int(np.int8(v[0]))
        elif t in (0x02, 0x03):
            out["uuid16"] = [f"{v[k] | v[k+1] << 8:04X}" for k in range(0, len(v) - 1, 2)]
        i += n + 1
    return out


def decode(iq_all, fs, channel):
    sps = int(round(fs / 1e6))
    taps = firwin(97, 650e3, fs=fs)
    known = np.array(lsb_bits(0xAA, 8) + lsb_bits(ACCESS, 32), dtype=float) * 2 - 1
    tmpl = np.repeat(known, sps)
    # Smooth like the Gaussian filter (BT=0.5) so the LS fit sees realistic transitions.
    g = np.exp(-0.5 * (np.arange(-sps, sps + 1) / (0.36 * sps)) ** 2)
    tmpl_s = np.convolve(tmpl, g / g.sum(), "same")
    tz = tmpl_s - tmpl_s.mean()
    packets = []
    for ci, iq in enumerate(iq_all):
        z = iq - iq.mean()
        p = np.convolve(np.abs(z) ** 2, np.ones(sps), "same")
        pdb = 10 * np.log10(p + 1e-14)
        floor = np.percentile(pdb, 20)
        on = pdb > floor + 12
        e = np.flatnonzero(np.diff(np.r_[0, on.astype(np.int8), 0]))
        for a, b in zip(e[::2], e[1::2]):
            if b - a < 80 * sps or a < 2 * sps:
                continue
            a0 = max(0, a - 4 * sps)
            y = lfilter(taps, 1, z[a0:b + 4 * sps])
            d = len(taps) // 2
            y = y[d:]
            inst = np.angle(y[1:] * np.conj(y[:-1])) * fs / (2 * np.pi)
            search = inst[: 20 * sps + len(tmpl)]
            if len(search) < len(tmpl) + sps:
                continue
            corr = np.correlate(search - search.mean(), tz, "valid")
            k = int(np.argmax(corr))
            seg = inst[k:k + len(tmpl)]
            A = np.c_[np.ones(len(seg)), tmpl_s]
            (cfo, dev), *_ = np.linalg.lstsq(A, seg, rcond=None)
            resid = np.std(seg - A @ np.array([cfo, dev]))
            if dev < 120e3 or resid > 0.6 * dev:
                continue
            # Slice remaining bits at symbol centres.
            centres = k + len(tmpl) + sps // 2 + sps * np.arange((len(inst) - k - len(tmpl)) // sps)
            raw = (inst[centres] - cfo > 0).astype(np.uint8)
            if len(raw) < 16 + 24:
                continue
            white = whitening(len(raw), channel)
            bits = raw ^ white
            hdr = bits_to_bytes(bits[:16])
            ptype, length = hdr[0] & 0x0F, hdr[1] & 0x3F
            nbits = 16 + 8 * length
            if len(bits) < nbits + 24:
                continue
            crc_ok = list(crc24(bits[:nbits])) == list(bits[nbits:nbits + 24])
            payload = bits_to_bytes(bits[16:nbits])
            rec = dict(cap=ci, start_us=(a0 + k) / fs * 1e6, cfo_hz=float(cfo), dev_hz=float(dev),
                       resid_hz=float(resid), snr_db=float(pdb[a:b].mean() - floor),
                       power_dbfs=float(10 * np.log10(np.mean(np.abs(z[a:b]) ** 2))),
                       pdu=PDU_TYPES.get(ptype, ptype), txadd=int(hdr[0] >> 6 & 1), length=length, crc_ok=crc_ok)
            if crc_ok and ptype in (0, 2, 4, 6) and length >= 6:
                rec["adva"] = ":".join(f"{x:02X}" for x in payload[5::-1])
                rec.update(parse_ad(payload[6:]))
            elif crc_ok and ptype == 3 and length == 12:
                rec["scana"] = ":".join(f"{x:02X}" for x in payload[5::-1])
                rec["adva"] = ":".join(f"{x:02X}" for x in payload[11:5:-1])
            packets.append(rec)
    return packets


if __name__ == "__main__":
    d = np.load(sys.argv[1])
    rf = int(d["freq"])
    ch = int(sys.argv[2]) if len(sys.argv) > 2 else RF_TO_INDEX[rf]
    pk = decode(d["iq"], float(d["rate"]), ch)
    good = [p for p in pk if p["crc_ok"]]
    print(f"{len(pk)} access-address matches, {len(good)} CRC-valid on channel {ch} ({rf} MHz)")
    by = defaultdict(list)
    for p in good:
        by[p.get("adva", "?")].append(p)
    for adva, ps in sorted(by.items(), key=lambda kv: -len(kv[1])):
        c = np.array([p["cfo_hz"] for p in ps])
        extra = {k: ps[-1][k] for k in ("company", "name", "tx_power", "uuid16") if k in ps[-1]}
        print(f"  {adva}  n={len(ps):3d}  CFO {np.median(c)/1e3:+7.1f} kHz (spread {np.std(c)/1e3:4.1f})  "
              f"dev {np.median([p['dev_hz'] for p in ps])/1e3:5.0f} kHz  {np.median([p['power_dbfs'] for p in ps]):6.1f} dBFS  "
              f"{sorted(set(p['pdu'] for p in ps))} {extra}")
    json.dump(pk, open(sys.argv[1].replace(".npz", "_ble.json"), "w"), indent=1, default=str)
