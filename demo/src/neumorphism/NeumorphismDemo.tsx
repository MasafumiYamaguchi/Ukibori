import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import { Surface, Ukibori, UkiboriText } from "ukibori";

type IconName =
  | "arrow"
  | "check"
  | "droplet"
  | "headphones"
  | "leaf"
  | "moon"
  | "pause"
  | "play"
  | "reset"
  | "sun";

const iconPaths: Record<IconName, ReactElement> = {
  arrow: <path d="m9 18 6-6-6-6" />,
  check: <path d="m5 12 4 4L19 6" />,
  droplet: <path d="M12 3S6 9.4 6 14a6 6 0 0 0 12 0c0-4.6-6-11-6-11Z" />,
  headphones: <path d="M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H4zm13 0h3v6h-3z" />,
  leaf: <path d="M5 21c1-7 5-12 14-16 0 9-4 14-11 14M5 21c2-5 6-8 11-11" />,
  moon: <path d="M20 15.5A8 8 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" />,
  pause: <path d="M9 7v10m6-10v10" />,
  play: <path d="m9 7 8 5-8 5Z" />,
  reset: <path d="M4 12a8 8 0 1 0 2.3-5.7L4 8m0-5v5h5" />,
  sun: <path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0-4v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />,
};

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      {iconPaths[name]}
    </svg>
  );
}

const pad = (value: number) => String(value).padStart(2, "0");

export function NeumorphismDemo() {
  const todayLabel = useMemo(
    () => new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(new Date()),
    [],
  );
  const [seconds, setSeconds] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [selectedMode, setSelectedMode] = useState<"focus" | "rest">("focus");
  const [lightAngle, setLightAngle] = useState(225);
  const [completed, setCompleted] = useState(() => new Set(["water", "stretch"]));

  useEffect(() => {
    if (!running || seconds <= 0) return;
    const timer = window.setInterval(() => setSeconds((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [running, seconds]);

  useEffect(() => {
    if (seconds === 0) setRunning(false);
  }, [seconds]);

  const light = useMemo(() => {
    const radians = (lightAngle * Math.PI) / 180;
    return { x: Math.cos(radians), y: Math.sin(radians), z: 1 };
  }, [lightAngle]);

  const setMode = (mode: "focus" | "rest") => {
    setSelectedMode(mode);
    setRunning(false);
    setSeconds(mode === "focus" ? 25 * 60 : 5 * 60);
  };

  const toggleHabit = (id: string) => {
    setCompleted((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const progress = selectedMode === "focus" ? 68 : 32;

  return (
    <Ukibori
      backend="auto"
      className="aura-stage"
      color="#e7ecf2"
      compositing={{ shadowAlpha: 0.24 }}
      // This is a full-page scene. Keep its 1D compute dispatch below the
      // WebGPU per-dimension limit even on high-DPI displays; otherwise the
      // demo honestly falls back to the much slower CPU reference path.
      dpr={1}
      environment={{ intensity: 0.62, diffuseIntensity: 1, specularIntensity: 0.72 }}
      exposure={1.04}
      light={light}
      margin={38}
      shadow={{ bias: 0.22, maxDistance: 100 }}
    >
      <div className="aura-shell">
        <header className="topbar">
          <a className="brand" href="#top" aria-label="Aura home">
            <span className="brand-mark"><span /></span>
            <span>AURA</span>
          </a>

          <nav aria-label="Primary navigation">
            <a className="nav-link active" href="#today">Today</a>
            <a className="nav-link" href="#rituals">Rituals</a>
            <a className="nav-link" href="#insights">Insights</a>
          </nav>

          <Surface
            as="button"
            aria-label="Appearance"
            className="icon-button profile-button"
            elevation={5}
            material="matte"
            onClick={() => setLightAngle((angle) => (angle + 45) % 360)}
            shape={{ kind: "roundedRect", radius: 18 }}
            thickness={2.4}
            type="button"
          >
            <Icon name="sun" />
          </Surface>
        </header>

        <main id="top">
          <section className="welcome" id="today">
            <div>
              <p className="eyebrow">{todayLabel.replace(",", " ·")}</p>
              <h1>Good morning,<br /><span>Masafumi.</span></h1>
              <p className="welcome-copy">Small rituals, shaped into a calmer day.</p>
            </div>
            <div className="day-score" aria-label={`${progress}% daily rhythm`}>
              <span>{progress}</span><small>%</small>
              <p>daily rhythm</p>
            </div>
          </section>

          <section className="dashboard" aria-label="Wellness dashboard">
            <Surface
              className="focus-card"
              elevation={5}
              material="silicone"
              sceneId="focus-card"
              shape={{ kind: "roundedRect", radius: 34 }}
              thickness={3.5}
              bevelWidth={5}
            >
              <div className="card-kicker"><span className="live-dot" /> Now playing</div>
              <div className="focus-content">
                <div>
                  <UkiboriText
                    className="focus-word"
                    elevation={2}
                    material="metal"
                    text="FOCUS"
                    thickness={0.9}
                  />
                  <p>Deep work · soft rain</p>
                </div>
                <div className="timer" aria-live="polite">
                  {pad(Math.floor(seconds / 60))}<span>:</span>{pad(seconds % 60)}
                </div>
              </div>
              <div className="player-controls">
                <div className="mode-switch" aria-label="Timer duration">
                  <button className={selectedMode === "focus" ? "selected" : ""} onClick={() => setMode("focus")} type="button">Focus</button>
                  <button className={selectedMode === "rest" ? "selected" : ""} onClick={() => setMode("rest")} type="button">Rest</button>
                </div>
                <div className="play-actions">
                  <button className="bare-icon" aria-label="Reset timer" onClick={() => setMode(selectedMode)} type="button"><Icon name="reset" size={18} /></button>
                  <Surface
                    as="button"
                    aria-label={running ? "Pause timer" : "Start timer"}
                    className="play-button"
                    elevation={running ? 2 : 9}
                    material="metal"
                    onClick={() => setRunning((value) => !value)}
                    shape={{ kind: "roundedRect", radius: 999 }}
                    thickness={3}
                    type="button"
                  >
                    <Icon name={running ? "pause" : "play"} size={24} />
                  </Surface>
                  <button className={`bare-icon ${soundOn ? "active" : ""}`} aria-label="Toggle sound" onClick={() => setSoundOn((value) => !value)} type="button"><Icon name="headphones" size={18} /></button>
                </div>
              </div>
            </Surface>

            <Surface
              className="metric-card metric-water"
              elevation={4}
              material="matte"
              sceneId="water-card"
              shape={{ kind: "roundedRect", radius: 28 }}
              thickness={2.5}
            >
              <div className="metric-icon"><Icon name="droplet" /></div>
              <div className="metric-number">1.6 <small>L</small></div>
              <p>Hydration</p>
              <div className="meter"><span style={{ width: "64%" }} /></div>
              <small>0.9 L to goal</small>
            </Surface>

            <Surface
              className="metric-card metric-sleep"
              elevation={4}
              material="matte"
              sceneId="sleep-card"
              shape={{ kind: "roundedRect", radius: 28 }}
              thickness={2.5}
            >
              <div className="metric-icon"><Icon name="moon" /></div>
              <div className="metric-number">7<small>h</small> 42<small>m</small></div>
              <p>Deep sleep</p>
              <div className="sleep-bars" aria-hidden="true">
                {[32, 54, 76, 63, 88, 72, 46, 67, 82, 58, 73, 40].map((height, index) => (
                  <span key={index} style={{ height: `${height}%` }} />
                ))}
              </div>
              <small>12% above average</small>
            </Surface>

            <Surface
              className="ritual-card"
              elevation={3}
              material="silicone"
              sceneId="ritual-card"
              shape={{ kind: "roundedRect", radius: 30 }}
              thickness={2.5}
              id="rituals"
            >
              <div className="section-heading">
                <div><p className="eyebrow">Your rhythm</p><h2>Morning rituals</h2></div>
                <span>{completed.size}/3</span>
              </div>
              <div className="ritual-list">
                {[
                  { id: "water", label: "Drink water", meta: "2 min", icon: "droplet" as const },
                  { id: "stretch", label: "Mindful stretch", meta: "8 min", icon: "sun" as const },
                  { id: "walk", label: "Quiet walk", meta: "15 min", icon: "leaf" as const },
                ].map((item) => {
                  const done = completed.has(item.id);
                  return (
                    <button className={`ritual-row ${done ? "done" : ""}`} key={item.id} onClick={() => toggleHabit(item.id)} type="button">
                      <span className="ritual-icon"><Icon name={item.icon} size={18} /></span>
                      <span><strong>{item.label}</strong><small>{item.meta}</small></span>
                      <span className="check">{done && <Icon name="check" size={15} />}</span>
                    </button>
                  );
                })}
              </div>
            </Surface>

            <Surface
              className="light-card"
              elevation={3}
              material="matte"
              sceneId="light-card"
              shape={{ kind: "roundedRect", radius: 30 }}
              thickness={2.5}
              id="insights"
            >
              <p className="eyebrow">Physical light</p>
              <h2>Shape the atmosphere</h2>
              <div className="light-orbit" style={{ "--angle": `${lightAngle}deg` } as CSSProperties}>
                <span className="orbit-line" /><span className="orbit-sun"><Icon name="sun" size={17} /></span>
                <span className="orbit-center" />
              </div>
              <label htmlFor="light-angle">Direction <output>{lightAngle}°</output></label>
              <input id="light-angle" type="range" min="0" max="359" value={lightAngle} onChange={(event) => setLightAngle(Number(event.target.value))} />
              <p className="light-note">One shared source lights every Ukibori surface.</p>
            </Surface>
          </section>
        </main>

        <footer>
          <span>Rendered with <strong>Ukibori</strong></span>
          <a href="/">Explore the renderer <Icon name="arrow" size={16} /></a>
        </footer>
      </div>
    </Ukibori>
  );
}
