'use strict';
// Transmit control: synthesize a test waveform, preview its spectrum, and drive
// the ESP-SDR fork's CW / REPLAY16 path with a kept-alive lease. Emissions are
// generic test signals (tones, chirp, noise, QPSK) and a CW carrier; nothing
// here imitates a real device or network.
const $ = (id) => document.getElementById(id);
let connected = false,
  session = null,
  elapsedTimer = null,
  waveform = null;

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
  const tx = !!session?.active;
  $('transmit').disabled = !connected || !$('ack').checked || tx;
  $('stopTx').disabled = !tx;
  $('status').textContent = connected ? `${radio.deviceName}${tx ? ' · TRANSMITTING' : ' · ready'}` : 'Disconnected';
  $('status').style.color = tx ? '#ff7a5c' : '';
}
async function connect(port = null) {
  error('');
  try {
    await radio.connect({ port });
    if (!radio.hasCw && !radio.hasReplay)
      throw Object.assign(
        Error(`This board (${radio.deviceName}) is running receive-only firmware; transmit needs the TX profile.`),
        { flashProfile: 'esp32s3-tx', flashLabel: 'ESP32-S3 experimental transmit' },
      );
    connected = true;
  } catch (e) {
    connected = false;
    await radio.run(() => radio.close()).catch(() => {});
    error(e);
  }
  ui();
}
async function disconnect() {
  await stopTx();
  connected = false;
  await radio.run(() => radio.close()).catch(() => {});
  ui();
}
$('connect').onclick = () => (connected ? disconnect() : connect());
$('ack').onchange = ui;

// ---- waveform build + preview -------------------------------------------------------
function buildWaveform() {
  const rate = Number($('rate').value),
    amp = Number($('amp').value) / 100,
    type = $('type').value;
  const nPow2 = (x) => 2 ** Math.round(Math.log2(Math.max(256, Math.min(16384, x))));
  switch (type) {
    case 'cw':
      return null; // handled by CW START
    case 'tone':
      return toneWaveform(rate, 4096, Number($('p1').value) * 1e6, amp);
    case 'twotone':
      return twoToneWaveform(rate, 8192, Number($('p1').value) * 1e6, Number($('p2').value) * 1e6, amp * 0.6);
    case 'chirp':
      return chirpWaveform(rate, 16380, Number($('p1').value) * 1e6, amp);
    case 'noise':
      return noiseWaveform(rate, nPow2(16384), Number($('p1').value) * 1e6, amp * 0.7);
    case 'qpsk':
      return qpskWaveform(rate, 16000, Number($('p1').value) * 1e6, 0.35, amp);
  }
}
function previewSpectrum() {
  const c = $('preview'),
    d = Math.min(devicePixelRatio || 1, 2),
    W = Math.round(c.clientWidth * d),
    H = Math.round(c.clientHeight * d);
  if (c.width !== W || c.height !== H) {
    c.width = W;
    c.height = H;
  }
  const g = c.getContext('2d');
  g.fillStyle = '#182126';
  g.fillRect(0, 0, W, H);
  g.font = `${11 * d}px Carlito,sans-serif`;
  const rate = Number($('rate').value),
    center = Number($('freq').value);
  if ($('type').value === 'cw') {
    g.fillStyle = '#e0a040';
    g.fillRect(W / 2 - d, 0, 2 * d, H);
    g.fillStyle = '#c0c9cd';
    g.fillText(`CW carrier at ${center.toFixed(3)} MHz`, 6 * d, 14 * d);
    return;
  }
  if (!waveform) return;
  const N = 2 ** Math.floor(Math.log2(waveform.n)),
    re = new Float64Array(N),
    im = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (N - 1));
    re[k] = (waveform.iq[2 * k] / 127) * w;
    im[k] = (waveform.iq[2 * k + 1] / 127) * w;
  }
  fft(re, im);
  const db = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    const j = (k + N / 2) % N;
    db[k] = 10 * Math.log10(re[j] ** 2 + im[j] ** 2 + 1e-12);
  }
  const top = Math.max(...db),
    floor = top - 70;
  g.strokeStyle = '#37c964';
  g.lineWidth = 1.2 * d;
  g.beginPath();
  for (let x = 0; x < W; x++) {
    const k = Math.floor((x / W) * N),
      y = (1 - (db[k] - floor) / (top - floor)) * (H - 16 * d);
    x ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();
  g.fillStyle = '#c0c9cd';
  const bw = $('type').value === 'tone' ? '' : ` · occ ~${(((waveform.actualHz?.length ? 2 * Math.max(...waveform.actualHz.map(Math.abs)) : waveform.actualHz) || 0) / 1e6).toFixed(1)} MHz`;
  g.fillText(`${center.toFixed(3)} MHz ± ${(rate / 2e6).toFixed(0)} MHz · ${waveform.n} samples @ ${rate / 1e6} MS/s${bw}`, 6 * d, 14 * d);
}
function refresh() {
  try {
    waveform = buildWaveform();
    error('');
  } catch (e) {
    waveform = null;
    error(e);
  }
  previewSpectrum();
}
function showParams() {
  const t = $('type').value,
    spec = {
      cw: [],
      tone: [['Offset from center (MHz)', 'p1', 2]],
      twotone: [['Tone 1 (MHz)', 'p1', -2], ['Tone 2 (MHz)', 'p2', 2]],
      chirp: [['Sweep width (MHz)', 'p1', 20]],
      noise: [['Bandwidth (MHz)', 'p1', 20]],
      qpsk: [['Symbol rate (MHz)', 'p1', 2]],
    }[t];
  $('p1row').hidden = spec.length < 1;
  $('p2row').hidden = spec.length < 2;
  spec.forEach(([label, id, def], i) => {
    $(`${id}label`).textContent = label;
    if ($(id).dataset.type !== t) {
      $(id).value = def;
      $(id).dataset.type = t;
    }
  });
  refresh();
}
for (const id of ['type']) $(id).onchange = showParams;
for (const id of ['p1', 'p2', 'rate', 'amp', 'freq']) {
  $(id).oninput = () => {
    if (id === 'amp') $('ampValue').textContent = `${$('amp').value} %`;
    refresh();
  };
}

// ---- transmit ---------------------------------------------------------------------------
async function transmit() {
  if (!connected || session?.active) return;
  error('');
  session = new TxSession(radio, {
    onTick: (s) => ($('elapsed').textContent = `${s.toFixed(0)} s (lease renewed)`),
    onError: (e) => {
      error(e);
      ui();
    },
  });
  const freq = Number($('freq').value);
  try {
    if ($('type').value === 'cw') await session.startCW(freq);
    else {
      if (!waveform) throw Error('No waveform.');
      await session.startWaveform(freq, waveform);
    }
    const start = performance.now(),
      maxS = Number($('maxDuration').value);
    elapsedTimer = setInterval(() => {
      const s = (performance.now() - start) / 1000;
      $('elapsed').textContent = `${s.toFixed(0)} s`;
      if (s >= maxS) stopTx();
    }, 250);
  } catch (e) {
    error(e);
    session = null;
  }
  ui();
}
async function stopTx() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
  if (session) await session.stop().catch(() => {});
  session = null;
  $('elapsed').textContent = 'stopped';
  ui();
}
$('transmit').onclick = transmit;
$('stopTx').onclick = stopTx;
window.addEventListener('beforeunload', () => session?.active && navigator.sendBeacon && stopTx());

(async () => {
  try {
    const ports = (await SerialConnection.getPorts()).filter((p) => p.getInfo?.().usbVendorId === 0x303a);
    if (ports.length === 1) await connect(ports[0]);
  } catch (e) {}
  showParams();
})();
ui();
setInterval(previewSpectrum, 500);
