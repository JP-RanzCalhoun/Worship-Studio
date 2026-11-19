import { useRef } from "react";
import { fmtTime } from "../chart";

/** Accepts "1:23.5", "83.5" or "83". Returns seconds or null. */
function parseTime(text: string): number | null {
  const m = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  return (m[1] ? +m[1] * 60 : 0) + +m[2];
}
import { Banner, Button, Card, Field, Segmented, Toggle, useConfirm } from "../components/ui";
import { engine } from "../engine";
import type { ClickSettings, CueItem } from "../song";
import { cuesFromSections } from "../timeline";
import type { useProject } from "../useProject";
import { useTransport } from "../useProject";

type P = ReturnType<typeof useProject>;

export function PrepareCues({ p }: { p: P }) {
  const { song, analysis, update, chart, cueStatus } = p;
  const { pos } = useTransport();
  const confirm = useConfirm();
  const taps = useRef<number[]>([]);
  if (!song) return null;
  const click = song.click;
  const setClick = (c: Partial<ClickSettings>, key = "click") => update((s) => ({ ...s, click: { ...s.click, ...c } }), key);
  const setItems = (fn: (items: CueItem[]) => CueItem[], key = "edit") =>
    update((s) => ({ ...s, cues: { ...s.cues, items: fn(s.cues.items).sort((a, b) => a.t - b.t) } }), key);
  const r = analysis?.rhythm;

  return (
    <div className="two-col">
      <Card
        title="Click"
        actions={<Toggle ariaLabel="Click" checked={click.enabled} onChange={(v) => setClick({ enabled: v })} label={click.enabled ? "On" : "Off"} />}
      >
        <p className="muted small">The click has its own volume and is never in an exported mix unless you choose it.</p>
        <div className="form-grid">
          <Field label="Volume">
            <input type="range" min={0} max={100} value={Math.round(click.gain * 100)} onChange={(e) => setClick({ gain: +e.target.value / 100 }, "click-gain")} />
          </Field>
          <Field label="Follow" group>
            <Segmented
              value={click.source}
              onChange={(v) => setClick({ source: v })}
              options={[
                { value: "beats", label: "Band's beats", title: "Follows the detected beats, including small tempo drifts" },
                { value: "fixed", label: "Fixed tempo" },
              ]}
            />
          </Field>
          {click.source === "beats" ? (
            <Field label="Feel" hint={r?.half_time?.likely ? "The beat finder's raw count was halved already. If the click feels too slow, choose Double." : r?.bpm && r.bpm > 110 ? "If the click feels twice too fast, choose Half." : undefined} group>
              <Segmented
                value={click.beatScale}
                onChange={(v) => setClick({ beatScale: v })}
                options={[
                  { value: 0.5, label: "Half" },
                  { value: 1, label: "As detected" },
                  { value: 2, label: "Double" },
                ]}
              />
            </Field>
          ) : (
            <>
              <Field label="BPM">
                <input type="number" min={30} max={250} step={0.5} value={click.bpm} onChange={(e) => setClick({ bpm: +e.target.value }, "bpm")} />
              </Field>
              <Field label="First beat at (seconds)" group>
                <div className="row-tight">
                  <Button
                    size="sm"
                    onClick={() => {
                      // Tap tempo: average of the last taps, reset after a 2 s pause.
                      const now = performance.now();
                      const last = taps.current[taps.current.length - 1];
                      taps.current = [...(last !== undefined && now - last > 2000 ? [] : taps.current), now].slice(-8);
                      if (taps.current.length >= 3) {
                        const d = (taps.current[taps.current.length - 1] - taps.current[0]) / (taps.current.length - 1);
                        setClick({ bpm: Math.round((60000 / d) * 2) / 2 }, "bpm");
                      }
                    }}
                    title="Tap 3 or more times in time with the song"
                  >
                    Tap
                  </Button>
                  <input aria-label="First beat at, seconds" type="number" step={0.01} value={click.offset} onChange={(e) => setClick({ offset: +e.target.value }, "offset")} />
                  <Button size="sm" onClick={() => setClick({ offset: Math.round(pos * 100) / 100 })}>
                    Use playhead
                  </Button>
                </div>
              </Field>
            </>
          )}
          <Field label={`Nudge · ${click.nudgeMs ?? 0} ms`} hint="Moves click and cues. Negative = earlier.">
            <input type="range" min={-80} max={80} step={5} value={click.nudgeMs ?? 0} onChange={(e) => setClick({ nudgeMs: +e.target.value }, "nudge")} onDoubleClick={() => setClick({ nudgeMs: 0 })} />
          </Field>
          <Field label="Beats per bar" group>
            <Segmented value={click.beatsPerBar} onChange={(v) => setClick({ beatsPerBar: v })} options={[2, 3, 4, 6].map((n) => ({ value: n, label: String(n) }))} />
          </Field>
          <Field label="Subdivision" group>
            <Segmented
              value={click.subdivision}
              onChange={(v) => setClick({ subdivision: v })}
              options={[
                { value: 1, label: "None" },
                { value: 2, label: "8ths" },
                { value: 3, label: "Triplets" },
                { value: 4, label: "16ths" },
              ]}
            />
          </Field>
          <Field label="Count-in" group>
            <Segmented
              value={click.countInBars}
              onChange={(v) => setClick({ countInBars: v })}
              options={[
                { value: 0, label: "Off" },
                { value: 1, label: "1 bar" },
                { value: 2, label: "2 bars" },
              ]}
            />
          </Field>
        </div>
        {r && (
          <Banner tone={r.downbeats_estimated ? "warn" : "info"}>
            Detected about {r.bpm ?? "?"} BPM, {r.time_signature ?? "unknown meter"}{r.method === "librosa" ? " (simple beat finder; the better one was not available)" : ""}.
            {r.downbeats_estimated ? " Bar starts are a guess. If the accent lands on the wrong beat, use Fixed tempo." : ""}
          </Banner>
        )}
      </Card>

      <Card
        title="Spoken cues"
        actions={<Toggle ariaLabel="Spoken cues" checked={song.cues.enabled} onChange={(v) => update((s) => ({ ...s, cues: { ...s.cues, enabled: v } }))} label={song.cues.enabled ? "On" : "Off"} />}
      >
        <p className="muted small">
          A cue says the section name one bar early. With “Count”, it also says “1 2 3 4” on the bar before. Voice: Windows speech, offline.
        </p>
        <div className="row-tight">
          <Field label="Volume">
            <input type="range" min={0} max={100} value={Math.round(song.cues.gain * 100)} onChange={(e) => update((s) => ({ ...s, cues: { ...s.cues, gain: +e.target.value / 100 } }), "cue-gain")} />
          </Field>
          <Button
            disabled={!chart.sections.length}
            onClick={async () => {
              if (!song.cues.items.length || (await confirm({ title: "Replace cues?", body: "Make one cue per section. Your current cue list is replaced (you can undo).", confirm: "Replace" })))
                setItems(() => cuesFromSections(chart.sections));
            }}
          >
            One cue per section
          </Button>
          <Button
            onClick={() => {
              const here = chart.sections.find((s) => pos >= s.start - 0.05 && pos < s.end);
              const label = here && !/^[A-Z]$/.test(here.label) ? here.label : "Verse";
              setItems((items) => [...items, { id: `cue-${Date.now()}`, t: Math.max(0, pos), text: label, count: false }]);
            }}
          >
            Add cue at playhead
          </Button>
        </div>
        {cueStatus && <Banner tone={cueStatus.startsWith("Spoken cues failed") ? "error" : "info"}>{cueStatus}</Banner>}
        {song.cues.items.length ? (
          <table className="table cue-table">
            <thead>
              <tr>
                <th>Starts (m:ss)</th>
                <th>Say</th>
                <th>Count</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {song.cues.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <input
                      key={c.t}
                      className="time-input num"
                      aria-label={`Start time of cue ${c.text}, minutes and seconds`}
                      defaultValue={fmtTime(c.t)}
                      onBlur={(e) => {
                        const t = parseTime(e.target.value);
                        if (t === null) {
                          e.target.value = fmtTime(c.t);
                          e.target.title = "Use minutes:seconds, for example 1:05.5";
                          e.target.setAttribute("aria-invalid", "true");
                        }
                        else setItems((it) => it.map((x) => (x.id === c.id ? { ...x, t } : x)));
                      }}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
                  </td>
                  <td>
                    <input aria-label="Words to say" value={c.text} onChange={(e) => setItems((it) => it.map((x) => (x.id === c.id ? { ...x, text: e.target.value } : x)), "cue-text-" + c.id)} />
                  </td>
                  <td>
                    <input type="checkbox" aria-label="Count 1 2 3 4" checked={c.count} onChange={(e) => setItems((it) => it.map((x) => (x.id === c.id ? { ...x, count: e.target.checked } : x)))} />
                  </td>
                  <td className="cell-actions">
                    <Button size="sm" variant="quiet" onClick={() => setItems((it) => it.map((x) => (x.id === c.id ? { ...x, t: Math.max(0, pos) } : x)))}>
                      Use playhead
                    </Button>
                    <Button size="sm" variant="quiet" onClick={() => engine.play(Math.max(0, c.t - 8))} title="Plays from 8 seconds before this cue">
                      Hear
                    </Button>
                    <Button size="sm" variant="quiet" onClick={() => setItems((it) => it.filter((x) => x.id !== c.id))} aria-label={`Delete cue ${c.text}`}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No cues yet.</p>
        )}
        <p className="muted small">Tip: a counted cue at 0:00 plays during the count-in. Set count-in to 2 bars so the name fits.</p>
      </Card>
    </div>
  );
}
