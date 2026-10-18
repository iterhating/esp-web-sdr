"""Inventory nearby BLE advertisers with the host's Bluetooth adapter."""
import asyncio
import json
import sys

from bleak import BleakScanner

COMPANIES = {0x004C: "Apple", 0x0006: "Microsoft", 0x0075: "Samsung", 0x00E0: "Google", 0x02E5: "Espressif",
             0x0059: "Nordic", 0x000F: "Broadcom", 0x005D: "Realtek", 0x0157: "Huami", 0x038F: "Xiaomi",
             0x0087: "Garmin", 0x01DA: "Logitech", 0x0171: "Amazon", 0x05A7: "Sonos", 0x0499: "Ruuvi"}


async def main(seconds):
    seen = {}

    def cb(dev, adv):
        r = seen.setdefault(dev.address, dict(address=dev.address, name=None, rssi=[], mfg=set(), uuids=set(), tx=None))
        r["name"] = r["name"] or adv.local_name or dev.name
        r["rssi"].append(adv.rssi)
        r["mfg"].update(COMPANIES.get(k, f"0x{k:04X}") for k in adv.manufacturer_data)
        r["uuids"].update(adv.service_uuids)
        r["tx"] = adv.tx_power if adv.tx_power is not None else r["tx"]

    async with BleakScanner(cb, scanning_mode="active"):
        await asyncio.sleep(seconds)
    rows = []
    for r in seen.values():
        rs = sorted(r["rssi"])
        rows.append(dict(address=r["address"], name=r["name"], rssi_median=rs[len(rs) // 2], adverts=len(rs),
                         mfg=sorted(r["mfg"]), uuids=sorted(r["uuids"]), tx_power=r["tx"]))
    rows.sort(key=lambda r: -r["rssi_median"])
    for r in rows:
        print(f"{r['address']}  rssi {r['rssi_median']:4d}  adv {r['adverts']:4d}  {r['name'] or '-':24s} "
              f"{','.join(r['mfg']) or '-':18s} uuids={len(r['uuids'])} tx={r['tx_power']}")
    json.dump(rows, open("ble_inventory.json", "w"), indent=1)
    print(f"{len(rows)} advertisers")


asyncio.run(main(float(sys.argv[1]) if len(sys.argv) > 1 else 45))
