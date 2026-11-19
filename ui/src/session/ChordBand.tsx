import type { ReactNode } from "react";
import { chordAt, describe, sectionAt, type ChartContext } from "../chart";
import { ChordDiagram } from "../components/ChordDiagram";
import type { ChordSeg, Section } from "../song";
import type { GridBeat } from "../timeline";

/**
 * The live chord display: the chord now (big), its Nashville number and the shape to play, the beat in the bar,
 * the next three chords, and the section with what comes next. During a count-in it shows the count.
 */
export function ChordBand({
  chords,
  sections,
  grid,
  ctx,
  pos,
  countIn,
  big = false,
  lyrics,
  empty,
}: {
  /** shown in place of the chords when there are none to show (no chart yet) */
  empty?: ReactNode;
  /** lyric lines with their start time (imported chart) */
  lyrics?: { t: number; text: string }[];
  chords: ChordSeg[];
  sections: Section[];
  grid: GridBeat[];
  ctx: ChartContext;
  pos: number;
  /** count-in running: the beat number to show (1-based), or 0 */
  countIn?: number;
  /** projector / stage size */
  big?: boolean;
}) {
  const idx = chordAt(chords, pos);
  const cur = idx >= 0 ? chords[idx] : null;
  const view = cur ? describe(cur.chord, ctx) : null;
  const upcoming: ChordSeg[] = [];
  for (let i = idx + 1; i < chords.length && upcoming.length < 3; i++) if (chords[i].chord !== "N.C.") upcoming.push(chords[i]);
  const secIdx = sectionAt(sections, pos);
  const section = secIdx >= 0 ? sections[secIdx] : null;
  const nextSection = sections[secIdx + 1];
  const toNextSection = nextSection ? nextSection.start - pos : Infinity;

  // Beat in the bar from the beat grid (0 = downbeat).
  let beat = -1,
    beatsInBar = 4;
  if (grid.length) {
    let lo = 0,
      hi = grid.length - 1,
      at = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (grid[m].t <= pos + 0.02) {
        at = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    if (at >= 0) {
      beat = grid[at].pos;
      let maxPos = 0;
      for (let i = Math.max(0, at - 8); i < Math.min(grid.length, at + 8); i++) maxPos = Math.max(maxPos, grid[i].pos);
      beatsInBar = maxPos + 1;
    }
  }

  let li = -1;
  if (lyrics?.length) for (let i = 0; i < lyrics.length && lyrics[i].t <= pos + 0.3; i++) li = i;
  const lyricNow = li >= 0 ? lyrics![li].text : "";
  const lyricNext = lyrics?.[li + 1]?.text ?? "";

  const noChords = !chords.length && !countIn && !!empty;

  return (
    <section className={`chord-band${big ? " is-big" : ""}${lyrics?.length ? " has-lyrics" : ""}${noChords ? " no-chords" : ""}`} aria-label="Live chords" aria-live="off">
      {noChords ? (
        <div className="cb-empty">{empty}</div>
      ) : (
        <>
      <div className="cb-now">
        {countIn ? (
          <span className="cb-count" aria-live="assertive">
            {countIn}
          </span>
        ) : view ? (
          <>
            <span className={`cb-chord${cur && !cur.confirmed ? " is-estimate" : ""}`} title={cur && !cur.confirmed ? "Estimate: not checked yet" : undefined}>
              {view.concert}
            </span>
            <span className="cb-nash">{view.nashville}</span>
            {view.diagram && (
              <span className="cb-shape">
                <ChordDiagram shape={view.diagram} size={big ? 96 : 54} />
                <span>{view.shapeDiffers ? `play ${view.shape}` : view.shape ?? ""}</span>
              </span>
            )}
          </>
        ) : (
          <span className="cb-chord muted">—</span>
        )}
        <span className="cb-beats" aria-label={beat >= 0 ? `beat ${beat + 1} of ${beatsInBar}` : undefined}>
          {Array.from({ length: Math.min(beatsInBar, 12) }, (_, i) => (
            <i key={i} className={i <= beat ? (i === 0 ? "on down" : "on") : ""} />
          ))}
        </span>
      </div>
      <div className="cb-next">
        <span className="eyebrow">Next</span>
        <span className="cb-next-list">
          {upcoming.length ? (
            upcoming.map((c, i) => {
              const v = describe(c.chord, ctx);
              return (
                <span key={i} className={`cb-up${i === 0 ? " is-first" : ""}`}>
                  {i > 0 && <span className="cb-arrow">→</span>}
                  <b>{v.concert}</b> <span className="cb-up-nash">{v.nashville}</span>
                </span>
              );
            })
          ) : (
            <span className="muted">—</span>
          )}
        </span>
      </div>
        </>
      )}
      {!!lyrics?.length && (
        <div className="cb-lyrics">
          <span className="cb-lyric-now">{lyricNow || " "}</span>
          <span className="cb-lyric-next">{lyricNext}</span>
        </div>
      )}
      <div className="cb-section">
        <span className="eyebrow">Section</span>
        <span className="cb-sec-name">{countIn ? "Count-in" : section?.label ?? "—"}</span>
        {nextSection && (
          <span className={`cb-sec-next${toNextSection < 8 ? " is-soon" : ""}`}>
            {nextSection.label} in {Math.max(0, Math.ceil(toNextSection))} s
          </span>
        )}
      </div>
    </section>
  );
}
