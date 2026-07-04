/**
 * Voice Activity Detection using Web Audio API AnalyserNode.
 * Emits "voice_start" and "voice_end" events on the returned EventTarget.
 */

export class VAD extends EventTarget {
  constructor({ endpointMs = 500, sensitivity = 0.015 } = {}) {
    super();
    this.endpointMs = endpointMs;
    this.sensitivity = sensitivity;
    this._context = null;
    this._analyser = null;
    this._raf = null;
    this._silenceTimer = null;
    this._speaking = false;
    this._stopped = false;
  }

  async start(stream) {
    this._context = new AudioContext();
    const source = this._context.createMediaStreamSource(stream);
    this._analyser = this._context.createAnalyser();
    this._analyser.fftSize = 512;
    source.connect(this._analyser);
    this._stopped = false;
    this._tick();
  }

  stop() {
    this._stopped = true;
    cancelAnimationFrame(this._raf);
    clearTimeout(this._silenceTimer);
    this._context?.close();
    this._context = null;
  }

  get rms() {
    if (!this._analyser) return 0;
    const buf = new Float32Array(this._analyser.fftSize);
    this._analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const s of buf) sum += s * s;
    return Math.sqrt(sum / buf.length);
  }

  _tick() {
    if (this._stopped) return;
    this._raf = requestAnimationFrame(() => this._tick());

    const level = this.rms;
    this.dispatchEvent(Object.assign(new Event("level"), { level }));

    if (level > this.sensitivity) {
      if (!this._speaking) {
        this._speaking = true;
        clearTimeout(this._silenceTimer);
        this._silenceTimer = null;
        this.dispatchEvent(new Event("voice_start"));
      } else {
        clearTimeout(this._silenceTimer);
        this._silenceTimer = null;
      }
    } else if (this._speaking && !this._silenceTimer) {
      this._silenceTimer = setTimeout(() => {
        this._speaking = false;
        this.dispatchEvent(new Event("voice_end"));
      }, this.endpointMs);
    }
  }
}
