import { useState } from "react";
import { alignChart, parseChart } from "../chordpro";
import { isKnownChord } from "../theory/chordInfo";
import { Banner, Button, Modal } from "../components/ui";
import type { useProject } from "../useProject";

type P = ReturnType<typeof useProject>;

/**
 * Import a chord chart: a SongSelect / ChordPro file, or text pasted from a chord site (chords over lyrics).
 * The chart is lined up with the song's detected chords: chord names (sus, add9, slash…), section names and lyric
 * lines land at the right time. Nothing is confirmed: the user checks it in Prepare, and one Undo brings back the old chart.
 */
export function ImportChart({ p, onClose }: { p: P; onClose: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  const readFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 1_000_000) return setError("That file is too big for a chord chart.");
    setText(await f.text());
    setError("");
  };

  const doImport = () => {
    setError("");
    const chart = parseChart(text);
    const chordCount = chart.sections.reduce((n, s) => n + s.lines.reduce((m, l) => m + l.chords.length, 0), 0);
    if (!chordCount) return setError("No chords found. Paste the chart with its chords (chords over the lyrics, or ChordPro).");
    const detected = p.chart.chords;
    if (!detected.length) return setError("Analyze the song first: the chart is lined up with the detected chords.");
    // chord names in the chart that are not real chords (typos, chord-site markup): say so instead of guessing
    const unknown = [...new Set(chart.sections.flatMap((s) => s.lines.flatMap((l) => l.chords)).filter((c) => c !== "N.C." && !isKnownChord(c)))];
    const r = alignChart(chart, detected);
    if (r.matched < Math.max(3, r.total * 0.25))
      return setError(`Only ${r.matched} of ${r.total} chart chords matched this recording. Is it the same song and arrangement?`);
    p.update(
      (s) => ({
        ...s,
        chart: { chords: r.chords, sections: r.sections.length >= 2 ? r.sections : p.chart.sections },
        lyrics: r.lyrics,
        ccli: chart.ccli ?? s.ccli,
        copyright: chart.copyright ?? s.copyright,
        preparedAt: undefined, // imported chords still need a check
      }),
      "import-chart",
    );
    setResult(
      `${r.matched} of ${r.total} chart chords lined up${r.shift ? ` (chart moved ${r.shift > 6 ? r.shift - 12 : r.shift} semitones: a capo or another key)` : ""}, ` +
        `${r.lyrics.length} lyric lines${r.estimated ? ` (${r.estimated} placed by estimate: check their timing)` : ""}, ${r.sections.length} sections. ` +
        (unknown.length ? `${unknown.length} chord name${unknown.length > 1 ? "s" : ""} not recognised (${unknown.slice(0, 4).join(", ")}): fix them in Prepare. ` : "") +
        "Check them in Prepare › Chart. Undo import (or Ctrl+Z) brings the old chart back.",
    );
  };

  return (
    <Modal open onClose={onClose} labelledBy="imp-title" className="import-dialog">
        <h2 id="imp-title">Import a chord chart</h2>
        <p className="small muted">
          Open a SongSelect / ChordPro file, or paste a chart copied from a chord site (chords over the lyrics). It is lined up with this
          recording; a chart for a capo or another key is moved automatically. For your own use: lyrics are copyrighted (CCLI covers church use).
        </p>
        <input type="file" accept=".cho,.chordpro,.chopro,.pro,.crd,.txt" aria-label="Chord chart file" onChange={(e) => readFile(e.target.files?.[0])} />
        <textarea
          className="import-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"[Verse 1]\nG        D/F#     Em7\nHow great is our God…"}
          aria-label="Chart text"
          autoFocus
        />
        {error && <Banner tone="error">{error}</Banner>}
        {result && <Banner tone="ok">{result}</Banner>}
        <div className="dialog-actions">
          {result && (
            <Button
              onClick={() => {
                p.undo();
                onClose();
              }}
            >
              Undo import
            </Button>
          )}
          <Button onClick={onClose}>{result ? "Close" : "Cancel"}</Button>
          {!result && (
            <Button variant="primary" onClick={doImport} disabled={!text.trim()}>
              Import and line up
            </Button>
          )}
        </div>
    </Modal>
  );
}
