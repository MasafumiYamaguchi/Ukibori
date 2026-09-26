import { useCallback, useEffect, useRef, useState } from "react";
import { Surface, Ukibori } from "ukibori";
import type { Material } from "ukibori";
import type { MaskSource } from "ukibori-renderer";
import { InstrumentAudio } from "./audio";
import type { SoundSettings, Tone } from "./audio";

const NOTES = Array.from({ length: 24 }, (_, index) => 48 + index);
const PITCHES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const NAMES = NOTES.map((_, index) => PITCHES[index % 12]);
const SHORTCUTS = ["a", "w", "s", "e", "d", "f", "t", "g", "y", "h", "u", "j", "k", "o", "l", "p", ";", "'", "]", "", "", "", "", ""];
const WHITE_KEYS = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23];
const BLACK_KEYS = [1, 3, 6, 8, 10, 13, 15, 18, 20, 22];
const INITIAL = [0, -1, 7, -1, 4, -1, 7, 11, 0, -1, 7, -1, 9, 7, 4, -1];
const TONES: Tone[] = ["sawtooth", "square", "triangle", "sine"];
const TONE_LABELS = ["SAW", "SQR", "TRI", "SIN"];
const noteLabel = (index: number, octave = 0) => `${NAMES[index]}${Math.floor(NOTES[index] / 12) - 1 + octave}`;
export const BODY_HEIGHT = 18;
// One immutable, supersampled silhouette carves all 120 holes into the body.
export const SPEAKER_MASK: MaskSource = (() => {
  const scale = 3;
  const width = 96 * scale;
  const height = 114 * scale;
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = (x + 0.5) / scale;
      const py = (y + 0.5) / scale;
      const column = Math.round((px - 7.5) / 9);
      const row = Math.round((py - 7.5) / 9);
      if (column >= 0 && column < 10 && row >= 0 && row < 12 && Math.hypot(px - (7.5 + column * 9), py - (7.5 + row * 9)) <= 2.1) alpha[y * width + x] = 255;
    }
  }
  return { width, height, alpha };
})();
const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const material = (hex: string, roughness = 0.7): Material => ({
  baseColor: { r: linear(parseInt(hex.slice(1, 3), 16) / 255), g: linear(parseInt(hex.slice(3, 5), 16) / 255), b: linear(parseInt(hex.slice(5, 7), 16) / 255) },
  roughness, metallic: 0, ior: 1.5,
});
const MATERIALS: Record<string, Material> = {
  body: { ...material("#bcc2c6", 0.38), metallic: 0.85 },
  speaker: { ...material("#454a4e", 0.7), metallic: 0.65 },
  ivory: material("#f4f3ef"), charcoal: { ...material("#282927", 0.95), ior: 1 }, display: { ...material("#10110f", 1), ior: 1 },
  orange: material("#ff6527"),
  led: { ...material("#ff6527"), emissive: { r: 4, g: 0.55, b: 0.05 } },
};
const LIGHT = { x: -0.55, y: -0.7, z: 0.85 };
const ENVIRONMENT = { intensity: 0.55 };
const SHADOW = { samples: 1 as const };
const COMPOSITING = { emissive: { illumination: { radius: 18, intensity: 1.2 }, bloom: { radius: 6, intensity: 0.7 }, quality: 1 } };

function Dial({ label, value, min, max, step = 1, surface, display, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; surface: string; display: string; onChange: (value: number) => void;
}) {
  const drag = useRef<{ y: number; value: number } | null>(null);
  return <label className={`form-dial form-dial-${surface}`}>
    <span className="form-dial-track">
      <Surface className="form-dial-cap" shape={{ kind: "roundedRect", radius: 25 }} material={surface} elevation={BODY_HEIGHT + 5} thickness={4} bevelWidth={2.5} radius={25} profile={{ kind: "convex" }}
        onPointerDown={event => { event.preventDefault(); drag.current = { y: event.clientY, value }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (drag.current) onChange(Math.min(max, Math.max(min, Math.round((drag.current.value + (drag.current.y - event.clientY) / 140 * (max - min)) / step) * step))); }}
        onPointerUp={event => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { drag.current = null; }}>
        <span className="form-dial-pointer" style={{ transform: `rotate(${label === "WAVE" ? 25 + value * 90 : -135 + (value - min) / (max - min) * 270}deg)` }} />
      </Surface>
      <input type="range" aria-label={label} aria-valuetext={display} min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} />
    </span>
    <span className="form-dial-label">{label}</span>
  </label>;
}

function wavePath(tone: Tone) {
  return Array.from({ length: 181 }, (_, index) => {
    const phase = Math.max(0, index - 1) / 180 * 5;
    const t = phase % 1;
    const y = tone === "sine" ? Math.sin(phase * Math.PI * 2) : tone === "triangle" ? 1 - 4 * Math.abs(t - 0.5) : tone === "sawtooth" ? 2 * t - 1 : t < 0.5 ? 1 : -1;
    return `${index === 0 ? "M" : "L"}${index * 2},${index === 0 && tone === "sawtooth" ? 27 : 49 - y * 22}`;
  }).join(" ");
}

export function Instrument() {
  const [bpm, setBpm] = useState(114);
  const [cutoff, setCutoff] = useState(50);
  const [decay, setDecay] = useState(30);
  const [volume, setVolume] = useState(0.5);
  const [tone, setTone] = useState<Tone>("sawtooth");
  const [octave, setOctave] = useState(0);
  const [pattern, setPattern] = useState(INITIAL);
  const [playing, setPlaying] = useState(false);
  const [step, setStep] = useState(-1);
  const [selectedNote, setSelectedNote] = useState(0);
  const [pressed, setPressed] = useState<number | null>(null);
  const [message, setMessage] = useState("Ready when you are.");
  const [backend, setBackend] = useState("starting");
  const engine = useRef<InstrumentAudio | null>(null);
  const pending = useRef(false);
  const settings = useRef<SoundSettings>({ tone, cutoff, decay, volume });
  const sequence = useRef(pattern);
  const tempo = useRef(bpm);
  const transpose = useRef(octave);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  settings.current = { tone, cutoff: 200 * 40 ** (cutoff / 100), decay: 0.08 + decay / 100 * 1.12, volume };
  sequence.current = pattern;
  tempo.current = bpm;
  transpose.current = octave;

  const unlock = useCallback(async () => {
    try {
      if (!engine.current) engine.current = new InstrumentAudio();
      await engine.current.unlock();
      return engine.current;
    } catch {
      setMessage("Audio could not start. Try a browser with Web Audio support.");
      return null;
    }
  }, []);

  const playNote = useCallback(async (index: number) => {
    setSelectedNote(index);
    setPressed(index);
    clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => setPressed(null), 160);
    const audio = await unlock();
    if (audio && audio === engine.current) {
      audio.note(NOTES[index] + transpose.current * 12, settings.current);
      setMessage(`${noteLabel(index, transpose.current)} · ${settings.current.tone}`);
    }
  }, [unlock]);

  const togglePlay = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    const audio = await unlock();
    pending.current = false;
    if (!audio || audio !== engine.current) return;
    setPlaying(!playing);
    setMessage(playing ? "Sequence stopped. Play a key to try a new melody." : "Sequence running. Tap a step to edit.");
  }, [unlock, playing]);

  useEffect(() => {
    if (!playing || !engine.current) { setStep(-1); engine.current?.stop(); return; }
    const audio = engine.current;
    let nextTime = audio.context.currentTime + 0.06;
    let index = 0;
    const queued: { time: number; step: number }[] = [];
    setMessage("Sequence running. Tap a step to edit.");
    const tick = () => {
      const now = audio.context.currentTime;
      while (nextTime < now + 0.1) {
        const note = sequence.current[index];
        if (note >= 0) audio.note(NOTES[note] + transpose.current * 12, settings.current, nextTime);
        queued.push({ time: nextTime, step: index });
        nextTime += 60 / tempo.current / 4;
        index = (index + 1) % 16;
      }
      let current: number | undefined;
      while (queued.length && queued[0].time <= now) current = queued.shift()!.step;
      if (current !== undefined) setStep(current);
    };
    tick();
    const timer = setInterval(tick, 25);
    return () => { clearInterval(timer); audio.stop(); };
  }, [playing]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || (event.target instanceof HTMLElement && event.target.closest("input, select, textarea, [contenteditable='true']"))) return;
      const index = SHORTCUTS.indexOf(event.key.toLowerCase());
      if (index >= 0) { event.preventDefault(); void playNote(index); }
      if (event.code === "Space" && !(event.target instanceof HTMLElement && event.target.closest("button, a, summary"))) { event.preventDefault(); void togglePlay(); }
    };
    const stopWhenHidden = () => {
      if (document.hidden) { setPlaying(false); engine.current?.stop(); setMessage("Paused while the instrument was hidden."); }
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", stopWhenHidden);
    return () => { window.removeEventListener("keydown", onKey); document.removeEventListener("visibilitychange", stopWhenHidden); };
  }, [playNote, togglePlay]);

  useEffect(() => () => {
    clearTimeout(pressTimer.current);
    const audio = engine.current;
    engine.current = null;
    if (audio) void audio.dispose();
  }, []);

  const advanceStep = async () => {
    if (playing) return;
    const audio = await unlock();
    if (!audio || audio !== engine.current) return;
    const next = (step + 1) % 16;
    const note = sequence.current[next];
    if (note >= 0) audio.note(NOTES[note] + transpose.current * 12, settings.current);
    setStep(next);
    setMessage(`Step ${next + 1} · ${note < 0 ? "rest" : noteLabel(note, transpose.current)}`);
  };

  const key = (index: number, black = false) => <Surface as="button" type="button" key={index}
    material={black ? "charcoal" : "ivory"} elevation={BODY_HEIGHT + (pressed === index ? 0.5 : black ? 5 : 2)}
    thickness={pressed === index ? 1 : 3} bevelWidth={2} shape={{ kind: "roundedRect", radius: 6 }} radius={6} className={`form-key${black ? " form-key-black" : ""}`}
    style={black ? { gridColumn: WHITE_KEYS.filter(value => value < index).length + 1 } : undefined}
    aria-label={`Play ${noteLabel(index, octave)}`} aria-pressed={pressed === index}
    onClick={() => void playNote(index)}>
    {!black && <span className="form-key-note">{index % 12 === 0 ? noteLabel(index, octave) : NAMES[index]}</span>}
    <span className="form-key-shortcut">{SHORTCUTS[index].toUpperCase()}</span>
  </Surface>;

  return <main className="form-page">
    <div className="form-device-scroll">
      <Ukibori backend="auto" basePlaneColor="#eae9e5" materials={MATERIALS} light={LIGHT} intensity={1.5} environment={ENVIRONMENT}
        shadow={SHADOW} compositing={COMPOSITING} dpr={1} margin={30} className="form-stage"
        onReady={layer => setBackend(layer?.debugState().backend ?? "starting")}>
        <div className="form-device">
        <Surface sceneId="instrument-body" className="form-body" material="body" shape={{ kind: "roundedRect", radius: 20 }} elevation={0} thickness={BODY_HEIGHT} bevelWidth={9} profile={{ kind: "smooth" }} radius={20} aria-hidden="true" />
        <div className="form-upper">
          <div className="form-speaker-panel">
            <Surface sceneId="speaker-holes" className="form-speaker" shape={{ kind: "mask", mask: SPEAKER_MASK }} material="speaker" elevation={BODY_HEIGHT} thickness={8} bevelWidth={0.8} profile={{ kind: "smooth", mode: "inset" }} aria-label="Speaker grille with recessed holes" role="img" />
            <div className="form-brand"><strong>ripple</strong><Surface sceneId="playback-led" className="form-power-led" material={playing ? "led" : "charcoal"} shape={{ kind: "roundedRect", radius: 3 }} elevation={BODY_HEIGHT + 1} thickness={1} bevelWidth={0.4} radius={3} aria-hidden="true" /></div>
          </div>
          <Surface material="display" elevation={BODY_HEIGHT} thickness={1.5} bevelWidth={1} radius={6} shape={{ kind: "roundedRect", radius: 6 }} profile={{ kind: "smooth", mode: "inset" }} className="form-screen">
            <div className="form-screen-top"><span><b>{TONE_LABELS[TONES.indexOf(tone)]}</b><i>CUT</i> {cutoff} <i>DEC</i> {decay} <i>OCT</i> {octave}</span><span><i>{playing ? "SEQ" : "KEYS"}</i> {bpm} BPM</span></div>
            <svg viewBox="0 0 360 86" preserveAspectRatio="none" aria-label={`${tone} waveform`} role="img"><path d="M30 0V86 M60 0V86 M90 0V86 M120 0V86 M150 0V86 M180 0V86 M210 0V86 M240 0V86 M270 0V86 M300 0V86 M330 0V86" className="form-grid-line" /><path d={wavePath(tone)} className="form-wave-line" /></svg>
            <div className="form-screen-sequence" aria-hidden="true">{pattern.map((note, index) => <span key={index} data-enabled={note >= 0} data-current={step === index} />)}</div>
          </Surface>
          <div className="form-dials">
            <Dial label="WAVE" value={TONES.indexOf(tone)} min={0} max={3} surface="charcoal" display={tone} onChange={value => setTone(TONES[value])} />
            <Dial label="CUTOFF" value={cutoff} min={0} max={100} surface="charcoal" display={`${cutoff}%`} onChange={setCutoff} />
            <Dial label="DECAY" value={decay} min={0} max={100} surface="ivory" display={`${decay}%`} onChange={setDecay} />
            <Dial label="TEMPO" value={bpm} min={60} max={180} surface="orange" display={`${bpm} BPM`} onChange={setBpm} />
          </div>
        </div>

        <div className="form-lower">
          <div className="form-controls">
            <p className="form-model">R-1 · POCKET VOICE</p>
            <div className="form-control-grid">
              <Surface as="button" type="button" material="ivory" elevation={BODY_HEIGHT + (playing ? 0.5 : 2)} thickness={playing ? 1 : 3} bevelWidth={2} shape={{ kind: "roundedRect", radius: 8 }} radius={8} className="form-control" aria-label={playing ? "Stop sequence" : "Play sequence"} aria-pressed={playing} onClick={() => void togglePlay()}><span>{playing ? "■" : "▶"}</span><small>{playing ? "STOP" : "PLAY"}</small></Surface>
              <Surface as="button" type="button" material="ivory" elevation={BODY_HEIGHT + 2} thickness={3} bevelWidth={2} shape={{ kind: "roundedRect", radius: 8 }} radius={8} className="form-control" aria-label="Advance one step" disabled={playing} onClick={() => void advanceStep()}><span className="form-control-dot" /><small>STEP</small></Surface>
              <Surface as="button" type="button" material="ivory" elevation={BODY_HEIGHT + 2} thickness={3} bevelWidth={2} shape={{ kind: "roundedRect", radius: 8 }} radius={8} className="form-control" aria-label="Clear pattern" onClick={() => { setPattern(Array(16).fill(-1)); setMessage("Pattern cleared. Choose a key, then tap a step to write a note."); }}><small>CLEAR</small></Surface>
              <Surface as="button" type="button" material="charcoal" elevation={BODY_HEIGHT + 2} thickness={3} bevelWidth={2} shape={{ kind: "roundedRect", radius: 8 }} radius={8} className="form-control form-control-dark" aria-label="Octave down" disabled={octave <= -2} onClick={() => setOctave(value => Math.max(-2, value - 1))}><span>−</span><small>OCT</small></Surface>
              <Surface as="button" type="button" material="charcoal" elevation={BODY_HEIGHT + 2} thickness={3} bevelWidth={2} shape={{ kind: "roundedRect", radius: 8 }} radius={8} className="form-control form-control-dark" aria-label="Octave up" disabled={octave >= 2} onClick={() => setOctave(value => Math.min(2, value + 1))}><span>+</span><small>OCT</small></Surface>
              <Surface as="button" type="button" material="charcoal" elevation={BODY_HEIGHT + 2} thickness={3} bevelWidth={2} shape={{ kind: "roundedRect", radius: 8 }} radius={8} className="form-control form-control-dark" aria-label="Next waveform" onClick={() => setTone(TONES[(TONES.indexOf(tone) + 1) % TONES.length])}><span>~</span><small>WAVE</small></Surface>
            </div>
          </div>
          <div className="form-playing-area">
            <div className="form-steps" aria-label="Step sequencer">{pattern.map((note, index) => <Surface as="button" type="button" key={index} material="ivory" elevation={BODY_HEIGHT + (step === index ? 0.5 : 1.5)} thickness={step === index ? 0.5 : 1.5} bevelWidth={1} shape={{ kind: "roundedRect", radius: 5 }} radius={5} className="form-step" data-current={step === index}
              aria-label={`Step ${index + 1}: ${note < 0 ? "rest" : noteLabel(note, octave)}`} aria-pressed={note >= 0}
              onClick={() => { setPattern(previous => previous.map((item, i) => i === index ? item < 0 || item !== selectedNote ? selectedNote : -1 : item)); setMessage(`Step ${index + 1} edited.`); }}><span className="form-step-dot" data-enabled={note >= 0} /></Surface>)}</div>
            <div className="form-keyboard" aria-label="Two octave keyboard">
              <div className="form-black-keys">{BLACK_KEYS.map(index => key(index, true))}</div>
              <div className="form-white-keys">{WHITE_KEYS.map(index => key(index))}</div>
            </div>
          </div>
        </div>
        </div>
      </Ukibori>
    </div>
    <p className="form-status" role="status">{message}</p>
    <details className="form-help"><summary>Playing ripple</summary><p>Play the labeled computer keys, or tap any piano key. Space starts and stops the sequence. Select a note, then tap a step to add it; tap again for a rest. STEP plays one step while stopped. Drag the knobs vertically, or focus their range controls and use the arrow keys.</p><label>Volume <input type="range" min={0} max={0.8} step={0.01} value={volume} onChange={event => setVolume(Number(event.target.value))} /></label><button type="button" onClick={() => { setPattern(INITIAL); setMessage("Original pattern restored."); }}>Restore pattern</button><a href="/#product">Ukibori dashboard</a><span>Renderer: {backend}</span></details>
  </main>;
}
