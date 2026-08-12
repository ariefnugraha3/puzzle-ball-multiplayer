export class SoundEngine {
  constructor() {
    this.enabled = true;
    this.context = null;
  }

  unlock() {
    if (!this.enabled) return;
    const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!this.context) this.context = new AudioContextClass();
    if (this.context.state === 'suspended') this.context.resume().catch(() => {});
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (enabled) this.unlock();
  }

  tone(frequency, duration, { type = 'sine', volume = 0.03, slide = 0, delay = 0 } = {}) {
    if (!this.enabled || !this.context) return;
    const start = this.context.currentTime + delay;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(30, frequency + slide), start + duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(this.context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  shoot() { this.tone(230, 0.09, { type: 'triangle', volume: 0.024, slide: 210 }); }
  swap() { this.tone(360, 0.07, { volume: 0.021, slide: 100 }); }
  impact() { this.tone(120, 0.08, { type: 'square', volume: 0.012, slide: -35 }); }
  warning() { this.tone(165, 0.18, { type: 'sawtooth', volume: 0.017, slide: -22 }); }

  pop(combo = 1) {
    const base = 440 + combo * 65;
    this.tone(base, 0.13, { volume: 0.035, slide: 150 });
    this.tone(base * 1.25, 0.12, { type: 'triangle', volume: 0.018, slide: 110, delay: 0.035 });
  }

  win() {
    [392, 494, 587, 784].forEach((frequency, index) => {
      this.tone(frequency, 0.24, { volume: 0.031, slide: 45, delay: index * 0.12 });
    });
  }

  lose() {
    [240, 190, 125].forEach((frequency, index) => {
      this.tone(frequency, 0.3, { type: 'sawtooth', volume: 0.019, slide: -45, delay: index * 0.16 });
    });
  }
}
