/**
 * All sound is synthesized with WebAudio: no audio files to download.
 * Browsers only allow audio after a user gesture, so `unlock()` is called on the
 * first click/keypress.
 */

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambient: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  volume = 0.7;
  muted = false;

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    } catch {
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(ctx.destination);
    // Shared white-noise buffer.
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.startAmbient();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master && !this.muted) this.master.gain.value = v;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  }

  private startAmbient(): void {
    const ctx = this.ctx!;
    this.ambient = ctx.createGain();
    this.ambient.gain.value = 0.05;
    this.ambient.connect(this.master!);
    // HVAC: brown-ish noise through a low-pass filter.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 280;
    const g = ctx.createGain();
    g.gain.value = 0.9;
    src.connect(lp).connect(g).connect(this.ambient);
    src.start();
    // Fluorescent hum: 120 Hz with a whisper of harmonics.
    for (const [f, a] of [
      [120, 0.05],
      [240, 0.02],
      [360, 0.008],
    ]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = a;
      o.connect(og).connect(this.ambient);
      o.start();
    }
  }

  private noiseBurst(opts: { freq: number; q: number; gain: number; decay: number; delay?: number }): void {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuf) return;
    const t = ctx.currentTime + (opts.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = opts.freq;
    bp.Q.value = opts.q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(opts.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.decay);
    src.connect(bp).connect(g).connect(this.master!);
    src.start(t, Math.random() * 1.5, opts.decay + 0.02);
  }

  private tone(freq: number, start: number, dur: number, gain: number, type: OscillatorType = 'sine'): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + start;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** A mechanical-ish key click. Heavier for Enter/Space. */
  key(code: string): void {
    const heavy = code === 'Enter' || code === 'Space' || code === 'Backspace';
    const pitch = 1 + (Math.random() - 0.5) * 0.25;
    this.noiseBurst({ freq: (heavy ? 1800 : 3200) * pitch, q: 1.2, gain: heavy ? 0.22 : 0.14, decay: heavy ? 0.06 : 0.035 });
    this.noiseBurst({ freq: (heavy ? 420 : 650) * pitch, q: 2, gain: heavy ? 0.16 : 0.08, decay: heavy ? 0.08 : 0.04, delay: 0.004 });
  }

  /** Pingr's two-note chime. */
  ping(): void {
    this.tone(1318.5, 0, 0.35, 0.12);
    this.tone(1760, 0.09, 0.45, 0.1);
  }

  success(): void {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, i * 0.11, 0.5, 0.09, 'triangle'));
  }

  fail(): void {
    this.tone(220, 0, 0.5, 0.14, 'sawtooth');
    this.tone(207.65, 0.25, 0.7, 0.12, 'sawtooth');
  }

  checkmark(): void {
    this.tone(987.77, 0, 0.18, 0.07, 'triangle');
    this.tone(1318.5, 0.07, 0.25, 0.06, 'triangle');
  }

  error(): void {
    this.tone(160, 0, 0.12, 0.05, 'square');
  }
}
