// Music-specific components: roles, meters, track strips, chord cards, shape picker.

import { useEffect, useState } from "react";
import type { ChordView } from "../chart";
import type { MixState, StemInfo } from "../song";
import { parseChord, transposeChord } from "../theory/chords";
import { cagedShapes, OPEN_SHAPES, shapeInTuning, type Tuning } from "../theory/guitar";
import { ChordDiagram } from "./ChordDiagram";
import { Button, Confidence } from "./ui";

// ---------- roles ----------

export type Role = "takes" | "vocals" | "guitar" | "keys" | "bass" | "drums" | "other";
export const ROLE_LABEL: Record<Role, string> = {
  takes: "Your takes",
  vocals: "Vocals",
  guitar: "Guitars",
  keys: "Keys",
  bass: "Bass",
  drums: "Drums",
  other: "Other",
};
export function roleOf(s: { id: string; group?: string }): Role {
  if (s.id.startsWith("take:")) return "takes";
  if (s.group === "guitar" || s.id.startsWith("guitar")) return "guitar";
  if (s.id === "vocals") return "vocals";
  if (s.id === "piano") return "keys";
  if (s.id === "bass") return "bass";
  if (s.id === "drums") return "drums";
  return "other";
}
export function RoleDot({ role }: { role: Role }) {
  return <span className={`role-dot role-${role}`} aria-hidden />;
}

// ---------- meter ----------

/** Peak meter (linear peak 0..1+). Shows "CLIP" text, not just red. */
export function Meter({ peak, vertical, showClip = false }: { peak: number; vertical?: boolean; showClip?: boolean }) {
  const db = peak > 0 ? 20 * Math.log10(peak) : -90;
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const clip = showClip && peak >= 0.999; // a float stem above 0 dBFS is fine; only the output can clip
  return (
    <div className={`meter${vertical ? " meter-v" : ""}${clip ? " is-clip" : ""}`} title={peak > 0 ? `${db.toFixed(1)} dBFS peak` : "no signal"}>
      <div className="meter-fill" style={vertical ? { height: `${pct}%` } : { width: `${pct}%` }} />
      {clip && <span className="meter-clip">CLIP</span>}
    </div>
  );
}

// ---------- track strip ----------

export function TrackStrip({
  stem,
  mix,
  peak,
  onChange,
  indent,
  anySolo = false,
}: {
  stem: StemInfo;
  mix: MixState;
  peak: number;
  onChange: (m: Partial<MixState>) => void;
  indent?: boolean;
  /** some part is on Solo: parts that are not are silent */
  anySolo?: boolean;
}) {
  const role = roleOf(stem);
  // Same rule as the engine: while any part is on Solo, only soloed parts play (Solo wins over Mute).
  const muted = mix.mute && !(anySolo && mix.solo);
  const silenced = anySolo && !mix.solo && !mix.mute;
  return (
    <div className={`track${muted ? " is-muted" : ""}${silenced ? " is-silenced" : ""}${indent ? " is-child" : ""}`}>
      <div className="track-name">
        <RoleDot role={role} />
        <span className="track-title" title={stem.hint ? `${stem.name} — ${stem.hint}` : stem.name}>
          {indent ? stem.name.replace(/^Guitar\s*-\s*/i, "").replace(/^\w/, (c) => c.toUpperCase()) : stem.name}
        </span>
        {stem.experimental && !indent && <span className="pill pill-warn" title="Separated by stereo position only. Expect leakage.">Estimate</span>}
        {silenced && (
          <span className="pill" title="Another part is on Solo, so this one is silent.">
            Silent (solo)
          </span>
        )}
      </div>
      <Meter peak={muted || silenced ? 0 : peak} />
      <input
        type="range"
        className="fader"
        min={0}
        max={150}
        value={Math.round(mix.gain * 100)}
        aria-label={`${stem.name} level`}
        aria-valuetext={`${Math.round(mix.gain * 100)} percent`}
        onChange={(e) => onChange({ gain: +e.target.value / 100 })}
        onDoubleClick={() => onChange({ gain: 1 })}
        title="Double-click to reset to 100%"
      />
      <span className="num track-gain">{Math.round(mix.gain * 100)}%</span>
      <Button size="sm" pressed={mix.mute} className="ms ms-mute" onClick={() => onChange({ mute: !mix.mute })} aria-label={`Mute ${stem.name}`}>
        {mix.mute ? "Muted" : "Mute"}
      </Button>
      <Button size="sm" pressed={mix.solo} className="ms ms-solo" onClick={() => onChange({ solo: !mix.solo })} aria-label={`Solo ${stem.name}`}>
        Solo
      </Button>
    </div>
  );
}

/** A role group (e.g. Guitars) with one master mute and expandable child parts. */
export function TrackGroup({
  role,
  stems,
  mixOf,
  peaks,
  onChange,
  note,
  anySolo = false,
}: {
  role: Role;
  stems: StemInfo[];
  mixOf: (id: string) => MixState;
  peaks: Record<string, number>;
  onChange: (id: string, m: Partial<MixState>) => void;
  note?: string;
  anySolo?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (stems.length === 1)
    return <TrackStrip stem={stems[0]} mix={mixOf(stems[0].id)} peak={peaks[stems[0].id] ?? 0} onChange={(m) => onChange(stems[0].id, m)} anySolo={anySolo} />;
  const allMuted = stems.every((s) => mixOf(s.id).mute);
  const audible = (s: StemInfo) => (anySolo ? mixOf(s.id).solo : !mixOf(s.id).mute); // engine rule: Solo wins over Mute
  const allSilenced = !allMuted && anySolo && !stems.some(audible);
  const peak = Math.max(0, ...stems.filter(audible).map((s) => peaks[s.id] ?? 0));
  return (
    <div className="track-group">
      <div className={`track is-group${allMuted ? " is-muted" : ""}${allSilenced ? " is-silenced" : ""}`}>
        <div className="track-name">
          <button className="disclosure" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} ${ROLE_LABEL[role]} parts`} onClick={() => setOpen(!open)}>
            {open ? "▾" : "▸"}
          </button>
          <RoleDot role={role} />
          <span className="track-title">
            {ROLE_LABEL[role]} <span className="muted">· {stems.length} parts</span>
          </span>
          {allSilenced && (
            <span className="pill" title="Another part is on Solo, so these are silent.">
              Silent (solo)
            </span>
          )}
        </div>
        <Meter peak={peak} />
        <span />
        <span />
        <Button size="sm" pressed={allMuted} className="ms ms-mute" aria-label={`${allMuted ? "Unmute" : "Mute"} all ${ROLE_LABEL[role]}`} onClick={() => stems.forEach((s) => onChange(s.id, { mute: !allMuted }))}>
          {allMuted ? "Muted" : "Mute"}
        </Button>
        <span />
      </div>
      {open && (
        <>
          {note && <p className="track-note">{note}</p>}
          {stems.map((s) => (
            <TrackStrip key={s.id} stem={s} mix={mixOf(s.id)} peak={peaks[s.id] ?? 0} onChange={(m) => onChange(s.id, m)} indent anySolo={anySolo} />
          ))}
        </>
      )}
    </div>
  );
}

// ---------- master strip ----------

export function MasterStrip({
  gain,
  limiter,
  meters,
  onChange,
}: {
  gain: number;
  limiter: boolean;
  meters: Record<string, number>;
  onChange: (m: { gain?: number; limiter?: boolean }) => void;
}) {
  const [clipLatched, setClipLatched] = useState(false);
  const gr = meters.__limiterDb ?? 0;
  const clippedNow = !!(meters as any).__clipped;
  useEffect(() => {
    if (clippedNow) setClipLatched(true);
  }, [clippedNow]);
  return (
    <div className="track is-master">
      <div className="track-name">
        <span className="track-title strong">Master</span>
        {clipLatched ? (
          <button className="pill pill-danger" onClick={() => setClipLatched(false)} title="The output went over 0 dBFS. Click to reset.">
            Clipped · reset
          </button>
        ) : limiter && gr < -0.5 ? (
          <span className="pill pill-warn" title="The safety limiter is turning peaks down">Limiting {gr.toFixed(1)} dB</span>
        ) : null}
      </div>
      <Meter peak={meters.__master ?? 0} showClip />
      <input
        type="range"
        className="fader"
        min={0}
        max={120}
        value={Math.round(gain * 100)}
        aria-label="Master level"
        aria-valuetext={`${(20 * Math.log10(Math.max(gain, 0.001))).toFixed(1)} decibels`}
        onChange={(e) => onChange({ gain: +e.target.value / 100 })}
        onDoubleClick={() => onChange({ gain: 0.71 })}
        title="Default 71% (-3 dB) leaves headroom so the limiter rarely works. Double-click to reset."
      />
      <span className="num track-gain">{(20 * Math.log10(Math.max(gain, 0.001))).toFixed(1)} dB</span>
      <Button size="sm" pressed={limiter} className="ms" onClick={() => onChange({ limiter: !limiter })} title="Safety limiter: keeps peaks under -1 dBFS so nothing distorts. Playback and export only, never recordings.">
        {limiter ? "Limiter on" : "Limiter off"}
      </Button>
      <span />
    </div>
  );
}

// ---------- chord card ----------

/** Sounding chord (big) · Nashville (accent) · shape to play (small + diagram). */
export function ChordCard({
  view,
  confidence,
  confirmed,
  active,
  selected,
  size = "md",
  showDiagram = true,
  onClick,
  index,
}: {
  index?: number;
  view: ChordView;
  confidence?: number;
  confirmed?: boolean;
  active?: boolean;
  selected?: boolean;
  size?: "md" | "xl";
  showDiagram?: boolean;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      className={`chord-card size-${size}${confirmed ? " is-confirmed" : " is-estimate"}${active ? " is-active" : ""}${selected ? " is-selected" : ""}`}
      onClick={onClick}
      aria-pressed={onClick ? !!selected : undefined}
      data-chord-index={index}
      aria-current={active ? "time" : undefined}
      aria-label={onClick ? `${view.concert}, ${view.nashville}${view.shapeDiffers && view.shape ? `, play ${view.shape}` : ""}, ${confirmed ? "confirmed" : "estimate"}` : undefined}
    >
      <span className="cc-sounding">{view.concert}</span>
      <span className="cc-nash">{view.nashville || " "}</span>
      {view.shapeDiffers && <span className="cc-shape">{view.shape ? <>play <b>{view.shape}</b></> : "no std shape"}</span>}
      {showDiagram && view.diagram && <ChordDiagram shape={view.diagram} size={size === "xl" ? 72 : 46} />}
      {showDiagram && view.diagram && view.diagramNote && (
        <span className="cc-note" title={view.diagramNote === "triad" ? "No stored shape for this chord: basic triad shown" : "Standard shape re-fretted for this tuning"}>
          {view.diagramNote === "triad" ? "triad only" : "adapted"}
        </span>
      )}
      {!confirmed && size !== "xl" && <Confidence value={confidence} compact />}
    </Tag>
  );
}

// ---------- shape picker: open vs CAGED ----------

export function ShapeCompare({ shapeName, tuning }: { shapeName: string; tuning: Tuning }) {
  const c = parseChord(shapeName);
  if (!c) return null;
  // Every option is shown as it is played in the current tuning (re-fretted strings are marked).
  const openStd = OPEN_SHAPES[shapeName];
  const openT = openStd ? shapeInTuning(openStd, tuning) : undefined;
  const open = openT?.shape;
  const caged = cagedShapes(transposeChord(c, 0)).map((s) => {
    const t = shapeInTuning(s.shape, tuning);
    return { ...s, shape: t.shape, adapted: t.adapted };
  });
  return (
    <div className="shape-compare">
      {open && (
        <figure>
          <ChordDiagram shape={open} size={72} />
          <figcaption>
            Open{open.barre ? " (barre)" : ""}
            {openT?.adapted ? " · adapted" : ""}
          </figcaption>
        </figure>
      )}
      {caged.filter((s) => !(open && s.fret === 0 && s.shape.frets.join() === open.frets.join())).map((s) => (
        <figure key={s.form}>
          <ChordDiagram shape={s.shape} size={72} />
          <figcaption>
            {s.form}-form · {s.fret === 0 ? "open" : `fret ${s.fret}`}
            {s.adapted ? " · adapted" : ""}
          </figcaption>
        </figure>
      ))}
      {caged[0]?.triadOnly && <p className="muted small">CAGED shapes show the basic triad; add the extra note yourself.</p>}
    </div>
  );
}
