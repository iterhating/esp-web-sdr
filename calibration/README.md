# Receiver calibration tools

Python tools that drive ESP-SDR burst firmware over serial and characterise the
receiver against signals already on the air. They need `numpy`, `scipy`,
`pyserial` and, for `ble_inventory.py`, `bleak`. Close the web viewer first:
only one program can hold the serial port.

Recordings (`rec_*.npz`) and every result file stay local (see `.gitignore`):
they can contain nearby device addresses and decoded beacons.

| Tool | Measures |
| --- | --- |
| `espsdr.py` | Host driver: `FREQ`, `BANDWIDTH`, `GAIN`, `CAP16`/`CAP20` with CRC and resync |
| `gain_sweep.py` | Noise floor, peak and clipping for every manual gain index |
| `bandwidth_sweep.py` | Noise-shaped −3 dB edge for every `BANDWIDTH` setting |
| `survey.py` | Per-MHz occupancy, mean and max-hold across 2.385–2.490 GHz |
| `zoom.py` | Whether a line is a real signal or a receiver spur (moves with the LO?) and its image |
| `record.py` | Raw I/Q bursts to `.npz` for offline analysis |
| `explore.py` | Burst duration/width/SNR statistics of a recording |
| `ofdm_cfo.py`, `ofdm_cp.py` | 802.11 OFDM CFO from L-STF/L-LTF and from cyclic prefixes |
| `gfsk_cfo.py` | Carrier offset of Bluetooth/BLE bursts by FM discriminator |
| `ble_decode.py` | Full BLE 1M advertising decode (access address, de-whitening, CRC-24, AD fields) with per-packet CFO |
| `iq_balance.py` | Blind I/Q gain/phase imbalance and image rejection on a CW line |
| `ble_inventory.py` | BLE advertisers seen by the host's own adapter, for cross-checking |

## ESP32-S3 SuperMini results (ESP-SDR protocol 6)

**Frequency accuracy.** Carrier offsets were measured on three kinds of
transmitter. Every Bluetooth burst and the most frequent Wi-Fi transmitter read
+105 to +126 kHz, which suggests an ESP crystal 45 ppm slow. Decoding the BLE
beacons showed they came from the host laptop, whose Wi-Fi/Bluetooth combo chip
shares one crystal; an unrelated Wi-Fi transmitter (cyclic-prefix CFO over
30–50 OFDM symbols) read +4 kHz. The ESP is therefore within about 2 ppm and the
laptop is the outlier. Always check which device a reference comes from.

**Spurs.** A pure line at exactly 2448.000 MHz (−50 dBFS at gain index 60) stays
at the same absolute frequency from LOs 2443–2453 MHz to the 1 kHz bin. It is
coherent with the ESP's crystal, so it is generated on the chip: 51 × 48 MHz.
2400 MHz (50 × 48 MHz) also shows. The LO itself leaks at every tune frequency.

**Analog filter.** `BANDWIDTH n` sets the two-sided width: the one-sided −3 dB
edge is close to 0.47·n MHz (6.9 MHz at 13, 18.8 at 40, about 30 at 69 or open).
`matchedBandwidth()` in `bandplan.js` uses this to keep the edge inside Nyquist.

**Gain table.** From index 56 to 82 the noise floor rises 0.94 dB per index
(thermal-noise limited). Below 56 the table is a sawtooth (front-end segments
near 28, 46 and 54) over an ADC noise floor near −70 dBFS. With strong nearby
Bluetooth, index 64 and above clips; 54 is a good fixed gain for surveys.

**I/Q balance.** Gain imbalance below 0.05 dB and phase skew below 0.3°; image
rejection on the 2448 MHz line is 28–31 dB and a one-tap blind correction does
not improve it, so the image is not limited by static I/Q mismatch.
