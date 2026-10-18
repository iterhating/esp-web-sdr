import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../bandplan.js', import.meta.url), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(source, ctx);
const { bleChannel, describeFrequency, matchedBandwidth, ppmScale } = ctx;

test('BLE channel indices follow the RF-channel mapping around the advertising channels', () => {
  assert.equal(bleChannel(2402), 37);
  assert.equal(bleChannel(2404), 0);
  assert.equal(bleChannel(2424), 10);
  assert.equal(bleChannel(2426), 38);
  assert.equal(bleChannel(2428), 11);
  assert.equal(bleChannel(2478), 36);
  assert.equal(bleChannel(2480), 39);
  assert.equal(bleChannel(2403), null);
  assert.equal(bleChannel(2482), null);
});

test('frequencies are named by Wi-Fi channel, BLE/BT channel and known chip spur', () => {
  const at = (mhz, family) => [...describeFrequency(mhz * 1e6, family)];
  assert.deepEqual(at(2437), ['Wi-Fi ch 6/5/7/4/8', 'BT ch 35']);
  assert.deepEqual(at(2426), ['Wi-Fi ch 4/3/5/2', 'BLE ch 38 (adv)', 'BT ch 24']);
  assert.ok(at(2448, 'S3').includes('48 MHz ×51 spur'));
  assert.ok(!at(2448, 'C5').some((n) => n.includes('spur')));
  assert.deepEqual(at(5180), ['Wi-Fi ch 36']);
  assert.deepEqual(at(3000), []);
});

test('rate-matched analog bandwidth keeps the filter edge inside Nyquist', () => {
  const s3 = [13, 69, 1, 0];
  assert.equal(matchedBandwidth(16e6, s3), 14);
  assert.equal(matchedBandwidth(40e6, s3), 36);
  assert.equal(matchedBandwidth(80e6, s3), 0);
  assert.equal(matchedBandwidth(4e6, s3), 13);
  assert.equal(matchedBandwidth(40e6, null), 0);
});

test('crystal correction scales frequencies by parts per million', () => {
  assert.equal(ppmScale(0), 1);
  assert.equal(ppmScale('2'), 1.000002);
  assert.equal(ppmScale(''), 1);
  assert.ok(Math.abs(2437e6 * ppmScale(-45) - (2437e6 - 109665)) < 1);
});
