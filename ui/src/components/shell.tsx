// App-shell components: flow steps, transport bar, planned pages.

import type { ReactNode } from "react";
import { chordAt, contextFor, describe, fmtTime, sectionAt, shownChords } from "../chart";
import { useShowGuesses } from "../session/useShowGuesses";
import { engine } from "../engine";
import type { useProject } from "../useProject";
import { defaultMix } from "../song";
import { roleOf } from "./music";
import { Button } from "./ui";

type P = ReturnType<typeof useProject>;
export type Workspace = "library" | "session" | "prepare" | "tuner" | "settings";

// ---------- flow steps ----------

export function FlowSteps({ p, current, go }: { p: P; current: Workspace; go: (w: Workspace, sub?: string) => void }) {
  const chords = p.chart.chords;
  const confirmed = chords.filter((c) => c.confirmed).length;
  // Review is done only when every chord was confirmed by the user.
  const reviewed = chords.length > 0 && confirmed === chords.length;
  const guitarStems = p.stems.filter((s) => roleOf(s) === "guitar");
  const guitarsMuted = guitarStems.length > 0 && guitarStems.every((s) => p.song?.mixer[s.id]?.mute);
  const prepared = reviewed && !!p.song?.preparedAt;
  const steps: { key: string; label: string; detail: string; state: "done" | "todo" | "planned"; to: [Workspace, string?] }[] = [
    { key: "import", label: "Import", detail: "song added", state: "done", to: ["library"] },
    { key: "analyze", label: "Analyze", detail: p.analysis ? "stems + chords" : "not yet", state: p.analysis ? "done" : "todo", to: ["prepare", "stems"] },
    { key: "review", label: "Review", detail: chords.length ? `${chords.length - confirmed} chords to check` : "no chords yet", state: reviewed ? "done" : "todo", to: ["prepare", "chart"] },
    { key: "prepare", label: "Prepare", detail: guitarsMuted ? "guitars muted" : "capo, parts, cues", state: prepared ? "done" : "todo", to: ["prepare", "chart"] },
    { key: "session", label: "Session", detail: "play along, record", state: "todo", to: ["session"] },
  ];
  const currentKey = current === "session" ? "session" : current === "prepare" ? "prepare" : "";
  return (
    <ol className="flow" aria-label="Song preparation steps">
      {steps.map((s, i) => (
        <li key={s.key} className={`flow-step is-${s.state}${s.key === currentKey ? " is-current" : ""}`}>
          <button onClick={() => go(...s.to)} title={s.detail} aria-current={s.key === currentKey ? "step" : undefined}>
            <span className="sr-only">{s.state === "done" ? "Done: " : s.state === "planned" ? "Planned: " : "To do: "}</span>
            <span className="flow-mark" aria-hidden>
              {s.state === "done" ? "✓" : s.state === "planned" ? "…" : s.key === currentKey ? "▸" : i + 1}
            </span>
            <span className="flow-text">
              <span className="flow-label">
                {s.label}
                {s.key === "review" && s.state !== "done" && chords.length > 0 && <span className="flow-count">{chords.length - confirmed} left</span>}
              </span>
              <span className="flow-detail">{s.state === "done" ? "Done" : s.detail}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

// ---------- transport ----------

export function TransportBar({ p, pos, playing, onPlay }: { p: P; pos: number; playing: boolean; onPlay: () => void }) {
  const { song, analysis, chart, update, stems, duration } = p;
  const [showGuesses] = useShowGuesses();
  if (!song) return null;
  const ctx = contextFor(song, analysis);
  const shown = shownChords(chart.chords, showGuesses); // chart chords only, unless guesses are switched on
  const idx = chordAt(shown, pos);
  const now = idx >= 0 ? describe(shown[idx].chord, ctx) : null;
  const section = chart.sections[sectionAt(chart.sections, pos)];
  const guitars = stems.filter((s) => roleOf(s) === "guitar");
  const guitarsMuted = guitars.length > 0 && guitars.every((g) => song.mixer[g.id]?.mute);
  const toggleGuitars = () =>
    update((s) => {
      const mixer = { ...s.mixer };
      for (const g of guitars) mixer[g.id] = { ...(mixer[g.id] ?? defaultMix(g)), mute: !guitarsMuted };
      return { ...s, mixer };
    });

  return (
    <div className="transport" id="transport" role="toolbar" aria-label="Transport" tabIndex={-1}>
      <div className="tp-group">
        <Button variant="primary" size="lg" className="tp-play" onClick={onPlay} aria-label={playing ? "Pause" : "Play"} title="Space">
          {playing ? "❚❚" : "▶"}
        </Button>
        <Button variant="quiet" onClick={() => engine.seek(Math.max(0, pos - 5))} title="Back 5 s (←)" aria-label="Back 5 seconds">
          −5
        </Button>
        <Button variant="quiet" onClick={() => engine.seek(pos + 5)} title="Forward 5 s (→)" aria-label="Forward 5 seconds">
          +5
        </Button>
      </div>
      <div className="tp-where">
        <span className="num tp-time">
          {fmtTime(pos)} <span className="muted">/ {fmtTime(duration)}</span>
        </span>
        <span className="tp-section">{pos < 0 ? "Count-in" : section?.label ?? "—"}</span>
      </div>
      <div className="tp-chord" role="group" aria-label="Current chord">
        <span className="tp-sounding">{now?.concert ?? "—"}</span>
        <span className="tp-nash">{now?.nashville}</span>
        {now?.shapeDiffers && now.shape && <span className="tp-shape">play {now.shape}</span>}
      </div>
      <div className="tp-group tp-toggles">
        <Button
          size="sm"
          pressed={!!song.loop?.enabled}
          disabled={!song.loop}
          onClick={() => update((s) => ({ ...s, loop: { ...s.loop!, enabled: !s.loop!.enabled } }), "loop")}
          title={song.loop ? `Loop ${fmtTime(song.loop.a)}–${fmtTime(song.loop.b)} (L)` : "Drag on the timeline or use Loop section to set a loop"}
        >
          Loop
        </Button>
        <Button
          size="sm"
          disabled={!section}
          onClick={() => section && update((s) => ({ ...s, loop: { a: section.start, b: section.end, enabled: true } }), "loop")}
          title="Loop the current section"
        >
          Loop section
        </Button>
        <Button size="sm" pressed={song.click.countInBars > 0} onClick={() => update((s) => ({ ...s, click: { ...s.click, countInBars: s.click.countInBars ? 0 : s.click.lastCountInBars ?? 1, lastCountInBars: s.click.countInBars || s.click.lastCountInBars } }))} title="Count-in before playback">
          Count-in
        </Button>
        <Button size="sm" pressed={song.click.enabled} onClick={() => update((s) => ({ ...s, click: { ...s.click, enabled: !s.click.enabled } }))} title="Metronome (K)">
          Click
        </Button>
        <Button size="sm" pressed={song.cues.enabled} onClick={() => update((s) => ({ ...s, cues: { ...s.cues, enabled: !s.cues.enabled } }))} title="Spoken cues">
          Cues
        </Button>
      </div>
      <div className="tp-group tp-end">
        {guitars.length > 0 ? (
          <Button size="lg" variant={guitarsMuted ? "primary" : "secondary"} pressed={guitarsMuted} className="tp-guitars" onClick={toggleGuitars} title="M">
            {guitarsMuted ? "Ref. guitars muted" : "Mute ref. guitars"}
          </Button>
        ) : (
          <span className="muted small tp-hint">Analyze to get stems</span>
        )}
      </div>
    </div>
  );
}

// ---------- planned page ----------

export function PlannedPage({ title, milestone, items, children }: { title: string; milestone: string; items: string[]; children?: ReactNode }) {
  return (
    <div className="planned">
      <span className="pill pill-planned">Planned · {milestone}</span>
      <h1>{title}</h1>
      <p className="muted">This workspace is not built yet. Nothing here records or processes audio.</p>
      <ul>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
      {children}
    </div>
  );
}
