'use strict';
// Plays demodulated audio posted from the page. The radio's sample clock and
// the sound card's drift apart, so the buffer is trimmed back to a target
// latency when it grows and padded with silence when it runs dry.
class StreamPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(Math.ceil(sampleRate * 2));
    this.r = 0;
    this.w = 0;
    this.n = 0;
    this.target = Math.ceil(sampleRate * 0.15);
    this.volume = 1;
    this.port.onmessage = ({ data }) => {
      if (typeof data === 'number') {
        this.volume = data;
        return;
      }
      const len = this.buf.length;
      for (let k = 0; k < data.length; k++) {
        this.buf[this.w] = data[k];
        this.w = (this.w + 1) % len;
        if (this.n < len) this.n++;
        else this.r = (this.r + 1) % len;
      }
      if (this.n > 2 * this.target) {
        const drop = this.n - this.target;
        this.r = (this.r + drop) % len;
        this.n -= drop;
      }
    };
  }
  process(_, outputs) {
    const out = outputs[0],
      len = this.buf.length;
    for (let i = 0; i < out[0].length; i++) {
      let v = 0;
      if (this.n) {
        v = this.buf[this.r] * this.volume;
        this.r = (this.r + 1) % len;
        this.n--;
      }
      for (const ch of out) ch[i] = v;
    }
    return true;
  }
}
registerProcessor('stream-player', StreamPlayer);
