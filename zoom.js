'use strict';
// Continuous-I/Q page: long FFTs for fine frequency resolution, a tunable
// channel with audio demodulation, and SigMF recording. Talks to the radio
// through BurstSerialRadio.iqStream (iqstream.js).
const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'espSdrZoom';
const HISTORY = 65536; // complex samples kept for the FFT
const ENBW = 2.0; // Blackman-Harris equivalent noise bandwidth, bins

const settings = {
  centerHz: 2448e6,
  rate: 250000,
  bits: 8,
  shift: 4,
  agc: true,
  gain: 54,
  fft: 16384,
  average: 0.5,
  floor: -110,
  range: 80,
  mode: 'off',
  bandwidth: 12500,
  squelch: -140,
  volume: 50,
};
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
} catch (e) {}
// Links from the survey table open a signal directly: zoom.html?f=<MHz>.
const linked = Number(new URLSearchParams(location.search).get('f'));
if (linked > 0) settings.centerHz = Math.round(linked * 1e6);
function save() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {}
}
function ppm() {
  try {
    return Number(localStorage.getItem('espSdrPpm')) || 0;
  } catch (e) {
    return 0;
  }
}

let connected = false,
  running = false,
  paused = false,
  restart = false,
  info = null;
let hist = new Float32Array(2 * HISTORY),
  histW = 0,
  histN = 0,
  sinceFFT = 0;
let avg = null,
  hold = null,
  view = { a: 0, b: 1 },
  vfo = 0,
  drag = null,
  lastPeak = null;
let demod = null,
  audio = null,
  player = null;
let rec = null;
let fftCount = 0,
  fftClock = performance.now(),
  sampleClock = { t: performance.now(), n: 0, rate: 0 },
  received = 0;

const spec = $('spectrum'),
  water = $('waterfall'),
  sc = spec.getContext('2d'),
  wc = water.getContext('2d');
const lut = Array.from({ length: 256 }, (_, i) => {
  const stops = [
    [3, 8, 23],
    [18, 31, 81],
    [38, 63, 153],
    [30, 139, 181],
    [66, 213, 174],
    [217, 237, 103],
    [255, 162, 61],
    [255, 244, 228],
  ];
  const p = (i / 255) * (stops.length - 1),
    j = Math.min(stops.length - 2, Math.floor(p)),
    t = p - j;
  return stops[j].map((v, k) => Math.round(v * (1 - t) + stops[j + 1][k] * t));
});

// ---- controls ---------------------------------------------------------------
function syncControls() {
  $('frequencyHz').value = (settings.centerHz / 1e6).toFixed(6);
  $('rate').value = String(settings.rate);
  $('bits').value = String(settings.bits);
  $('shift').value = settings.shift;
  $('shiftValue').textContent = settings.shift;
  $('agc').checked = settings.agc;
  $('gain').value = settings.gain;
  $('gain').disabled = settings.agc;
  $('gainValue').textContent = settings.gain;
  $('fft').value = String(settings.fft);
  $('average').value = String(settings.average);
  $('floor').value = settings.floor;
  $('floorValue').textContent = `${settings.floor} dBFS`;
  $('range').value = settings.range;
  $('rangeValue').textContent = `${settings.range} dB`;
  $('mode').value = settings.mode;
  $('bandwidth').value = settings.bandwidth;
  $('squelch').value = settings.squelch;
  $('squelchValue').textContent = settings.squelch <= -140 ? 'off' : `${settings.squelch} dBFS`;
  $('volume').value = settings.volume;
  $('volumeValue').textContent = `${settings.volume} %`;
  $('scale').textContent = `${settings.floor} → ${settings.floor + settings.range} dBFS`;
}
function retune(hz) {
  settings.centerHz = Math.round(hz);
  save();
  syncControls();
  restartStream();
}
function restartStream() {
  restart = true;
  clearHistory();
}
function clearHistory() {
  histN = 0;
  sinceFFT = 0;
  avg = null;
  hold = null;
}
$('frequencyHz').onchange = () => retune(Number($('frequencyHz').value) * 1e6);
for (const b of document.querySelectorAll('[data-step]'))
  b.onclick = () => retune(settings.centerHz + Number(b.dataset.step));
for (const [id, key, restartNeeded] of [
  ['rate', 'rate', true],
  ['bits', 'bits', true],
  ['fft', 'fft', false],
  ['average', 'average', false],
])
  $(id).onchange = () => {
    settings[key] = Number($(id).value);
    if (key === 'rate') view = { a: 0, b: 1 };
    save();
    syncControls();
    if (restartNeeded) restartStream();
    else clearHistory();
    if (key === 'rate') configureDemod();
  };
$('shift').oninput = () => {
  settings.shift = Number($('shift').value);
  syncControls();
};
$('shift').onchange = () => {
  save();
  restartStream();
};
$('agc').onchange = () => {
  settings.agc = $('agc').checked;
  save();
  syncControls();
  restartStream();
};
$('gain').oninput = () => {
  settings.gain = Number($('gain').value);
  syncControls();
};
$('gain').onchange = () => {
  save();
  restartStream();
};
for (const id of ['floor', 'range'])
  $(id).oninput = () => {
    settings[id] = Number($(id).value);
    save();
    syncControls();
  };
$('hold').onchange = () => (hold = null);
$('mode').onchange = () => {
  settings.mode = $('mode').value;
  if (settings.mode !== 'off') settings.bandwidth = DEMOD_DEFAULTS[settings.mode].bandwidth;
  save();
  syncControls();
  configureDemod();
};
$('bandwidth').onchange = () => {
  settings.bandwidth = Number($('bandwidth').value);
  save();
  configureDemod();
};
$('squelch').oninput = () => {
  settings.squelch = Number($('squelch').value);
  save();
  syncControls();
  if (demod) demod.squelch = settings.squelch <= -140 ? -200 : settings.squelch;
};
$('volume').oninput = () => {
  settings.volume = Number($('volume').value);
  save();
  syncControls();
  player?.port.postMessage(settings.volume / 100);
};

// ---- audio -----------------------------------------------------------------
async function configureDemod() {
  if (settings.mode === 'off' || !connected) {
    demod = null;
    if (audio) await audio.close().catch(() => {});
    audio = player = null;
    return;
  }
  const d = new Demodulator(settings.rate, {
    mode: settings.mode,
    offset: vfo,
    bandwidth: settings.bandwidth,
    squelch: settings.squelch <= -140 ? -200 : settings.squelch,
  });
  if (!audio || audio.sampleRate !== d.audioRate) {
    if (audio) await audio.close().catch(() => {});
    audio = new AudioContext({ sampleRate: d.audioRate });
    await audio.audioWorklet.addModule('audio-worklet.js');
    player = new AudioWorkletNode(audio, 'stream-player', { outputChannelCount: [2] });
    player.connect(audio.destination);
    player.port.postMessage(settings.volume / 100);
  }
  await audio.resume();
  demod = d;
}
function setVfo(offset) {
  vfo = Math.max(-settings.rate / 2, Math.min(settings.rate / 2, offset));
  if (demod) {
    demod.offset = vfo;
  }
}

// ---- recording (SigMF archive: a tar holding .sigmf-meta and .sigmf-data) ----
function tarEntry(name, bytes) {
  const h = new Uint8Array(512),
    put = (s, off) => {
      for (let i = 0; i < s.length; i++) h[off + i] = s.charCodeAt(i);
    };
  put(name, 0);
  put('0000644\0', 100);
  put('0000000\0', 108);
  put('0000000\0', 116);
  put(bytes.byteLength.toString(8).padStart(11, '0') + '\0', 124);
  put(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
  put('        ', 148);
  put('0', 156);
  put('ustar\0', 257);
  put('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = new Uint8Array((512 - (bytes.byteLength % 512)) % 512);
  return [h, bytes, pad];
}
function startRecording() {
  rec = {
    chunks: [],
    samples: 0,
    gaps: 0,
    centerHz: settings.centerHz,
    rate: settings.rate,
    start: new Date(),
    max: settings.rate * 120,
  };
  $('record').classList.add('active');
  $('record').textContent = 'Stop recording';
}
function stopRecording() {
  if (!rec) return;
  const r = rec;
  rec = null;
  $('record').classList.remove('active');
  $('record').textContent = 'Record I/Q';
  if (!r.samples) return;
  const stamp = r.start.toISOString().replace(/[:.]/g, '-'),
    base = `esp-sdr_${(r.centerHz / 1e6).toFixed(6)}MHz_${r.rate}sps_${stamp}`;
  const meta = sigmfMeta({
    rate: r.rate,
    centerHz: r.centerHz * (1 + ppm() * 1e-6),
    datetime: r.start.toISOString(),
    description: `${r.samples} samples${r.gaps ? `, ${r.gaps} lost samples zero-filled` : ''}`,
    gain: settings.agc ? 'hardware AGC' : `manual index ${settings.gain}`,
  });
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta, null, 2));
  const data = new Blob(r.chunks);
  data.arrayBuffer().then((buf) => {
    const parts = [
      ...tarEntry(`${base}/${base}.sigmf-meta`, metaBytes),
      ...tarEntry(`${base}/${base}.sigmf-data`, new Uint8Array(buf)),
      new Uint8Array(1024),
    ];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(parts, { type: 'application/x-tar' }));
    a.download = `${base}.sigmf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    $('recordNote').textContent =
      `Saved ${(r.samples / r.rate).toFixed(1)} s (${(buf.byteLength / 1e6).toFixed(1)} MB) as ${a.download}`;
  });
}
$('record').onclick = () => (rec ? stopRecording() : startRecording());

// ---- stream -------------------------------------------------------------------
function onBlock(iq, header, streamInfo) {
  info = streamInfo;
  const n = iq.length / 2;
  received += n;
  for (let j = 0; j < iq.length; j++) {
    hist[histW] = iq[j];
    if (++histW === hist.length) histW = 0;
  }
  histN = Math.min(HISTORY, histN + n);
  sinceFFT += n;
  if (demod) {
    const a = demod.process(iq);
    if (a.length) player?.port.postMessage(a, [a.buffer]);
  }
  if (rec) {
    if (header.gap) {
      const fill = Math.min(header.gap, rec.max - rec.samples);
      rec.chunks.push(new Float32Array(2 * fill));
      rec.samples += fill;
      rec.gaps += fill;
    }
    rec.chunks.push(iq);
    rec.samples += n;
    if (rec.samples >= rec.max) stopRecording();
  }
}
async function streamLoop() {
  if (running) return;
  running = true;
  ui();
  try {
    while (connected && !paused) {
      restart = false;
      clearHistory();
      await radio.iqStream(
        {
          centerHz: settings.centerHz,
          rate: settings.rate,
          bits: settings.bits,
          shift: settings.bits === 16 ? 0 : settings.shift,
          gainMode: settings.agc ? 'HARDWARE' : 'MANUAL',
          gain: settings.gain,
        },
        onBlock,
        () => restart || paused || !connected,
      );
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

// ---- connection -------------------------------------------------------------
function error(e) {
  $('errorText').textContent = e?.message || e || '';
  $('error').hidden = !e;
}
function ui() {
  $('light').classList.toggle('on', connected);
  $('status').textContent = connected
    ? `${radio.deviceName || 'ESP-SDR'} · ${running ? (paused ? 'paused' : 'streaming') : 'idle'}`
    : 'Disconnected';
  $('connect').textContent = connected ? 'Disconnect' : 'Connect ESP-SDR';
  $('pause').disabled = !connected;
  $('pause').textContent = paused ? 'Resume' : 'Pause';
  $('record').disabled = !connected || !running;
  $('empty').hidden = connected;
}
async function connect(port = null) {
  error('');
  $('status').textContent = 'Connecting…';
  try {
    await radio.connect({ port });
    if (radio.family !== 'S3')
      throw Error(`Continuous I/Q needs an ESP32-S3 on native USB; this board is ${radio.deviceName || 'unknown'}.`);
    if (!radio.hasStream)
      throw Error('This firmware cannot stream continuous I/Q. Flash the stock "ESP32-S3" profile (the transmit profile does not support zoom or Doppler).');
    connected = true;
    paused = false;
    configureDemod();
    streamLoop();
  } catch (e) {
    connected = false;
    await radio.run(() => radio.close()).catch(() => {});
    error(e);
  }
  ui();
}
async function disconnect() {
  connected = false;
  stopRecording();
  while (running) await new Promise((r) => setTimeout(r, 50));
  await radio.run(() => radio.close()).catch(() => {});
  configureDemod();
  ui();
}
$('connect').onclick = () => (connected ? disconnect() : connect());
$('pause').onclick = () => {
  paused = !paused;
  if (!paused) streamLoop();
  ui();
};
// Reconnect to a previously granted native S3 port without a picker.
(async () => {
  try {
    const ports = (await SerialConnection.getPorts()).filter((p) => p.getInfo?.().usbVendorId === 0x303a);
    if (ports.length === 1) connect(ports[0]);
  } catch (e) {}
})();

// ---- spectrum ------------------------------------------------------------------
let re = null,
  im = null,
  win = null;
function computeSpectrum(N) {
  if (!re || re.length !== N) {
    re = new Float64Array(N);
    im = new Float64Array(N);
    win = new Float64Array(N);
    let s = 0;
    for (let k = 0; k < N; k++) {
      const x = (2 * Math.PI * k) / (N - 1);
      win[k] = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x);
      s += win[k];
    }
    win.norm = s * s;
  }
  let p = (histW - 2 * N + hist.length) % hist.length;
  for (let k = 0; k < N; k++) {
    re[k] = hist[p] * win[k];
    im[k] = hist[p + 1] * win[k];
    p += 2;
    if (p >= hist.length) p = 0;
  }
  fft(re, im);
  const out = new Float32Array(N),
    a = settings.average;
  for (let k = 0; k < N; k++) {
    const j = (k + N / 2) % N,
      lin = (re[j] * re[j] + im[j] * im[j]) / win.norm;
    out[k] = lin;
  }
  if (!avg || avg.length !== N) avg = out.slice();
  else for (let k = 0; k < N; k++) avg[k] = a * avg[k] + (1 - a) * out[k];
  if ($('hold').checked) {
    if (!hold || hold.length !== N) hold = out.slice();
    else for (let k = 0; k < N; k++) hold[k] = Math.max(hold[k], out[k]);
  }
  pushWaterRow(out);
  fftCount++;
}
// Absolute (ppm-corrected) frequency of a fractional position across the span.
function hzAt(frac) {
  return (settings.centerHz + (frac - 0.5) * settings.rate) * (1 + ppm() * 1e-6);
}
function viewFrac(clientX) {
  const r = spec.getBoundingClientRect();
  return view.a + ((clientX - r.left) / r.width) * (view.b - view.a);
}
// Max over the bins that fall in each pixel so narrow lines survive zoom-out.
function pixelColumns(values, W) {
  const N = values.length,
    cols = new Float32Array(W),
    i0 = view.a * N,
    span = (view.b - view.a) * N;
  for (let x = 0; x < W; x++) {
    const a = Math.floor(i0 + (x / W) * span),
      b = Math.max(a + 1, Math.floor(i0 + ((x + 1) / W) * span));
    let m = 0;
    for (let k = Math.max(0, a); k < Math.min(N, b); k++) if (values[k] > m) m = values[k];
    cols[x] = 10 * Math.log10(m + 1e-20);
  }
  return cols;
}
function pushWaterRow(lin) {
  const W = water.width,
    H = water.height;
  if (!W || !H) return;
  wc.drawImage(water, 0, 0, W, H - 1, 0, 1, W, H - 1);
  const cols = pixelColumns(lin, W),
    row = wc.createImageData(W, 1);
  for (let x = 0; x < W; x++) {
    const t = Math.max(0, Math.min(255, Math.round(((cols[x] - settings.floor) / settings.range) * 255))),
      c = lut[t];
    row.data.set([c[0], c[1], c[2], 255], 4 * x);
  }
  wc.putImageData(row, 0, 0);
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
    wc.fillStyle = '#11191e';
    wc.fillRect(0, 0, water.width, water.height);
  }
  sc.fillStyle = '#182126';
  sc.fillRect(0, 0, W, H);
  sc.font = `${12 * d}px Carlito,sans-serif`;
  const floor = settings.floor,
    range = settings.range,
    y = (v) => Math.max(0, Math.min(H, (1 - (v - floor) / range) * H));
  // Level grid.
  sc.strokeStyle = '#344047';
  sc.fillStyle = '#a1adb2';
  sc.lineWidth = d;
  for (let i = 0; i <= 4; i++) {
    const yy = Math.round((i * H) / 4) + 0.5;
    sc.beginPath();
    sc.moveTo(0, yy);
    sc.lineTo(W, yy);
    sc.stroke();
    sc.fillText(`${Math.round(floor + range - (i * range) / 4)}`, 6 * d, Math.max(14 * d, yy - 4 * d));
  }
  // Frequency grid with 1-2-5 steps, labelled in MHz with enough decimals.
  const f0 = hzAt(view.a),
    f1 = hzAt(view.b),
    xOf = (hz) => ((hz - f0) / (f1 - f0)) * W;
  const raw = (f1 - f0) / Math.max(2, W / (110 * d)),
    p10 = 10 ** Math.floor(Math.log10(raw)),
    m = raw / p10,
    step = (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p10,
    dec = Math.max(0, Math.ceil(6 - Math.log10(step) - 1e-9));
  sc.strokeStyle = '#2a363c';
  for (let f = Math.ceil(f0 / step) * step; f <= f1; f += step) {
    const x = Math.round(xOf(f)) + 0.5;
    sc.beginPath();
    sc.moveTo(x, 0);
    sc.lineTo(x, H);
    sc.stroke();
    sc.fillText((f / 1e6).toFixed(Math.min(6, dec)), x + 3 * d, H - 4 * d);
  }
  if ($('bandplan').checked) drawBandPlan(sc, xOf, f0, f1, W, H, d, 'S3');
  // Demodulator channel.
  if (settings.mode !== 'off') {
    const c = hzAt(0.5 + vfo / settings.rate),
      bw = settings.bandwidth,
      lo = settings.mode === 'USB' ? c : settings.mode === 'LSB' ? c - bw : c - bw / 2,
      hi = settings.mode === 'USB' ? c + bw : settings.mode === 'LSB' ? c : c + bw / 2;
    sc.fillStyle = '#e0a04024';
    sc.fillRect(xOf(lo), 0, Math.max(d, xOf(hi) - xOf(lo)), H);
    sc.strokeStyle = '#e0a040';
    sc.beginPath();
    sc.moveTo(Math.round(xOf(c)) + 0.5, 0);
    sc.lineTo(Math.round(xOf(c)) + 0.5, H);
    sc.stroke();
  }
  for (const [values, color, fill] of [
    [$('hold').checked ? hold : null, '#e6b969', false],
    [avg, '#37c964', true],
  ]) {
    if (!values) continue;
    const cols = pixelColumns(values, W);
    sc.beginPath();
    for (let x = 0; x < W; x++) x ? sc.lineTo(x, y(cols[x])) : sc.moveTo(x, y(cols[x]));
    sc.strokeStyle = color;
    sc.lineWidth = 1.2 * d;
    sc.stroke();
    if (fill) {
      sc.lineTo(W, H);
      sc.lineTo(0, H);
      sc.closePath();
      sc.fillStyle = '#37c96422';
      sc.fill();
    }
  }
  readout(f0, f1);
}
function readout(f0, f1) {
  const N = avg ? avg.length : settings.fft,
    rbw = (ENBW * settings.rate) / N;
  let peak = '—',
    floor = '—';
  if (avg) {
    const i0 = Math.max(1, Math.floor(view.a * N)),
      i1 = Math.min(N - 2, Math.ceil(view.b * N));
    let k = i0;
    for (let i = i0; i <= i1; i++) if (avg[i] > avg[k]) k = i;
    const db = (i) => 10 * Math.log10(avg[i] + 1e-20),
      frac = interpolatePeak([db(k - 1), db(k), db(k + 1)], 1) - 1 + k;
    lastPeak = hzAt(frac / N);
    peak = `${(lastPeak / 1e6).toFixed(7)} MHz · ${db(k).toFixed(1)} dBFS`;
    const vis = Array.from(avg.subarray(i0, i1 + 1)).sort((a, b) => a - b);
    floor = `${(10 * Math.log10(vis[Math.floor(vis.length / 2)] / rbw + 1e-30)).toFixed(1)} dBFS/Hz`;
  }
  const item = (k, v) => `<span>${k} <b>${v}</b></span>`;
  const t = iqsTuning(settings.centerHz);
  $('readout').innerHTML = [
    item('Center', `${(settings.centerHz / 1e6).toFixed(6)} MHz`),
    item('View', `${((f1 - f0) / 1e3).toFixed(f1 - f0 < 1e4 ? 2 : 1)} kHz`),
    item('RBW', rbw < 10 ? `${rbw.toFixed(2)} Hz` : `${rbw.toFixed(1)} Hz`),
    item('FFT', `${N} · ${((N / settings.rate) * 1e3).toFixed(0)} ms`),
    item('Peak', peak),
    item('Noise', floor),
    item('LO', `${t.mhz} MHz ${t.khz >= 0 ? '+' : ''}${t.khz} kHz`),
  ].join('');
  const now = performance.now();
  if (now - fftClock > 1000) {
    $('fps').textContent = ((fftCount * 1000) / (now - fftClock)).toFixed(1);
    $('delivered').textContent = (((received - sampleClock.n) / (now - sampleClock.t)) | 0).toString();
    sampleClock = { t: now, n: received };
    fftCount = 0;
    fftClock = now;
    $('lost').textContent = info ? String(info.lostSamples) : '—';
    $('crc').textContent = info ? String(info.crcErrors) : '—';
    $('level').textContent = demod ? demod.level.toFixed(1) : '—';
  }
}
function frame() {
  const N = settings.fft;
  if (histN >= N && sinceFFT >= Math.max(N / 4, settings.rate / 30)) {
    sinceFFT = 0;
    computeSpectrum(N);
  }
  draw();
  requestAnimationFrame(frame);
}

// ---- spectrum interaction: wheel zoom, drag pan, click channel, dblclick recentre
spec.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const x = viewFrac(e.clientX),
      k = e.deltaY > 0 ? 1.25 : 0.8,
      minW = 16 / settings.fft;
    let w = Math.max(minW, Math.min(1, (view.b - view.a) * k)),
      a = x - (x - view.a) * (w / (view.b - view.a));
    a = Math.max(0, Math.min(1 - w, a));
    view = { a, b: a + w };
  },
  { passive: false },
);
spec.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, view: { ...view }, moved: false };
  spec.setPointerCapture(e.pointerId);
});
spec.addEventListener('pointermove', (e) => {
  const f = hzAt(viewFrac(e.clientX)),
    names = $('bandplan').checked ? describeFrequency(f, 'S3') : [];
  $('cursor').textContent = `${(f / 1e6).toFixed(6)} MHz${names.length ? ' · ' + names.join(' · ') : ''}`;
  if (!drag) return;
  const r = spec.getBoundingClientRect(),
    dx = ((e.clientX - drag.x) / r.width) * (drag.view.b - drag.view.a);
  if (Math.abs(e.clientX - drag.x) > 3) drag.moved = true;
  const w = drag.view.b - drag.view.a,
    a = Math.max(0, Math.min(1 - w, drag.view.a - dx));
  view = { a, b: a + w };
});
spec.addEventListener('pointerup', (e) => {
  const moved = drag?.moved;
  drag = null;
  if (moved) return;
  setVfo((viewFrac(e.clientX) - 0.5) * settings.rate);
});
spec.addEventListener('dblclick', (e) => {
  const f = settings.centerHz + (viewFrac(e.clientX) - 0.5) * settings.rate;
  view = { a: 0, b: 1 };
  setVfo(0);
  retune(f);
});

syncControls();
ui();
requestAnimationFrame(frame);
