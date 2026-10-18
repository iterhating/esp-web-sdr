'use strict';
// Doppler page: find a carrier, lock onto it, and show the raw spectrum next to
// the extracted Doppler (carrier notched out, or lag/self-mixed), each with a
// spectrogram and a velocity axis. Uses the S3's continuous I/Q stream.
const $ = (id) => document.getElementById(id);
const SEARCH_RATE = 250000,
  SEARCH_N = 65536;
let connected = false,
  running = false,
  restart = false,
  phase = 'idle', // idle | search | track
  centerHz = 2448e6,
  rate = 15625,
  extractor = null,
  info = null;
let raw = null,
  ext = null,
  rawAvg = null,
  extAvg = null,
  lastStats = {};
const q = new URLSearchParams(location.search);
if (q.get('f')) $('target').value = Number(q.get('f')).toFixed(6);

async function reconnectGranted() {
  const ports = (await SerialConnection.getPorts()).filter((p) => (p.getInfo?.() || {}).usbVendorId === 0x303a);
  if (ports.length) await connect(ports[0]);
}
function error(e) {
  const el = $('error');
  if (e && e.flashProfile && window.firmwarePrompt) {
    firmwarePrompt(el, {
      profile: e.flashProfile,
      label: e.flashLabel,
      message: e.message || String(e),
      beforeFlash: async () => {
        await halt();
        connected = false;
        await radio.run(() => radio.close()).catch(() => {});
      },
      afterFlash: reconnectGranted,
    });
    return;
  }
  el.innerHTML = '<span id="errorText"></span>';
  $('errorText').textContent = e?.message || e || '';
  el.hidden = !e;
}
function ui() {
  $('light').classList.toggle('on', connected);
  $('connect').textContent = connected ? 'Disconnect' : 'Connect ESP-SDR';
  for (const id of ['find', 'track', 'stopBtn']) $(id).disabled = !connected;
  $('empty').hidden = connected;
  $('status').textContent = connected ? `${radio.deviceName} · ${phase}` : 'Disconnected';
}
async function connect(port = null) {
  error('');
  try {
    await radio.connect({ port });
    if (radio.family !== 'S3') throw Error('Doppler needs the continuous I/Q stream of an ESP32-S3.');
    if (!radio.hasStream)
      throw Object.assign(
        Error('This board has firmware without the continuous I/Q stream (likely the transmit profile), which Doppler needs.'),
        { flashProfile: 'esp32s3', flashLabel: 'stock ESP32-S3 receiver' },
      );
    connected = true;
  } catch (e) {
    connected = false;
    await radio.run(() => radio.close()).catch(() => {});
    error(e);
  }
  ui();
}
async function halt() {
  restart = true;
  phase = 'idle';
  while (running) await new Promise((r) => setTimeout(r, 30));
  ui();
}
$('connect').onclick = async () => {
  if (connected) {
    await halt();
    connected = false;
    await radio.run(() => radio.close()).catch(() => {});
    ui();
  } else connect();
};

// ---- parameters ---------------------------------------------------------------------
function carrierGHz() {
  return Number($('target').value) / 1e3;
}
function maxDopplerHz() {
  const v = Number($('maxValue').value),
    mono = $('geometry').value === 'mono';
  return $('maxUnit').value === 'hz' ? v : (v * (mono ? 2 : 1) * carrierGHz() * 1e9) / 299792458;
}
// Smallest stream rate that keeps +-max Doppler well inside the band.
function chooseRate() {
  const need = 4 * maxDopplerHz();
  return [15625, 31250, 62500, 125000, 250000].find((r) => r >= need) || 250000;
}
function fftSize(r) {
  const n = 2 ** Math.round(Math.log2(r * Number($('integration').value)));
  return Math.max(256, Math.min(65536, n));
}
function speedOf(fd) {
  return dopplerToSpeed(fd, centerHz, $('geometry').value === 'mono');
}
function paramsText() {
  const r = chooseRate(),
    n = fftSize(r);
  $('derived').textContent =
    `±${maxDopplerHz().toFixed(1)} Hz ≈ ±${Math.abs(speedOf(maxDopplerHz())).toFixed(2)} m/s · stream ${r / 1e3} kS/s · ` +
    `FFT ${n} → ${(r / n).toFixed(2)} Hz (${Math.abs(speedOf(r / n) * 100).toFixed(1)} cm/s) bins`;
}
for (const id of ['maxValue', 'maxUnit', 'geometry', 'integration', 'target']) $(id).oninput = paramsText;

// ---- streaming -----------------------------------------------------------------------------
class Ring {
  constructor(n) {
    this.buf = new Float32Array(2 * n);
    this.w = 0;
    this.n = 0;
    this.since = 0;
  }
  push(iq) {
    for (let j = 0; j < iq.length; j++) {
      this.buf[this.w] = iq[j];
      if (++this.w === this.buf.length) this.w = 0;
    }
    this.n = Math.min(this.buf.length / 2, this.n + iq.length / 2);
    this.since += iq.length / 2;
  }
  // Power spectrum of the newest N samples, fftshifted, Blackman-Harris.
  spectrum(N) {
    const re = new Float64Array(N),
      im = new Float64Array(N);
    let p = (this.w - 2 * N + this.buf.length) % this.buf.length,
      s = 0;
    for (let k = 0; k < N; k++) {
      const x = (2 * Math.PI * k) / (N - 1),
        w = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x);
      re[k] = this.buf[p] * w;
      im[k] = this.buf[p + 1] * w;
      s += w;
      p += 2;
      if (p >= this.buf.length) p = 0;
    }
    fft(re, im);
    const out = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const j = (k + N / 2) % N;
      out[k] = (re[j] * re[j] + im[j] * im[j]) / (s * s);
    }
    this.since = 0;
    return out;
  }
}
async function stream(cfg, onBlock) {
  restart = false;
  running = true;
  try {
    info = await radio.iqStream(
      { centerHz: cfg.centerHz, rate: cfg.rate, bits: 8, shift: Number($('shift').value), gainMode: $('agc').checked ? 'HARDWARE' : 'MANUAL', gain: Number($('gain').value) },
      (iq, header, i) => {
        info = i;
        onBlock(iq, header);
      },
      () => restart || cfg.done?.(),
    );
  } finally {
    running = false;
  }
}
// Step 1: wide look around the target, strongest line wins.
async function findPeak() {
  await halt();
  error('');
  phase = 'search';
  ui();
  const target = Number($('target').value) * 1e6,
    ring = new Ring(SEARCH_N);
  try {
    await stream({ centerHz: target, rate: SEARCH_RATE, done: () => ring.since >= SEARCH_N * 1.2 }, (iq) =>
      ring.push(iq),
    );
    const p = ring.spectrum(SEARCH_N);
    let k = 1;
    for (let i = 1; i < SEARCH_N - 1; i++) if (p[i] > p[k]) k = i;
    const db = (i) => 10 * Math.log10(p[i] + 1e-20),
      frac = interpolatePeak([db(k - 1), db(k), db(k + 1)], 1) - 1 + k,
      f = target + ((frac - SEARCH_N / 2) * SEARCH_RATE) / SEARCH_N;
    const sorted = Array.from(p).sort((a, b) => a - b),
      snr = db(k) - 10 * Math.log10(sorted[SEARCH_N >> 1]);
    $('target').value = (f / 1e6).toFixed(6);
    const spur = spurReason({ hz: f, widthHz: 0 }, 1, 'S3', []);
    $('found').textContent = `${(f / 1e6).toFixed(6)} MHz · ${db(k).toFixed(1)} dBFS · SNR ${snr.toFixed(1)} dB${spur ? ` · ${spur} (the chip's own line: useful to test, not a real echo source)` : ''}`;
    paramsText();
    phase = 'idle';
    ui();
    if ($('autoTrack').checked) track();
  } catch (e) {
    phase = 'idle';
    error(e);
    ui();
  }
}
// Step 2: recentre on the carrier at the Doppler-matched rate and extract.
async function track() {
  await halt();
  error('');
  centerHz = Math.round(Number($('target').value) * 1e6);
  rate = chooseRate();
  const N = fftSize(rate);
  raw = new Ring(N);
  ext = new Ring(N);
  rawAvg = extAvg = null;
  const lagMs = Number($('lag').value);
  extractor = new DopplerExtractor(rate, {
    method: $('method').value,
    trackHz: Number($('trackHz').value),
    loopHz: Number($('trackHz').value),
    lagSamples: Math.max(1, Math.round((lagMs / 1000) * rate)),
  });
  phase = 'track';
  ui();
  paramsText();
  try {
    await stream({ centerHz, rate }, (iq) => {
      raw.push(iq);
      ext.push(extractor.process(iq));
    });
  } catch (e) {
    error(e);
  }
  if (phase === 'track') phase = 'idle';
  ui();
}
$('find').onclick = findPeak;
$('track').onclick = track;
$('stopBtn').onclick = halt;
for (const id of ['method', 'trackHz', 'lag']) $(id).onchange = () => phase === 'track' && track();

// ---- drawing ---------------------------------------------------------------------------------
function panel(specId, waterId, values, avgRef, title, signed) {
  const sp = $(specId),
    wa = $(waterId),
    d = Math.min(devicePixelRatio || 1, 2),
    W = Math.round(sp.clientWidth * d),
    H = Math.round(sp.clientHeight * d);
  if (sp.width !== W || sp.height !== H) {
    sp.width = W;
    sp.height = H;
  }
  if (wa.width !== Math.round(wa.clientWidth) || wa.height !== Math.round(wa.clientHeight)) {
    wa.width = Math.round(wa.clientWidth);
    wa.height = Math.round(wa.clientHeight);
  }
  const g = sp.getContext('2d');
  g.fillStyle = '#182126';
  g.fillRect(0, 0, W, H);
  g.font = `${11 * d}px Carlito,sans-serif`;
  if (!values) return null;
  const N = values.length,
    span = maxDopplerHz() * 1.1,
    binHz = rate / N,
    k0 = Math.max(0, Math.floor(N / 2 - span / binHz)),
    k1 = Math.min(N - 1, Math.ceil(N / 2 + span / binHz)),
    cols = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const a = Math.floor(k0 + (x / W) * (k1 - k0)),
      b = Math.max(a + 1, Math.floor(k0 + ((x + 1) / W) * (k1 - k0)));
    let m = 0;
    for (let k = a; k < b; k++) m = Math.max(m, values[k]);
    cols[x] = 10 * Math.log10(m + 1e-20);
  }
  const sorted = Array.from(cols).sort((a, b) => a - b),
    floor = sorted[Math.floor(W * 0.2)] - 5,
    top = Math.max(sorted[W - 1] + 3, floor + 30),
    y = (v) => (1 - (v - floor) / (top - floor)) * (H - 16 * d);
  // Axis: Hz relative to the carrier, with speed.
  g.strokeStyle = '#2a363c';
  g.fillStyle = '#a1adb2';
  const stepHz = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((s) => (2 * span) / s <= 10) || 10000;
  for (let f = Math.ceil(-span / stepHz) * stepHz; f <= span; f += stepHz) {
    const x = ((f + span) / (2 * span)) * W;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, H - 16 * d);
    g.stroke();
    g.fillText(`${+f.toFixed(2)} Hz / ${speedOf(f).toFixed(2)} m/s`, x + 2 * d, H - 3 * d);
  }
  g.beginPath();
  for (let x = 0; x < W; x++) x ? g.lineTo(x, y(cols[x])) : g.moveTo(x, y(cols[x]));
  g.strokeStyle = signed ? '#e0a040' : '#37c964';
  g.lineWidth = 1.3 * d;
  g.stroke();
  g.fillText(`${title} · ${top.toFixed(0)} dBFS top · ${(top - floor).toFixed(0)} dB range`, 6 * d, 13 * d);
  // Spectrogram row.
  const wc = wa.getContext('2d'),
    WW = wa.width,
    HH = wa.height;
  wc.drawImage(wa, 0, 0, WW, HH - 1, 0, 1, WW, HH - 1);
  const row = wc.createImageData(WW, 1);
  for (let x = 0; x < WW; x++) {
    const t = Math.max(0, Math.min(1, (cols[Math.floor((x * W) / WW)] - floor) / (top - floor))),
      c = [Math.round(255 * Math.min(1, 2 * t)), Math.round(255 * t * t), Math.round(120 * (1 - t) + 40)];
    row.data.set([c[0], c[1], c[2], 255], 4 * x);
  }
  wc.putImageData(row, 0, 0);
  return { cols, span };
}
// Strongest Doppler line outside the carrier notch.
function dopplerPeak(values) {
  const N = values.length,
    binHz = rate / N,
    guard = Math.max(2, Math.ceil((2 * Number($('trackHz').value)) / binHz)),
    lim = Math.ceil(maxDopplerHz() / binHz);
  let best = -1,
    bk = 0;
  for (let k = N / 2 - lim; k <= N / 2 + lim; k++) {
    if (k < 1 || k >= N - 1 || Math.abs(k - N / 2) <= guard) continue;
    if (values[k] > best) {
      best = values[k];
      bk = k;
    }
  }
  return { hz: (bk - N / 2) * binHz, db: 10 * Math.log10(best + 1e-20) };
}
function frame() {
  if (phase === 'track' && raw && raw.n >= raw.buf.length / 2 && raw.since >= Math.max(raw.buf.length / 8, rate / 15)) {
    const a = Number($('average').value),
      r = raw.spectrum(raw.buf.length / 2),
      e = ext.spectrum(ext.buf.length / 2);
    rawAvg = rawAvg ? rawAvg.map((v, i) => a * v + (1 - a) * r[i]) : r;
    extAvg = extAvg ? extAvg.map((v, i) => a * v + (1 - a) * e[i]) : e;
    panel('rawSpec', 'rawWater', rawAvg, null, 'Raw around carrier', false);
    panel('extSpec', 'extWater', extAvg, null, `Doppler · ${$('method').selectedOptions[0].text}`, true);
    const p = dopplerPeak(extAvg);
    lastStats = {
      carrier: centerHz + (extractor.method === 'notch' ? extractor.carrierHz : 0),
      lock: extractor.method === 'notch' ? extractor.locked : null,
      peak: p,
    };
    $('stats').innerHTML = [
      `Carrier <b>${(lastStats.carrier / 1e6).toFixed(7)} MHz</b>`,
      lastStats.lock === null ? '' : `PLL lock <b>${(100 * lastStats.lock).toFixed(0)} %</b>`,
      `Doppler peak <b>${p.hz.toFixed(2)} Hz · ${speedOf(p.hz).toFixed(3)} m/s · ${p.db.toFixed(1)} dBFS</b>`,
      `Stream <b>${rate / 1e3} kS/s</b> · lost <b>${info?.lostSamples ?? 0}</b> · CRC <b>${info?.crcErrors ?? 0}</b>`,
    ]
      .filter(Boolean)
      .map((s) => `<span>${s}</span>`)
      .join('');
  }
  requestAnimationFrame(frame);
}
$('agc').onchange = () => ($('gain').disabled = $('agc').checked);
$('maxUnit').onchange = paramsText;
(async () => {
  try {
    const ports = (await SerialConnection.getPorts()).filter((p) => p.getInfo?.().usbVendorId === 0x303a);
    if (ports.length === 1) connect(ports[0]);
  } catch (e) {}
})();
paramsText();
ui();
requestAnimationFrame(frame);
