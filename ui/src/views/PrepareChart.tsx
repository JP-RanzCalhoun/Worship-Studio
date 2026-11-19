import { useEffect, useMemo, useState } from "react";
import { ALL_KEYS, chordAt, contextFor, describe, fmtTime, parseUserChord } from "../chart";
import { ChordCard, ShapeCompare } from "../components/music";
import { Banner, Button, Confidence, EmptyState, Field, Segmented, Toggle, useConfirm } from "../components/ui";
import { engine } from "../engine";
import type { ChordSeg, Section } from "../song";
import { chartOf } from "../song";
import { parseChord } from "../theory/chords";
import { isKnownChord } from "../theory/chordInfo";
import { parseTuning, suggestCapos, TUNINGS } from "../theory/guitar";
import { keyName } from "../theory/notes";
import type { useProject } from "../useProject";
import { useTransport } from "../useProject";

type P = ReturnType<typeof useProject>;
type Chart = { chords: ChordSeg[]; sections: Section[] };

export function PrepareChart({ p, goStems }: { p: P; goStems: () => void }) {
  const { song, analysis, update, chart, undo, redo, history } = p;
  const { pos } = useTransport();
  const confirm = useConfirm();
  const [sel, setSel] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [editErr, setEditErr] = useState("");
  const [customTuning, setCustomTuning] = useState("");
  const [customMode, setCustomMode] = useState(false);
  const [setupOpen, setSetupOpen] = useState(() => window.innerWidth > 1100);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1100px)");
    const onChange = () => setSetupOpen(!mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const ctx = useMemo(() => (song ? contextFor(song, analysis) : null), [song, analysis]);
  if (!song || !ctx) return null;

  const setChart = (fn: (c: Chart) => Chart) =>
    update((s) => ({ ...s, chart: fn(chartOf(s, analysis)), chartFromAnalysis: s.chart ? s.chartFromAnalysis : analysis?.createdAt }));
  const playingIdx = chordAt(chart.chords, pos);
  const uniqueChords = [...new Set(chart.chords.map((c) => describe(c.chord, ctx).concert).filter((c) => parseChord(c)))];
  const capoIdeas = suggestCapos(uniqueChords, ctx.playKey, ctx.tuning).slice(0, 4);
  const detected = analysis?.key;
  const confirmedCount = chart.chords.filter((c) => c.confirmed).length;
  // "Ready" needs both: the user marked it, and every chord is still confirmed (a reset or new estimates undo it).
  const ready = !!song.preparedAt && confirmedCount === chart.chords.length;

  const closeInspector = () => {
    const i = sel;
    setSel(null);
    // Focus goes back to the chord that was being edited, not to the page.
    window.setTimeout(() => document.querySelector<HTMLElement>(`[data-chord-index="${i}"]`)?.focus(), 0);
  };
  const select = (i: number) => {
    setSel(i);
    setDraft(describe(chart.chords[i].chord, ctx).concert);
    setEditErr("");
  };
  const commit = (i: number) => {
    const parsed = parseUserChord(draft, ctx);
    if (!parsed) return setEditErr(`"${draft}" is not a chord name or Nashville number.`);
    if (!isKnownChord(parsed)) return setEditErr(`"${parsed}" is not a chord I know. Check the spelling (e.g. Gadd9, Dsus4, D/F#, F#m7b5).`);
    setChart((c) => ({ ...c, chords: c.chords.map((x, j) => (j === i ? { ...x, chord: parsed, confirmed: true } : x)) }));
    setEditErr("");
    if (i + 1 < chart.chords.length) select(i + 1); // keep reviewing
  };
  const merge = (i: number) => {
    if (i === 0) return;
    setChart((c) => {
      const chords = [...c.chords];
      chords[i - 1] = { ...chords[i - 1], end: chords[i].end, user: true };
      chords.splice(i, 1);
      return { ...c, chords };
    });
    setSel(null);
  };
  const addAtPlayhead = () =>
    setChart((c) => {
      const i = chordAt(c.chords, pos);
      if (i < 0) {
        const nextStart = c.chords.find((x) => x.start > pos)?.start ?? p.duration;
        return { ...c, chords: [...c.chords, { start: pos, end: nextStart, chord: keyName(ctx.baseKey).replace(/m$/, ""), confirmed: false, confidence: 0, user: true }].sort((a, b) => a.start - b.start) };
      }
      const x = c.chords[i];
      if (pos - x.start < 0.2 || x.end - pos < 0.2) return c;
      const chords = [...c.chords];
      chords.splice(i, 1, { ...x, end: pos, user: true }, { ...x, start: pos, confirmed: false, confidence: 0, user: true });
      return { ...c, chords };
    });
  const newSection = () =>
    setChart((c) => {
      const secs = c.sections.length ? [...c.sections] : [{ start: 0, end: p.duration, label: "Song", suggested: false } as Section];
      const i = secs.findIndex((x) => pos > x.start + 0.5 && pos < x.end - 0.5);
      if (i < 0) return { ...c, sections: secs };
      secs.splice(i, 1, { ...secs[i], end: pos }, { start: pos, end: secs[i].end, label: "New section", suggested: false });
      return { ...c, sections: secs };
    });

  const sections = chart.sections.length ? chart.sections : [{ start: 0, end: Infinity, label: "Song" } as Section];
  const selChord = sel !== null ? chart.chords[sel] : null;
  const selView = selChord ? describe(selChord.chord, ctx) : null;

  return (
    <div className={`prepare-chart${selChord ? " has-inspector" : ""}`}>
      <a className="skip-link" href="#chords" onClick={(e) => { e.preventDefault(); document.querySelector<HTMLElement>("[data-chord-index]")?.focus(); }}>
        Skip to chords
      </a>
      {/* ---------- guitar setup ---------- */}
      <aside className={`setup-col card no-print${setupOpen ? "" : " is-collapsed"}`} aria-label="Guitar setup">
        <button className="setup-toggle" aria-expanded={setupOpen} onClick={() => setSetupOpen(!setupOpen)}>
          <h3>Guitar setup</h3>
          <span className="muted small">
            {song.capo ? `Capo ${song.capo}` : "No capo"} · {ctx.tuning.name.split(" (")[0]}
            {song.transpose ? ` · ${song.transpose > 0 ? "+" : ""}${song.transpose}` : ""} {setupOpen ? "▾" : "▸"}
          </span>
        </button>
        {setupOpen && (
          <>
        <Field label="Key of the recording">
          <select value={song.key ?? ""} onChange={(e) => update((s) => ({ ...s, key: e.target.value || undefined }))}>
            <option value="">{detected ? `Detected: ${detected.name}` : "Not detected"}</option>
            {ALL_KEYS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </Field>
        {detected && !song.key && (
          <p className="row-tight small">
            <Confidence value={detected.confidence} /> <span className="muted">or {detected.alternative}</span>
          </p>
        )}
        <Field label="Transpose" hint={`Band plays in ${keyName(ctx.playKey)}`} group>
          <div className="stepper">
            <Button size="sm" onClick={() => update((s) => ({ ...s, transpose: Math.max(-6, s.transpose - 1) }))} aria-label="Down a semitone">
              −
            </Button>
            <span className="num">{song.transpose > 0 ? `+${song.transpose}` : song.transpose}</span>
            <Button size="sm" onClick={() => update((s) => ({ ...s, transpose: Math.min(6, s.transpose + 1) }))} aria-label="Up a semitone">
              +
            </Button>
          </div>
        </Field>
        <Toggle checked={song.linkPitchToTranspose} onChange={(v) => update((s) => ({ ...s, linkPitchToTranspose: v }))} label="Shift playback pitch too" />
        <Field label="Capo">
          <select value={song.capo} onChange={(e) => update((s) => ({ ...s, capo: +e.target.value }))}>
            {Array.from({ length: 10 }, (_, i) => (
              <option key={i} value={i}>
                {i ? `Capo ${i}` : "No capo"}
              </option>
            ))}
          </select>
        </Field>
        {capoIdeas.length > 0 ? (
          <div className="capo-ideas" aria-label="Capo ideas">
            {capoIdeas.map((o) => (
              <button key={o.capo} className={`idea${o.capo === song.capo ? " is-on" : ""}`} onClick={() => update((s) => ({ ...s, capo: o.capo }))}>
                <b>{o.capo ? `Capo ${o.capo}` : "No capo"}</b>
                <span>
                  {o.shapeKey} shapes · {o.openCount}/{o.total} open
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="small muted">This tuning is not a uniform shift of standard, so shape suggestions are off.</p>
        )}
        <Field label="Tuning">
          <select
            value={customMode || song.tuning.startsWith("custom:") ? "custom" : song.tuning}
            onChange={(e) => {
              if (e.target.value === "custom") return setCustomMode(true);
              setCustomMode(false);
              update((s) => ({ ...s, tuning: e.target.value }));
            }}
          >
            {TUNINGS.map((t) => (
              <option key={t.name}>{t.name}</option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </Field>
        {(customMode || song.tuning.startsWith("custom:")) && (
          <Field label="Custom tuning" hint={customTuning && !parseTuning(customTuning) ? "Type 6 notes, low to high" : "Low to high, e.g. D A D G B E. Press Enter."}>
            <input
              autoFocus={customMode && !song.tuning.startsWith("custom:")}
              value={customTuning || (song.tuning.startsWith("custom:") ? song.tuning.slice(7) : "")}
              onChange={(e) => setCustomTuning(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              onBlur={() => customTuning && parseTuning(customTuning) && update((s) => ({ ...s, tuning: "custom:" + customTuning }))}
            />
          </Field>
        )}
        <Toggle checked={song.simpleChords} onChange={(v) => update((s) => ({ ...s, simpleChords: v }))} label="Simple chords (triads)" />
        <Field label="Minor key numbers" group>
          <Segmented
            value={song.nashvilleMinor}
            onChange={(v) => update((s) => ({ ...s, nashvilleMinor: v }))}
            options={[
              { value: "relative-major", label: "6m", title: "Minor tonic is 6m (Nashville habit)" },
              { value: "minor-tonic", label: "1m", title: "Minor tonic is 1m" },
            ]}
          />
        </Field>
        <Button onClick={() => window.print()}>Print / save PDF</Button>
          </>
        )}
      </aside>

      {/* ---------- chart ---------- */}
      <div className="chart-col">
        <div className="chart-toolbar no-print">
          <div className="legend" aria-label="How to read the chart">
            <span className="lg-sounding">C</span> sounding
            <span className="lg-nash">4</span> Nashville
            <span className="lg-shape">G shape</span> what you play
            <span className="lg-est">dashed</span> estimate
          </div>
          <div className="toolbar-actions">
            <span className="muted small">
              {confirmedCount}/{chart.chords.length} confirmed
            </span>
            <Button size="sm" variant="quiet" onClick={undo} disabled={!history.canUndo} title="Ctrl+Z">
              Undo
            </Button>
            <Button size="sm" variant="quiet" onClick={redo} disabled={!history.canRedo} title="Ctrl+Y">
              Redo
            </Button>
            <Button size="sm" onClick={addAtPlayhead} title="Splits the chord under the playhead, or starts a new one">
              Add chord at playhead
            </Button>
            <Button size="sm" onClick={newSection}>
              New section at playhead
            </Button>
            <Button
              size="sm"
              disabled={!chart.chords.length || confirmedCount === chart.chords.length}
              onClick={async () => {
                const left = chart.chords.length - confirmedCount;
                const ok = await confirm({
                  title: `Confirm ${left} unchecked chords?`,
                  body: "They are machine estimates. Only confirm them after you played through the song and they sound right. You can undo this.",
                  confirm: "Confirm all",
                });
                if (ok) setChart((c) => ({ ...c, chords: c.chords.map((x) => ({ ...x, confirmed: true })) }));
              }}
            >
              Confirm all…
            </Button>
            <Button
              size="sm"
              variant={ready ? "secondary" : "primary"}
              pressed={ready}
              disabled={confirmedCount < chart.chords.length}
              title={confirmedCount < chart.chords.length ? "Check every chord first" : "Marks this song ready to rehearse"}
              onClick={() => update((s) => ({ ...s, preparedAt: ready ? undefined : new Date().toISOString() }))}
            >
              {ready ? "✓ Ready to rehearse" : "Mark ready to rehearse"}
            </Button>
            {confirmedCount < chart.chords.length && (
              <span className="why-disabled">Check every chord first ({chart.chords.length - confirmedCount} left)</span>
            )}
            {song.chart && (
              <Button
                size="sm"
                variant="quiet"
                onClick={async () => {
                  if (await confirm({ title: "Reset the chart?", body: "All your chord and section edits for this song go back to the detected estimate. You can undo this.", confirm: "Reset chart", danger: true }))
                    update((s) => ({ ...s, chart: undefined, preparedAt: undefined }));
                }}
              >
                Reset to detected
              </Button>
            )}
          </div>
        </div>

        <div className="print-only print-head">
          <h1>{song.title}</h1>
          <p>
            Key {keyName(ctx.playKey)}
            {song.capo ? ` · Capo ${song.capo}` : ""} · {ctx.tuning.name}
            {analysis?.rhythm.bpm ? ` · ~${Math.round(analysis.rhythm.bpm * song.tempoRatio)} BPM` : ""}
          </p>
        </div>

        {chart.sections.length > 0 && chart.sections.every((x) => x.suggested) && (
          <Banner tone="info" title="Sections are rough guesses">
            Name them (Verse, Chorus…) and split them where they really change, with “New section at playhead”. Loop section, section jumps and spoken cues use them.
          </Banner>
        )}
        {!chart.chords.length ? (
          <EmptyState
            title={analysis ? "No chords found" : "No chords yet"}
            action={!analysis ? <Button variant="primary" onClick={goStems}>Analyze the song</Button> : undefined}
          >
            {analysis
              ? "Seek to where a chord starts, then use Add chord at playhead."
              : "Analyze the song to get estimated chords, or play to a spot and add chords by hand."}
          </EmptyState>
        ) : (
          sections.map((sec, si) => {
            const items = chart.chords.map((c, i) => ({ c, i })).filter(({ c }) => c.start >= sec.start - 0.01 && c.start < sec.end);
            return (
              <section key={si} className="chart-section">
                <header>
                  <input
                    className="section-name"
                    aria-label="Section name"
                    readOnly={!chart.sections.length}
                    title={!chart.sections.length ? "Add a section first (New section at playhead)" : undefined}
                    value={sec.label}
                    onChange={(e) => setChart((c) => ({ ...c, sections: c.sections.map((x, j) => (j === si ? { ...x, label: e.target.value, suggested: false } : x)) }))}
                  />
                  {sec.suggested && <span className="pill">Suggested</span>}
                  <span className="muted small num">{fmtTime(sec.start)}</span>
                  <Button size="sm" variant="quiet" className="no-print" onClick={() => engine.play(sec.start)}>
                    Play from here
                  </Button>
                  {si > 0 && chart.sections.length > 0 && (
                    <Button
                      size="sm"
                      variant="quiet"
                      className="no-print"
                      onClick={() =>
                        setChart((c) => {
                          const secs = [...c.sections];
                          secs[si - 1] = { ...secs[si - 1], end: secs[si].end };
                          secs.splice(si, 1);
                          return { ...c, sections: secs };
                        })
                      }
                      title="Join this section into the previous one"
                    >
                      Join with previous
                    </Button>
                  )}
                </header>
                <div className="chord-grid">
                  {items.map(({ c, i }) => (
                    <ChordCard
                      key={i}
                      view={describe(c.chord, ctx)}
                      confidence={c.confidence}
                      confirmed={c.confirmed}
                      active={i === playingIdx}
                      selected={i === sel}
                      index={i}
                      onClick={() => select(i)}
                    />
                  ))}
                </div>
              </section>
            );
          })
        )}
        <p className="print-only small">Dashed chords were detected automatically and not confirmed.</p>
      </div>

      {/* ---------- inspector ---------- */}
      {selChord && selView && sel !== null && (
        <aside className="inspector card no-print" aria-label="Chord details">
          <header className="card-head">
            <h3>Chord at {fmtTime(selChord.start)}</h3>
            <Button size="sm" variant="quiet" onClick={closeInspector} aria-label="Close chord details">
              Close
            </Button>
          </header>
          <ChordCard view={selView} confirmed={selChord.confirmed} size="xl" showDiagram={false} />
          <p className="row-tight small">
            <Confidence value={selChord.confidence} confirmed={selChord.confirmed} />
            <span className="muted">{fmtTime(selChord.start)}–{fmtTime(selChord.end)}</span>
          </p>
          <Field label="Change to" hint="Chord (D/F#, Em7) or number (4, 6m, 5/7)">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit(sel);
                if (e.key === "Escape") closeInspector();
                // Undo / redo also work here when nothing new has been typed.
                const untouched = draft === selView.concert;
                if (e.ctrlKey && e.code === "KeyZ" && untouched) {
                  e.preventDefault();
                  undo();
                }
                if (e.ctrlKey && e.code === "KeyY" && untouched) {
                  e.preventDefault();
                  redo();
                }
              }}
            />
          </Field>
          {draft.trim() && draft !== selView.concert && (() => {
            const parsed = parseUserChord(draft, ctx);
            return parsed ? <p className="small muted">Will become <b>{describe(parsed, ctx).concert}</b> ({describe(parsed, ctx).nashville})</p> : null;
          })()}
          {editErr && <Banner tone="error">{editErr}</Banner>}
          <div className="row-tight">
            <Button variant="primary" onClick={() => commit(sel)} title="Enter">
              Confirm &amp; next
            </Button>
            <Button onClick={() => engine.play(Math.max(0, selChord.start - 1))} title="Plays from one second before this chord">
              Listen
            </Button>
            <Button variant="quiet" onClick={() => merge(sel)} disabled={sel === 0} title="Remove this change; the previous chord continues">
              Merge into previous
            </Button>
          </div>
          <h4>Ways to play {selView.shape ?? selView.concert}</h4>
          {selView.shape ? <ShapeCompare shapeName={selView.shape} tuning={ctx.tuning} /> : <p className="small muted">No standard shapes for this tuning.</p>}
        </aside>
      )}
    </div>
  );
}
