'use strict';
// Wi-Fi CSI viewer for the csi-firmware build: parses esp-csi CSV lines from
// the USB serial port and shows per-subcarrier amplitude/phase, a heatmap, a
// motion index and an amplitude-fluctuation (Doppler-like) spectrum.

// ---- parsing (pure; tested) ---------------------------------------------------
const CSI_FIELDS = [
  'seq', 'mac', 'rssi', 'rate', 'sigMode', 'mcs', 'cwb', 'smoothing', 'notSounding', 'aggregation', 'stbc',
  'fec', 'sgi', 'noiseFloor', 'ampduCnt', 'channel', 'secondaryChannel', 'timestamp', 'ant', 'sigLen',
  'rxState', 'len', 'firstInvalid',
];
function parseCsiLine(line) {
  if (!line.startsWith('CSI_DATA,')) return null;
  const q = line.indexOf('"[');
  if (q < 0 || !line.endsWith(']"')) return null;
  const head = line.slice(9, q - 1).split(',');
  if (head.length !== CSI_FIELDS.length) return null;
  const rec = {};
  CSI_FIELDS.forEach((k, i) => (rec[k] = k === 'mac' ? head[i] : Number(head[i])));
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(rec.mac)) return null;
  const data = line.slice(q + 2, -2).split(',').map(Number);
  if (data.length !== rec.len || data.some((v) => !Number.isInteger(v) || v < -128 || v > 127)) return null;
  rec.data = Int8Array.from(data);
  return rec;
}
// LLTF: 64 sub-carriers stored as (imag, real) pairs in FFT order 0..31, -32..-1.
// Returns amplitude and phase ordered -32..31; first word may be invalid.
const LLTF_VALID = Array.from({ length: 64 }, (_, i) => i - 32).filter((s) => s !== 0 && Math.abs(s) <= 26);
function lltf(rec) {
  const amp = new Float32Array(64),
    phase = new Float32Array(64);
  for (let s = -32; s < 32; s++) {
    const k = (s + 64) % 64,
      im = rec.data[2 * k],
      re = rec.data[2 * k + 1];
    if (2 * k + 1 >= rec.data.length || (rec.firstInvalid && k < 2)) continue;
    amp[s + 32] = Math.hypot(re, im);
    phase[s + 32] = Math.atan2(im, re);
  }
  return { amp, phase };
}
// Remove the per-packet linear phase (timing offset) and constant (CFO, PLL)
// over the valid sub-carriers after unwrapping across frequency.
function sanitizePhase(phase) {
  const idx = LLTF_VALID,
    un = new Float32Array(64);
  let prev = phase[idx[0] + 32],
    acc = prev;
  un[idx[0] + 32] = acc;
  for (let j = 1; j < idx.length; j++) {
    let d = phase[idx[j] + 32] - prev;
    d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
    acc += d;
    prev = phase[idx[j] + 32];
    un[idx[j] + 32] = acc;
  }
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (const s of idx) {
    sx += s;
    sy += un[s + 32];
    sxx += s * s;
    sxy += s * un[s + 32];
  }
  const n = idx.length,
    slope = (n * sxy - sx * sy) / (n * sxx - sx * sx),
    offset = (sy - slope * sx) / n;
  const out = new Float32Array(64);
  for (const s of idx) out[s + 32] = un[s + 32] - slope * s - offset;
  return out;
}

// Motion detector on CSI amplitude. Each packet's LLTF amplitudes are
// normalised by their mean (removing AGC and transmit-power changes); the
// statistic is the mean over sub-carriers of each one's standard deviation
// across a sliding window. A still room gives a low, steady value; people
// moving through the multipath field raise it. The score is that statistic
// divided by the baseline learned while the room was empty.
class MotionDetector {
  constructor({ windowS = 1.5, threshold = 2.5, release = 1.6, holdS = 2 } = {}) {
    this.windowS = windowS;
    this.threshold = threshold;
    this.release = release;
    this.holdS = holdS;
    this.frames = [];
    this.baseline = null;
    this.learning = null;
    this.state = 'still';
    this.lastAbove = -Infinity;
    this.score = 0;
  }
  // amp: Float32Array(64) ordered -32..31; t in seconds. Returns an event or null.
  push(amp, t) {
    let mean = 0;
    for (const s of LLTF_VALID) mean += amp[s + 32];
    mean /= LLTF_VALID.length;
    if (!(mean > 0)) return null;
    this.frames.push({ t, v: LLTF_VALID.map((s) => amp[s + 32] / mean) });
    while (this.frames.length > 2 && t - this.frames[0].t > this.windowS) this.frames.shift();
    if (this.frames.length < 5) return null;
    const stat = this.statistic();
    if (this.learning) {
      this.learning.values.push(stat);
      if (t - this.learning.start >= this.learning.duration) {
        const v = this.learning.values.sort((a, b) => a - b);
        this.baseline = v[Math.floor(v.length / 2)];
        this.learning = null;
        return { type: 'calibrated', baseline: this.baseline };
      }
      return null;
    }
    if (!this.baseline) return null;
    this.score = stat / this.baseline;
    if (this.score >= this.threshold) this.lastAbove = t;
    if (this.state === 'still' && this.score >= this.threshold) {
      this.state = 'motion';
      return { type: 'motion', t, score: this.score };
    }
    if (this.state === 'motion' && this.score < this.release && t - this.lastAbove >= this.holdS) {
      this.state = 'still';
      return { type: 'still', t, score: this.score };
    }
    return null;
  }
  statistic() {
    const n = this.frames.length,
      k = this.frames[0].v.length;
    let total = 0;
    for (let j = 0; j < k; j++) {
      let s = 0,
        ss = 0;
      for (const f of this.frames) {
        s += f.v[j];
        ss += f.v[j] * f.v[j];
      }
      total += Math.sqrt(Math.max(0, ss / n - (s / n) ** 2));
    }
    return total / k;
  }
  // Learn the empty-room baseline over the next `duration` seconds.
  calibrate(t, duration = 10) {
    this.learning = { start: t, duration, values: [] };
    this.state = 'still';
  }
  reset() {
    this.frames = [];
    this.learning = null;
    this.state = 'still';
    this.score = 0;
  }
}

// ---- page -----------------------------------------------------------------------
if (typeof document !== 'undefined') {
  const $ = (id) => document.getElementById(id);
  const HEAT_ROWS = 400,
    MOTION_LEN = 600,
    SPEC_N = 128;
  let port = null,
    reader = null,
    writer = null,
    connected = false;
  const sources = new Map();
  let selected = null,
    pinned = false,
    last = null,
    heat = [],
    motion = [],
    baseline = null,
    series = [];
  const detector = new MotionDetector(),
    scores = [],
    log = [];
  let audioCtx = null;

  const status = (s) => ($('status').textContent = s);
  async function reconnectGranted() {
    const ports = (await SerialConnection.getPorts()).filter((p) => (p.getInfo?.() || {}).usbVendorId === 0x303a);
    if (ports.length) await connect(ports[0]);
  }
  const error = (e) => {
    const el = $('error');
    if (e && e.flashProfile && window.firmwarePrompt) {
      window.firmwarePrompt(el, {
        profile: e.flashProfile,
        label: e.flashLabel,
        message: e.message || String(e),
        beforeFlash: async () => disconnect(),
        afterFlash: reconnectGranted,
      });
      return;
    }
    el.innerHTML = '<span id="errorText"></span>';
    $('errorText').textContent = e?.message || e || '';
    el.hidden = !e;
  };
  async function send(cmd) {
    if (!writer) return;
    await writer.write(new TextEncoder().encode(cmd + '\n'));
  }
  async function connect(granted = null) {
    error('');
    try {
      port = granted || (await SerialConnection.requestPort());
      await port.open({ baudRate: 115200, bufferSize: 262144 });
      reader = port.readable.getReader();
      writer = port.writable.getWriter();
      connected = true;
      $('light').classList.add('on');
      $('connect').textContent = 'Disconnect';
      status('Connected · checking firmware');
      readLoop();
      await send('STOP');
      await send('INFO');
    } catch (e) {
      error(e);
      await disconnect();
    }
  }
  async function disconnect() {
    connected = false;
    try {
      await send('STOP');
    } catch (e) {}
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    writer?.releaseLock();
    await port?.close().catch(() => {});
    reader = writer = port = null;
    $('light').classList.remove('on');
    $('connect').textContent = 'Connect CSI sensor';
    status('Disconnected');
  }
  async function readLoop() {
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (connected) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          handle(line);
        }
        if (buf.length > 65536) buf = '';
      }
    } catch (e) {
      if (connected) error(e);
    }
  }
  function handle(line) {
    if (line.startsWith('CSI ')) {
      const f = line.split(' ');
      status(`CSI sensor ${f[3]} · ch ${f[5]}`);
      $('selfMac').textContent = f[3];
      return;
    }
    if (line.startsWith('ERR')) return error(`Firmware: ${line}`);
    if (line === 'OK') return;
    if (line.startsWith('S3SDR') || line.startsWith('DATA ')) {
      error(
        Object.assign(Error('This board is running the SDR receiver firmware, not the CSI sensor firmware.'), {
          flashProfile: 'esp32s3-csi',
          flashLabel: 'ESP32-S3 CSI sensor',
        }),
      );
      return;
    }
    const rec = parseCsiLine(line);
    if (!rec) return;
    const now = performance.now();
    let s = sources.get(rec.mac);
    if (!s) sources.set(rec.mac, (s = { mac: rec.mac, count: 0, times: [], rssi: rec.rssi, sigMode: rec.sigMode }));
    s.count++;
    s.rssi = rec.rssi;
    s.sigMode = rec.sigMode;
    s.times.push(now);
    while (s.times.length && now - s.times[0] > 2000) s.times.shift();
    // Follow the busiest transmitter until the user picks one: a steady,
    // frequent source gives the detector the most samples.
    if (!pinned) {
      const busiest = [...sources.values()].sort((a, b) => b.times.length - a.times.length)[0];
      if (busiest && busiest.mac !== selected && (!sources.get(selected) || busiest.times.length > 1.5 * sources.get(selected).times.length))
        selectSource(busiest.mac);
    }
    if (rec.mac !== selected) return;
    const { amp, phase } = lltf(rec);
    last = { amp, phase: sanitizePhase(phase), rec };
    const ev = detector.push(amp, now / 1000);
    if (detector.baseline) {
      scores.push({ t: now / 1000, s: detector.score });
      while (scores.length && now / 1000 - scores[0].t > 60) scores.shift();
    }
    if (ev) motionEvent(ev);
    heat.unshift(amp);
    if (heat.length > HEAT_ROWS) heat.pop();
    // Motion index: mean relative deviation from a slow per-sub-carrier baseline.
    if (!baseline) baseline = amp.slice();
    let dev = 0,
      n = 0;
    for (const sc of LLTF_VALID) {
      const k = sc + 32,
        b = baseline[k];
      if (b > 0) {
        dev += (amp[k] - b) / b;
        n++;
      }
      baseline[k] = 0.98 * b + 0.02 * amp[k];
    }
    const m = n ? dev / n : 0;
    motion.push({ t: rec.timestamp / 1e6, m });
    if (motion.length > MOTION_LEN) motion.shift();
    series.push({ t: rec.timestamp / 1e6, v: m });
    if (series.length > SPEC_N * 4) series.shift();
  }

  // ---- drawing --------------------------------------------------------------------
  function canvas(id) {
    const c = $(id),
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
    return { g, W, H, d };
  }
  const color = (t) => {
    t = Math.max(0, Math.min(1, t));
    return `hsl(${240 - 240 * t},80%,${20 + 45 * t}%)`;
  };
  function drawHeat() {
    const { g, W, H, d } = canvas('heat');
    if (!heat.length) return;
    let max = 1;
    for (const row of heat) for (const v of row) if (v > max) max = v;
    const cw = W / 64,
      rh = H / HEAT_ROWS;
    for (let r = 0; r < heat.length; r++)
      for (let k = 0; k < 64; k++) {
        g.fillStyle = color(heat[r][k] / max);
        g.fillRect(k * cw, r * rh, Math.ceil(cw), Math.ceil(rh));
      }
    g.fillStyle = '#c0c9cd';
    g.fillText('sub-carrier −32 … +31 →  ·  newest at top', 6 * d, H - 6 * d);
  }
  function drawSnapshot() {
    const { g, W, H, d } = canvas('snapshot');
    if (!last) return;
    const x = (k) => ((k + 0.5) / 64) * W;
    let max = 1;
    for (const v of last.amp) if (v > max) max = v;
    g.strokeStyle = '#37c964';
    g.lineWidth = 1.5 * d;
    g.beginPath();
    LLTF_VALID.forEach((s, j) => {
      const yy = H - (last.amp[s + 32] / max) * (H * 0.9);
      j ? g.lineTo(x(s + 32), yy) : g.moveTo(x(s + 32), yy);
    });
    g.stroke();
    g.strokeStyle = '#e0a040';
    g.beginPath();
    LLTF_VALID.forEach((s, j) => {
      const yy = H / 2 - (last.phase[s + 32] / Math.PI) * (H / 2);
      j ? g.lineTo(x(s + 32), yy) : g.moveTo(x(s + 32), yy);
    });
    g.stroke();
    g.fillStyle = '#c0c9cd';
    g.fillText('amplitude (green) · sanitized phase ±π (amber)', 6 * d, 14 * d);
  }
  function drawMotion() {
    const { g, W, H, d } = canvas('motion');
    if (motion.length < 2) return;
    let max = 0.05;
    for (const p of motion) max = Math.max(max, Math.abs(p.m));
    g.strokeStyle = '#7fb3dd';
    g.lineWidth = 1.2 * d;
    g.beginPath();
    motion.forEach((p, i) => {
      const xx = (i / (MOTION_LEN - 1)) * W,
        yy = H / 2 - (p.m / max) * (H / 2.2);
      i ? g.lineTo(xx, yy) : g.moveTo(xx, yy);
    });
    g.stroke();
    const recent = motion.slice(-50).map((p) => p.m),
      mean = recent.reduce((a, b) => a + b, 0) / recent.length,
      sd = Math.sqrt(recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length);
    $('motionValue').textContent = (100 * sd).toFixed(2) + ' %';
    g.fillStyle = '#c0c9cd';
    g.fillText('relative amplitude deviation (motion index)', 6 * d, 14 * d);
  }
  function drawSpectrum() {
    const { g, W, H, d } = canvas('doppler');
    if (series.length < SPEC_N) return;
    const s = series.slice(-SPEC_N),
      dt = (s[s.length - 1].t - s[0].t) / (SPEC_N - 1);
    if (!(dt > 0)) return;
    const rate = 1 / dt,
      re = new Float64Array(SPEC_N),
      im = new Float64Array(SPEC_N),
      mean = s.reduce((a, p) => a + p.v, 0) / SPEC_N;
    // Resample onto a uniform grid (packets arrive with jitter).
    for (let i = 0, j = 0; i < SPEC_N; i++) {
      const t = s[0].t + i * dt;
      while (j < SPEC_N - 2 && s[j + 1].t < t) j++;
      const a = s[j],
        b = s[j + 1],
        u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      re[i] = (a.v + u * (b.v - a.v) - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (SPEC_N - 1)));
    }
    fft(re, im);
    const half = SPEC_N / 2,
      mag = Array.from({ length: half }, (_, k) => 10 * Math.log10(re[k] ** 2 + im[k] ** 2 + 1e-12));
    const top = Math.max(...mag.slice(1)),
      bw = W / half;
    for (let k = 1; k < half; k++) {
      const h = Math.max(0, ((mag[k] - (top - 50)) / 50) * H);
      g.fillStyle = color((mag[k] - (top - 50)) / 50);
      g.fillRect(k * bw, H - h, Math.ceil(bw), h);
    }
    g.fillStyle = '#c0c9cd';
    g.fillText(`0 … ${(rate / 2).toFixed(0)} Hz fluctuation · ${rate.toFixed(0)} packets/s · 2.4 GHz: 1 Hz ≈ 6 cm/s radial`, 6 * d, 14 * d);
  }
  function drawSources() {
    const rows = [...sources.values()].sort((a, b) => b.times.length - a.times.length).slice(0, 12);
    $('sources').innerHTML = rows
      .map(
        (s) =>
          `<tr data-mac="${s.mac}" class="${s.mac === selected ? 'sel' : ''}"><td>${s.mac}</td><td>${(s.times.length / 2).toFixed(0)}/s</td><td>${s.rssi} dBm</td><td>${['11bg', '11n', '', '11ac'][s.sigMode] || s.sigMode}</td></tr>`,
      )
      .join('');
  }
  function selectSource(mac) {
    selected = mac;
    heat = [];
    motion = [];
    series = [];
    baseline = null;
    scores.length = 0;
    detector.reset();
    detector.baseline = null;
    $('motionState').textContent = 'Learn the empty room to arm';
    $('motionState').className = 'state';
  }
  $('sources').onclick = (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    pinned = true;
    selectSource(tr.dataset.mac);
  };

  // ---- motion detection panel ---------------------------------------------------------
  function beep() {
    if (!$('beep').checked) return;
    audioCtx ||= new AudioContext();
    const o = audioCtx.createOscillator(),
      g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.25);
  }
  function motionEvent(ev) {
    const time = new Date().toLocaleTimeString();
    if (ev.type === 'calibrated') {
      $('motionState').textContent = 'Still';
      $('motionState').className = 'state still';
      log.unshift(`${time} · armed (baseline ${ev.baseline.toFixed(4)})`);
    } else if (ev.type === 'motion') {
      $('motionState').textContent = 'Motion';
      $('motionState').className = 'state motion';
      log.unshift(`${time} · motion (score ${ev.score.toFixed(1)})`);
      beep();
    } else {
      $('motionState').textContent = 'Still';
      $('motionState').className = 'state still';
      log.unshift(`${time} · still`);
    }
    log.length = Math.min(log.length, 50);
    $('motionLog').innerHTML = log.map((l) => `<li>${l}</li>`).join('');
  }
  $('learn').onclick = () => {
    if (!selected) return error('No CSI yet: press Start and wait for a source.');
    detector.calibrate(performance.now() / 1000, Number($('learnS').value));
    $('motionState').textContent = `Learning… keep the room empty and still`;
    $('motionState').className = 'state learning';
  };
  $('sensitivity').oninput = () => {
    // Higher sensitivity = lower trigger ratio; release sits 60 % of the way down.
    const thr = Number($('sensitivity').value);
    detector.threshold = thr;
    detector.release = 1 + 0.4 * (thr - 1);
    $('sensitivityValue').textContent = `${thr.toFixed(1)}× baseline`;
  };
  function drawScore() {
    const c = $('scoreChart'),
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
    if (scores.length < 2) return;
    const top = Math.max(detector.threshold * 2, ...scores.map((p) => p.s)),
      y = (v) => H - (v / top) * H,
      t1 = scores[scores.length - 1].t,
      x = (t) => W - ((t1 - t) / 60) * W;
    g.strokeStyle = '#e0605080';
    g.setLineDash([4 * d, 4 * d]);
    g.beginPath();
    g.moveTo(0, y(detector.threshold));
    g.lineTo(W, y(detector.threshold));
    g.stroke();
    g.setLineDash([]);
    g.strokeStyle = detector.state === 'motion' ? '#ff7a5c' : '#37c964';
    g.lineWidth = 1.5 * d;
    g.beginPath();
    scores.forEach((p, i) => (i ? g.lineTo(x(p.t), y(p.s)) : g.moveTo(x(p.t), y(p.s))));
    g.stroke();
    g.fillStyle = '#c0c9cd';
    g.font = `${11 * d}px Carlito,sans-serif`;
    g.fillText(`score ${detector.score.toFixed(2)} · threshold ${detector.threshold.toFixed(1)} · last 60 s`, 6 * d, 14 * d);
  }
  function frame() {
    drawScore();
    drawHeat();
    drawSnapshot();
    drawMotion();
    drawSpectrum();
    drawSources();
    requestAnimationFrame(frame);
  }

  $('connect').onclick = () => (connected ? disconnect() : connect());
  $('start').onclick = async () => {
    await send(`CH ${$('channel').value}`);
    if ($('role').value === 'tx') await send(`TX ${Number($('txHz').value) || 100}`);
    else await send($('filter').value.trim() ? `RX ${$('filter').value.trim()}` : 'RX');
    await send('INFO');
  };
  $('stop').onclick = () => send('STOP');
  $('role').onchange = () => {
    $('txRow').hidden = $('role').value !== 'tx';
    $('rxRow').hidden = $('role').value === 'tx';
  };
  (async () => {
    try {
      const ports = (await SerialConnection.getPorts()).filter((p) => p.getInfo?.().usbVendorId === 0x303a);
      if (ports.length === 1) connect(ports[0]);
    } catch (e) {}
  })();
  requestAnimationFrame(frame);
}
