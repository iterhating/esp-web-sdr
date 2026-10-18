// In-page firmware flashing, so any page can install the firmware it needs
// without a trip to flash.html. Reuses the bundled esptool-js, the manifest
// catalog and the reset sequence. Loaded as a module; exposes two globals the
// classic page scripts call: window.flashProfileInline and window.firmwarePrompt.
import { ESPLoader, Transport } from './flasher/vendor/esptool-js-0.7.0.js';
import { loadManifest, checkedImages, flashMatches, checkCrystal } from './flasher/catalog.mjs';
import { finishSession } from './flasher/reset.mjs';

const manifestUrl = new URL('./firmware/manifest.json', import.meta.url);
const noTerminal = { clean() {}, write() {}, writeLine() {} };

// Flash one manifest profile to a port. onStatus/onProgress report progress.
// The caller must close any serial connection to the port first.
async function flashProfileInline(profileId, { port, onStatus = () => {}, onProgress = () => {} } = {}) {
  const firmware = await loadManifest(manifestUrl);
  const variant = firmware.variants[profileId];
  if (!variant) throw Error(`Unknown firmware profile: ${profileId}`);
  if (!port) port = await SerialConnection.requestPort();
  const uart = port.getInfo().usbVendorId !== 0x303a;
  const transport = new Transport(port, false);
  const loader = new ESPLoader({ transport, baudrate: 115200, terminal: noTerminal });
  onStatus('Connecting to the bootloader…');
  await loader.main();
  // esptool-js 0.7.0 inherits C6's SPI base for C5; correct it (harmless elsewhere).
  if (loader.chip.CHIP_NAME === 'ESP32-C5') loader.chip.SPI_REG_BASE = 0x60003000;
  const size = await loader.detectFlashSize();
  if (variant.chip !== loader.chip.CHIP_NAME)
    throw Error(`This board is ${loader.chip.CHIP_NAME}, but the ${variant.label} firmware is for ${variant.chip}.`);
  if (!flashMatches(variant, size))
    throw Error(`That firmware needs ${variant.flash_size_policy === 'minimum' ? 'at least ' : ''}${variant.flash_size} flash; this board has ${size}.`);
  checkCrystal(variant, loader.detectedCrystal);
  // Native USB flashes at 115200; keep that to avoid the UART baud-switch dance.
  if (uart) {
    loader.baudrate = 921600;
    try {
      await loader.changeBaud();
    } catch (e) {
      /* stay at 115200 */
    }
  }
  onStatus('Downloading and checking firmware…');
  const fileArray = await checkedImages(variant, profileId, manifestUrl),
    total = fileArray.reduce((s, f) => s + f.data.length, 0);
  onStatus(`Writing ${variant.label}. Keep the board connected…`);
  await loader.writeFlash({
    fileArray,
    flashMode: 'keep',
    flashFreq: 'keep',
    flashSize: 'keep',
    eraseAll: false,
    compress: true,
    reportProgress: (i, written, sz) => {
      const before = fileArray.slice(0, i).reduce((s, f) => s + f.data.length, 0);
      onProgress((100 * (before + (fileArray[i].data.length * written) / sz)) / total);
    },
  });
  onStatus('Verifying…');
  for (const part of variant.parts) {
    const md5 = await loader.flashMd5sum(part.offset, part.size);
    if (md5.toLowerCase() !== part.md5) throw Error(`Verification failed for ${part.name}. Try again in BOOT mode.`);
  }
  onProgress(100);
  onStatus('Resetting into the new firmware…');
  await finishSession(loader, transport, async () => transport.disconnect(), () => {});
  return variant;
}

// Build a prompt (message + Flash button + progress) inside `el`. opts:
//   profile, label: which firmware and its friendly name
//   message: why it's needed
//   beforeFlash(): close the page's connection and release the port
//   afterFlash():  reconnect once the new firmware has booted
function firmwarePrompt(el, { profile, label, message, beforeFlash, afterFlash }) {
  el.hidden = false;
  el.innerHTML = '';
  const msg = document.createElement('div');
  msg.textContent = message;
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap';
  const btn = document.createElement('button');
  btn.textContent = `Flash ${label} now`;
  const note = document.createElement('span');
  note.style.cssText = 'font-size:12.5px;color:#a1adb2';
  const prog = document.createElement('progress');
  prog.max = 100;
  prog.value = 0;
  prog.hidden = true;
  prog.style.cssText = 'width:160px';
  bar.append(btn, prog, note);
  el.append(msg, bar);
  btn.onclick = async () => {
    btn.disabled = true;
    prog.hidden = false;
    note.textContent = 'starting…';
    try {
      if (beforeFlash) await beforeFlash();
      let port = (await SerialConnection.getPorts()).find((p) => ((p.getInfo && p.getInfo()) || {}).usbVendorId === 0x303a);
      if (!port) port = await SerialConnection.requestPort();
      await flashProfileInline(profile, {
        port,
        onStatus: (s) => (note.textContent = s),
        onProgress: (p) => (prog.value = p),
      });
      note.textContent = 'Installed. Waiting for the board to re-enumerate…';
      // Native USB Serial/JTAG drops and re-appears after reset.
      await new Promise((r) => setTimeout(r, 4000));
      el.hidden = true;
      el.innerHTML = '';
      if (afterFlash) await afterFlash();
    } catch (e) {
      note.textContent = `Failed: ${e.message || e}. Hold BOOT, tap RESET, release BOOT and retry.`;
      btn.disabled = false;
    }
  };
}

window.flashProfileInline = flashProfileInline;
window.firmwarePrompt = firmwarePrompt;
window.dispatchEvent(new Event('inline-flash-ready'));
