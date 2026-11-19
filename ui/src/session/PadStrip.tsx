import { useEffect, useState } from "react";
import { Meter } from "../components/music";
import { Button } from "../components/ui";
import { engine, type PadFlavor } from "../engine";
import { noteName } from "../theory/notes";

/** Key names as worship charts usually write them */
const KEYS = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

const STORE = "wsa.pad";

interface PadPrefs {
  on: boolean;
  /** "song" = follow the song's key (as played, after transpose); otherwise a pitch class 0-11 */
  key: "song" | number;
  level: number;
  flavor: PadFlavor;
}

function load(): PadPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) || "null");
    if (v && typeof v.level === "number") return { key: "song", flavor: "warm", ...v, on: false }; // never starts by itself
  } catch {
    /* first run */
  }
  return { on: false, key: "song", level: 0.5, flavor: "warm" };
}

/**
 * Ambient pad (a soft drone on the key's root, fifth and octave, made in code). A mixer strip: on/off, key
 * (the song's key by default), Warm or Shimmer, level. It plays with or without the song and stops when the
 * screen closes. `songKey` = the key as played (pitch class) when a song is open.
 */
export function PadStrip({ songKey, flats = true }: { songKey?: number; flats?: boolean }) {
  const [p, setP] = useState<PadPrefs>(load);
  const key = p.key === "song" ? songKey ?? 0 : p.key;

  useEffect(() => {
    engine.padSet({ on: p.on, key, level: p.level, flavor: p.flavor }).catch(() => {});
  }, [p.on, key, p.level, p.flavor]);
  useEffect(() => () => void engine.padSet({ on: false }).catch(() => {}), []);

  const update = (patch: Partial<PadPrefs>) => {
    const next = { ...p, ...patch };
    setP(next);
    try {
      localStorage.setItem(STORE, JSON.stringify(next));
    } catch {
      /* not remembered */
    }
  };

  return (
    <div className="strip pad-strip">
      <div className="strip-name" title="Ambient pad: a soft drone on the key's root, fifth and octave (fits major and minor chords)">
        <i className="role-dot role-pad" aria-hidden /> Pad
      </div>
      <Meter peak={0} vertical />
      <input type="range" className="strip-fader" min={0} max={100} value={Math.round(p.level * 100)} aria-label="Pad level"
        aria-valuetext={`${Math.round(p.level * 100)} percent`} onChange={(e) => update({ level: +e.target.value / 100 })} />
      <select aria-label="Pad key" value={String(p.key)} onChange={(e) => update({ key: e.target.value === "song" ? "song" : +e.target.value })}>
        {songKey !== undefined && <option value="song">Song key ({noteName(songKey, flats)})</option>}
        {KEYS.map((name, i) => (
          <option key={i} value={i}>
            {name}
          </option>
        ))}
      </select>
      <select aria-label="Pad sound" value={p.flavor} onChange={(e) => update({ flavor: e.target.value as PadPrefs["flavor"] })}>
        <option value="warm" title="Soft, dark drone">Warm</option>
        <option value="shimmer" title="Airy octave-up layers that twinkle, long bright reverb (Hillsong / Bethel ambient style)">Shimmer</option>
        <option value="analog" title="Synth pad with a sub octave and a slow filter swell (Elevation-style)">Analog swell</option>
        <option value="organ" title="Drawbar organ with a slow rotary swirl (gospel / Maverick City keys)">Gospel organ</option>
      </select>
      <div className="strip-btns">
        <Button size="sm" pressed={p.on} onClick={() => update({ on: !p.on })} title="Fades in and out over 3 s; changing key crossfades">
          {p.on ? "On" : "Off"}
        </Button>
      </div>
    </div>
  );
}
