'use strict';
// Panorama & survey page: continuous sweeps over everything the chip can reach,
// a stitched spectrum, a sweep waterfall and a ranked table of signals.
const $ = (id) => document.getElementById(id);
const SPUR_KEY = 'espSdrUserSpurs';
let connected = false,
  running = false,
  stop = false,
  pano = null,
  view = { a: 0, b: 1 },
  peaks = [],
  drag = null;
let userSpurs = [];
try {
  userSpurs = JSON.parse(localStorage.getItem(SPUR_KEY) || '[]').filter(Number.isFinite);
} catch (e) {}
const spec = $('spectrum'),
  water = $('waterfall'),
  sc = spec.getContext('2d'),
  wc = water.getContext('2d');

function error(e) {
  $('errorText').textContent = e?.message || e || '';
  $('error').hidden = !e;
}
function ui() {
  $('light').classList.toggle('on', connected);
  $('connect').textContent = connected ? 'Disconnect' : 'Connect ESP-SDR';
  $('sweep').disabled = !connected;
  $('sweep').textContent = running ? 'Stop sweeping' : 'Start sweeping';
  $('empty').hidden = connected;
  if (!connected) $('status').textContent = 'Disconnected';
}
async function connect(port = null) {
  error('');
  $('status').textContent = 'Connecting…';
  try {
    await radio.connect({ port });
    connected = true;
    const range = MEASURED_RANGES[radio.family]?.[0] || [radio.frequencyInput().min, radio.frequencyInput().max];
    if (!$('start').dataset.touched) $('start').value = range[0];
    if (!$('stop').dataset.touched) $('stop').value = range[1];
    $('gain').max = radio.gainMax;
    $('status').textContent = `${radio.deviceName} · ready`;
  } catch (e) {
    connected = false;
    await radio.run(() => radio.close()).catch(() => {});
    error(e);
  }
  ui();
}
async function disconnect() {
  stop = true;
  while (running) await new Promise((r) => setTimeout(r, 50));
  connected = false;
  await radio.run(() => radio.close()).catch(() => {});
  ui();
}
$('connect').onclick = () => (connected ? disconnect() : connect());
for (const id of ['start', 'stop']) $(id).oninput = () => ($(id).dataset.touched = '1');

function sweepConfig() {
  const rate = radio.rxRates.includes(40000000) ? 40000000 : Math.max(...radio.rxRates.filter((r) => r <= 80000000));
  return {
    rate,
    bits: 8,
    fft: 2048,
    bandwidth: matchedBandwidth(rate, radio.bandwidthRange),
    gainMode: $('agc').checked ? 'HARDWARE' : 'MANUAL',
    gain: Number($('gain').value),
  };
}
async function sweepLoop() {
  const start = Number($('start').value),
    end = Number($('stop').value);
  if (!(end > start)) return error('Stop must be above start.');
  const cfg = sweepConfig(),
    step = Math.max(1, Math.floor(((0.75 * cfg.rate) / 2) / 1e6)),
    keep = [0.6, step + 0.5];
  pano = new Panorama(start, end, { res: 25000, keep, step });
  view = { a: 0, b: 1 };
  wc.fillStyle = '#11191e';
  wc.fillRect(0, 0, water.width, water.height);
  running = true;
  stop = false;
  ui();
  try {
    while (!stop && connected) {
      const t0 = performance.now();
      let done = 0;
      for (const c of pano.windows) {
        if (stop) break;
        if (!radio.validFrequency(c)) continue;
        const f = await radio.capture({ ...cfg, frequency: c });
        pano.add(c, f.spectrum, cfg.rate);
        done++;
        $('status').textContent = `${radio.deviceName} · sweep ${pano.sweeps + 1} · ${c} MHz`;
      }
      if (stop) break;
      const { cur } = pano.endSweep(Number($('average').value), Number($('threshold').value));
      pushWater(cur);
      updatePeaks();
      $('sweepTime').textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s · ${done} windows`;
    }
  } catch (e) {
    error(e);
    if (radio.failed) {
      connected = false;
      await radio.run(() => radio.close()).catch(() => {});
    }
  } finally {
    running = false;
    ui();
  }
}
$('sweep').onclick = () => (running ? (stop = true) : sweepLoop());

// ---- peaks ------------------------------------------------------------------------
function updatePeaks() {
  // Union of average (steady signals) and held consensus (bursty ones).
  const opts = { thresholdDb: Number($('threshold').value), minSepHz: 300e3, max: 40 };
  const a = findPeaks(pano.avg, pano.start, pano.res, opts),
    h = findPeaks(pano.heldConsensus(), pano.start, pano.res, opts);
  const all = [...a.map((p) => ({ ...p, kind: 'steady' }))];
  for (const p of h) if (!all.some((q) => Math.abs(q.hz - p.hz) < 300e3)) all.push({ ...p, kind: 'bursty' });
  for (const p of all) {
    p.activity = pano.activity[p.index];
    p.spur = spurReason(p, p.activity, radio.family, userSpurs);
    p.names = describeFrequency(p.hz, radio.family);
  }
  all.sort((x, y) => (x.spur ? 1 : 0) - (y.spur ? 1 : 0) || y.db - x.db);
  peaks = all.slice(0, Number($('topN').value));
  renderTable();
}
function renderTable() {
  const showSpurs = $('showSpurs').checked,
    rows = peaks.filter((p) => showSpurs || !p.spur);
  $('peaks').innerHTML = rows
    .map((p, i) => {
      const mhz = (p.hz / 1e6).toFixed(3);
      return `<tr class="${p.spur ? 'spur' : ''}">
        <td>${i + 1}</td><td>${mhz}</td><td>${p.db.toFixed(1)}</td><td>${p.snr.toFixed(1)}</td>
        <td>${(p.widthHz / 1e3).toFixed(0)}</td><td>${(100 * p.activity).toFixed(0)} %</td><td>${p.kind}</td>
        <td>${p.spur || p.names.join(' · ') || '—'}</td>
        <td><a href="zoom.html?f=${mhz}">zoom</a> · <a href="doppler.html?f=${mhz}">doppler</a> ·
          <a href="#" data-spur="${mhz}">${userSpurs.some((u) => Math.abs(u - Number(mhz)) < 0.05) ? 'unmark' : 'spur'}</a></td></tr>`;
    })
    .join('');
}
$('peaks').onclick = (e) => {
  const a = e.target.closest('[data-spur]');
  if (!a) return;
  e.preventDefault();
  const f = Number(a.dataset.spur),
    i = userSpurs.findIndex((u) => Math.abs(u - f) < 0.05);
  if (i >= 0) userSpurs.splice(i, 1);
  else userSpurs.push(f);
  try {
    localStorage.setItem(SPUR_KEY, JSON.stringify(userSpurs));
  } catch (err) {}
  if (pano) updatePeaks();
};
for (const id of ['showSpurs', 'topN', 'threshold']) $(id).onchange = () => pano && updatePeaks();

// ---- drawing --------------------------------------------------------------------------
const lut = (t) => {
  t = Math.max(0, Math.min(1, t));
  const stops = [
    [3, 8, 23],
    [38, 63, 153],
    [30, 139, 181],
    [66, 213, 174],
    [217, 237, 103],
    [255, 162, 61],
    [255, 244, 228],
  ];
  const p = t * (stops.length - 1),
    j = Math.min(stops.length - 2, Math.floor(p)),
    u = p - j;
  return stops[j].map((v, k) => Math.round(v * (1 - u) + stops[j + 1][k] * u));
};
function pushWater(lin) {
  const W = water.width,
    H = water.height;
  if (!W || !H) return;
  wc.drawImage(water, 0, 0, W, H - 1, 0, 1, W, H - 1);
  const row = wc.createImageData(W, 1),
    floor = Number($('floor').value),
    range = Number($('range').value),
    cols = columns(lin, W);
  for (let x = 0; x < W; x++) {
    const c = lut((cols[x] - floor) / range);
    row.data.set([c[0], c[1], c[2], 255], 4 * x);
  }
  wc.putImageData(row, 0, 0);
}
function columns(lin, W) {
  const n = lin.length,
    out = new Float32Array(W).fill(-200),
    i0 = view.a * n,
    span = (view.b - view.a) * n;
  for (let x = 0; x < W; x++) {
    let m = NaN;
    const a = Math.floor(i0 + (x / W) * span),
      b = Math.max(a + 1, Math.floor(i0 + ((x + 1) / W) * span));
    for (let k = Math.max(0, a); k < Math.min(n, b); k++) if (!(m >= lin[k])) m = Number.isNaN(lin[k]) ? m : lin[k];
    out[x] = Number.isNaN(m) ? -200 : 10 * Math.log10(m + 1e-20);
  }
  return out;
}
function draw() {
  const d = Math.min(devicePixelRatio || 1, 2),
    W = Math.round(spec.clientWidth * d),
    H = Math.round(spec.clientHeight * d);
  if (spec.width !== W || spec.height !== H) {
    spec.width = W;
    spec.height = H;
  }
  if (water.width !== Math.round(water.clientWidth) || water.height !== Math.round(water.clientHeight)) {
    water.width = Math.round(water.clientWidth);
    water.height = Math.round(water.clientHeight);
  }
  sc.fillStyle = '#182126';
  sc.fillRect(0, 0, W, H);
  sc.font = `${12 * d}px Carlito,sans-serif`;
  const floor = Number($('floor').value),
    range = Number($('range').value),
    y = (v) => Math.max(0, Math.min(H - 18 * d, (1 - (v - floor) / range) * (H - 18 * d)));
  sc.strokeStyle = '#344047';
  sc.fillStyle = '#a1adb2';
  for (let i = 0; i <= 4; i++) {
    const yy = Math.round((i * (H - 18 * d)) / 4) + 0.5;
    sc.beginPath();
    sc.moveTo(0, yy);
    sc.lineTo(W, yy);
    sc.stroke();
    sc.fillText(`${Math.round(floor + range - (i * range) / 4)}`, 6 * d, Math.max(14 * d, yy - 4 * d));
  }
  if (!pano) return requestAnimationFrame(draw);
  const f0 = pano.start + view.a * (pano.stop - pano.start),
    f1 = pano.start + view.b * (pano.stop - pano.start),
    xOf = (hz) => ((hz - f0) / (f1 - f0)) * W;
  const raw = (f1 - f0) / Math.max(2, W / (110 * d)),
    p10 = 10 ** Math.floor(Math.log10(raw)),
    m = raw / p10,
    step = (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p10;
  sc.strokeStyle = '#2a363c';
  for (let f = Math.ceil(f0 / step) * step; f <= f1; f += step) {
    const x = Math.round(xOf(f)) + 0.5;
    sc.beginPath();
    sc.moveTo(x, 0);
    sc.lineTo(x, H - 18 * d);
    sc.stroke();
    sc.fillText((f / 1e6).toFixed(step < 1e6 ? 1 : 0), x + 3 * d, H - 22 * d);
  }
  if ($('bandplan').checked) drawBandPlan(sc, xOf, f0, f1, W, H - 18 * d, d, radio.family);
  for (const [values, color] of [
    [$('hold').checked ? pano.heldConsensus() : null, '#e6b969'],
    [pano.avg, '#37c964'],
  ]) {
    if (!values) continue;
    const cols = columns(values, W);
    sc.beginPath();
    for (let x = 0; x < W; x++) x ? sc.lineTo(x, y(cols[x])) : sc.moveTo(x, y(cols[x]));
    sc.strokeStyle = color;
    sc.lineWidth = 1.2 * d;
    sc.stroke();
  }
  // Activity strip along the bottom.
  const act = columns(Float32Array.from(pano.activity, (a) => 10 ** (a * 6)), W);
  for (let x = 0; x < W; x++) {
    const t = act[x] / 60;
    if (t <= 0) continue;
    sc.fillStyle = `rgba(127,179,221,${Math.min(1, t)})`;
    sc.fillRect(x, H - 14 * d, 1, 12 * d);
  }
  // Peak markers.
  peaks
    .filter((p) => $('showSpurs').checked || !p.spur)
    .forEach((p, i) => {
      const x = xOf(p.hz);
      if (x < 0 || x > W) return;
      sc.fillStyle = p.spur ? '#7a8589' : '#ffcf5a';
      sc.beginPath();
      sc.moveTo(x - 5 * d, y(p.db) - 12 * d);
      sc.lineTo(x + 5 * d, y(p.db) - 12 * d);
      sc.lineTo(x, y(p.db) - 4 * d);
      sc.fill();
      sc.fillText(String(i + 1), x - 3 * d, y(p.db) - 15 * d);
    });
  requestAnimationFrame(draw);
}
spec.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const r = spec.getBoundingClientRect(),
      x = view.a + ((e.clientX - r.left) / r.width) * (view.b - view.a),
      k = e.deltaY > 0 ? 1.25 : 0.8;
    let w = Math.max(0.002, Math.min(1, (view.b - view.a) * k)),
      a = Math.max(0, Math.min(1 - w, x - (x - view.a) * (w / (view.b - view.a))));
    view = { a, b: a + w };
  },
  { passive: false },
);
spec.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, view: { ...view } };
  spec.setPointerCapture(e.pointerId);
});
spec.addEventListener('pointermove', (e) => {
  const r = spec.getBoundingClientRect();
  if (pano) {
    const hz = pano.start + (view.a + ((e.clientX - r.left) / r.width) * (view.b - view.a)) * (pano.stop - pano.start),
      names = describeFrequency(hz, radio.family);
    $('cursor').textContent = `${(hz / 1e6).toFixed(3)} MHz${names.length ? ' · ' + names.join(' · ') : ''}`;
  }
  if (!drag) return;
  const w = drag.view.b - drag.view.a,
    a = Math.max(0, Math.min(1 - w, drag.view.a - ((e.clientX - drag.x) / r.width) * w));
  view = { a, b: a + w };
});
spec.addEventListener('pointerup', () => (drag = null));
spec.addEventListener('dblclick', () => (view = { a: 0, b: 1 }));
$('agc').onchange = () => ($('gain').disabled = $('agc').checked);
for (const id of ['floor', 'range'])
  $(id).oninput = () => ($(`${id}Value`).textContent = `${$(id).value} ${id === 'floor' ? 'dBFS' : 'dB'}`);

(async () => {
  try {
    const ports = await SerialConnection.getPorts();
    if (ports.length === 1) connect(ports[0]);
  } catch (e) {}
})();
ui();
requestAnimationFrame(draw);
