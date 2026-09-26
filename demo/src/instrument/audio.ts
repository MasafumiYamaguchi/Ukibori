export type Tone = "sine" | "triangle" | "sawtooth" | "square";
export interface SoundSettings { tone: Tone; cutoff: number; decay: number; volume: number; }

/** Audio lives on the audio clock; the UI timer only schedules ahead. */
export class InstrumentAudio {
  readonly context = new AudioContext();
  private output = this.context.createGain();
  private compressor = this.context.createDynamicsCompressor();
  private voices = new Map<number, { oscillator: OscillatorNode; gain: GainNode; filter: BiquadFilterNode }>();
  private nextVoice = 0;

  constructor() {
    this.output.gain.value = 0.22;
    this.output.connect(this.compressor);
    this.compressor.connect(this.context.destination);
  }

  async unlock() { await this.context.resume(); }

  note(midi: number, settings: SoundSettings, at = this.context.currentTime): number {
    const id = this.nextVoice++;
    const oscillator = this.context.createOscillator();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    oscillator.type = settings.tone;
    oscillator.frequency.value = 440 * 2 ** ((midi - 69) / 12);
    filter.type = "lowpass";
    filter.frequency.value = settings.cutoff;
    filter.Q.value = 0.7;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(settings.volume, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + settings.decay);
    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(this.output);
    this.voices.set(id, { oscillator, gain, filter });
    oscillator.onended = () => {
      oscillator.disconnect(); filter.disconnect(); gain.disconnect(); this.voices.delete(id);
    };
    oscillator.start(at);
    oscillator.stop(at + settings.decay + 0.04);
    return id;
  }

  stop() {
    const at = this.context.currentTime;
    for (const { oscillator, gain } of this.voices.values()) {
      gain.gain.cancelScheduledValues(at);
      gain.gain.setTargetAtTime(0, at, 0.008);
      try { oscillator.stop(at + 0.04); } catch { /* Already ended. */ }
    }
  }

  async dispose() { this.stop(); await this.context.close(); }
}
