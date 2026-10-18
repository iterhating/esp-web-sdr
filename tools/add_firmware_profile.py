"""Add (or replace) a firmware profile in firmware/manifest.json from an ESP-IDF build.

Copies the images listed in the build's flash_args into firmware/<id>/ using
the installer's N-name.bin convention and records sizes and checksums, so the
browser installer can offer the build alongside the stock receiver.

usage: add_firmware_profile.py BUILD_DIR ID LABEL APPLICATION VERSION [--source URL]
  APPLICATION: viewer | csi | soapysdr
"""
import argparse
import datetime
import hashlib
import json
import pathlib
import re
import shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent

p = argparse.ArgumentParser()
p.add_argument("build_dir", type=pathlib.Path)
p.add_argument("id")
p.add_argument("label")
p.add_argument("application", choices=["viewer", "csi", "soapysdr"])
p.add_argument("version")
p.add_argument("--source", default="")
a = p.parse_args()
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", a.id):
    raise SystemExit("invalid profile id")

desc = json.loads((a.build_dir / "flasher_args.json").read_text())
chip = desc["extra_esptool_args"]["chip"]
settings = desc["flash_settings"]
out = ROOT / "firmware" / a.id
if out.exists():
    shutil.rmtree(out)
out.mkdir(parents=True)
parts = []
for i, (offset, rel) in enumerate(sorted(desc["flash_files"].items(), key=lambda kv: int(kv[0], 16))):
    src = a.build_dir / rel
    name = f"{i}-{pathlib.Path(rel).name}"
    data = src.read_bytes()
    (out / name).write_bytes(data)
    parts.append(dict(name=name, offset=int(offset, 16), size=len(data),
                      sha256=hashlib.sha256(data).hexdigest(), md5=hashlib.md5(data).hexdigest()))
(out / "build-info.json").write_text(json.dumps(dict(profile=a.id, version=a.version, source=a.source), indent=2) + "\n",
                                     newline="\n")

manifest_path = ROOT / "firmware" / "manifest.json"
manifest = json.loads(manifest_path.read_text())
target = chip
variant = dict(
    revision=a.id,
    label=a.label,
    target=target,
    chip="ESP32" + ("-" + target[5:].upper() if target[5:] else ""),
    version=a.version,
    flash_size=settings["flash_size"],
    flash_size_policy="minimum",
    flash_settings=settings,
    esptool_args=dict(after="hard-reset", before="default-reset", stub=True, chip=chip),
    parts=parts,
    build_date=datetime.date.today().isoformat(),
    git_revision=a.version,
)
if a.application != "viewer":
    variant["application"] = a.application
manifest["variants"][a.id] = variant
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", newline="\n")
print(f"{a.id}: {len(parts)} images, {sum(x['size'] for x in parts)} bytes -> {out.relative_to(ROOT)}")
