'use strict';
// Known allocations and receiver artifacts, drawn over the spectrum and named
// under the cursor. Spur and filter figures are bench measurements; see
// calibration/README.md for how they were taken.

// 2.4 GHz Wi-Fi channel centres (MHz); channel 14 is Japan-only 802.11b.
const WIFI24 = Array.from({ length: 13 }, (_, k) => ({ ch: k + 1, mhz: 2412 + 5 * k })).concat([
  { ch: 14, mhz: 2484 },
]);
// 5 GHz 20 MHz channels: UNII-1/2/2e/3 and UNII-4.
const WIFI5 = [
  ...[36, 40, 44, 48, 52, 56, 60, 64],
  ...[100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144],
  ...[149, 153, 157, 161, 165, 169, 173, 177],
].map((ch) => ({ ch, mhz: 5000 + 5 * ch }));
// BLE advertising channels 37/38/39 sit outside the Wi-Fi 1/6/11 centres.
const BLE_ADV = [
  { ch: 37, mhz: 2402 },
  { ch: 38, mhz: 2426 },
  { ch: 39, mhz: 2480 },
];
// Narrow lines generated inside the chip, coherent with its crystal: they keep
// their absolute frequency as the LO moves. Measured on an ESP32-S3 at
// -50 dBFS (2448) with gain index 60; 2400 shares the 48 MHz harmonic series.
const CHIP_SPURS = {
  S3: [
    { mhz: 2400, label: '48 MHz ×50 spur' },
    { mhz: 2448, label: '48 MHz ×51 spur' },
  ],
};

// BLE channel index for a 2 MHz-spaced RF channel, or null.
function bleChannel(mhz) {
  const k = Math.round((mhz - 2402) / 2);
  if (k < 0 || k > 39 || Math.abs(mhz - (2402 + 2 * k)) > 0.5) return null;
  if (k === 0) return 37;
  if (k === 12) return 38;
  if (k === 39) return 39;
  return k < 12 ? k - 1 : k - 2;
}

// Names of everything known at a frequency, nearest-first for Wi-Fi.
function describeFrequency(hz, family = '') {
  const mhz = hz / 1e6,
    out = [];
  const wifi = [...WIFI24, ...WIFI5].filter((c) => Math.abs(mhz - c.mhz) <= 10);
  wifi.sort((a, b) => Math.abs(mhz - a.mhz) - Math.abs(mhz - b.mhz));
  if (wifi.length) out.push(`Wi-Fi ch ${wifi.map((c) => c.ch).join('/')}`);
  const ble = bleChannel(mhz);
  if (ble !== null) out.push(`BLE ch ${ble}${ble >= 37 ? ' (adv)' : ''}`);
  const bt = Math.round(mhz - 2402);
  if (bt >= 0 && bt <= 78 && Math.abs(mhz - 2402 - bt) <= 0.5) out.push(`BT ch ${bt}`);
  for (const s of CHIP_SPURS[family] || []) if (Math.abs(mhz - s.mhz) <= 0.05) out.push(s.label);
  return out;
}

// Analog filter setting that keeps the -3 dB edge just inside Nyquist. On the
// S3, BANDWIDTH n puts the one-sided -3 dB edge near 0.47 n MHz; 0 means open.
function matchedBandwidth(rate, range) {
  if (!range) return 0;
  const [min, max, step] = range,
    want = Math.round((0.9 * rate) / 1e6 / step) * step;
  return want > max ? 0 : Math.max(min, want);
}

// Receiver crystal correction: a crystal running `ppm` fast shifts the LO and
// the sample clock alike, so displayed frequencies scale by 1 + ppm * 1e-6.
function ppmScale(ppm) {
  return 1 + (Number(ppm) || 0) * 1e-6;
}

// Overlay channel markers and known spurs on the spectrum canvas.
// x(hz) maps an absolute frequency to canvas pixels; f0/f1 bound the view.
function drawBandPlan(g, x, f0, f1, w, h, d, family = '') {
  const inView = (mhz, half = 0) => mhz * 1e6 + half * 1e6 >= f0 && mhz * 1e6 - half * 1e6 <= f1,
    pxPerMHz = (x(1e6) - x(0)) || 1;
  g.save();
  g.font = `${11 * d}px Carlito,sans-serif`;
  g.textBaseline = 'top';
  // Wi-Fi: shade the non-overlapping 1/6/11 (and every 5 GHz channel) when
  // they are wide enough to read; label every centre.
  for (const c of [...WIFI24, ...WIFI5]) {
    if (!inView(c.mhz, 10)) continue;
    const xc = x(c.mhz * 1e6),
      primary = c.mhz > 5000 || [1, 6, 11].includes(c.ch);
    if (primary && pxPerMHz * 20 > 40 * d) {
      g.fillStyle = '#4a90c212';
      g.fillRect(x((c.mhz - 10) * 1e6), 0, 20 * pxPerMHz, h);
    }
    if (pxPerMHz * 5 < 14 * d && !primary) continue;
    g.strokeStyle = primary ? '#4a90c2a0' : '#4a90c250';
    g.beginPath();
    g.moveTo(Math.round(xc) + 0.5, h - 12 * d);
    g.lineTo(Math.round(xc) + 0.5, h);
    g.stroke();
    g.fillStyle = primary ? '#7fb3dd' : '#5f88a8';
    g.fillText(String(c.ch), xc + 2 * d, h - 24 * d);
  }
  for (const c of BLE_ADV) {
    if (!inView(c.mhz, 1)) continue;
    g.fillStyle = '#d6a23a26';
    g.fillRect(x((c.mhz - 1) * 1e6), 0, Math.max(2 * d, 2 * pxPerMHz), h);
    g.fillStyle = '#e0b860';
    g.fillText(`BLE ${c.ch}`, x(c.mhz * 1e6) + 3 * d, 22 * d);
  }
  g.setLineDash([3 * d, 4 * d]);
  for (const s of CHIP_SPURS[family] || []) {
    if (!inView(s.mhz)) continue;
    const xs = Math.round(x(s.mhz * 1e6)) + 0.5;
    g.strokeStyle = '#e0605080';
    g.beginPath();
    g.moveTo(xs, 0);
    g.lineTo(xs, h);
    g.stroke();
    g.fillStyle = '#e88070';
    g.fillText('spur', xs + 3 * d, 36 * d);
  }
  g.restore();
}
