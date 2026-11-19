import { RoleDot, roleOf, ROLE_LABEL } from "../components/music";
import { Banner, Card, Details } from "../components/ui";
import type { JobState } from "../useAnalysisJobs";
import type { useProject } from "../useProject";
import { AnalyzePanel } from "./AnalyzePanel";

type P = ReturnType<typeof useProject>;

export function PrepareStems({ p, job, onStart, onCancel }: { p: P; job?: JobState; onStart: (q: string, d: string) => void; onCancel: () => void }) {
  const { analysis, project, stems } = p;
  if (!project) return null;
  const sep = analysis?.separation;

  return (
    <div className="two-col">
      <div className="stack">
        <Card title="Stems in this song">
          {!analysis?.stems?.length ? (
            <p className="muted">No stems yet. The app plays the full mix until you analyze the song.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Part</th>
                  <th>Role</th>
                  <th>Level vs mix</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {stems.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <RoleDot role={roleOf(s)} /> {s.name}
                    </td>
                    <td className="muted">{ROLE_LABEL[roleOf(s)]}</td>
                    <td className="num nowrap">{s.level_db !== undefined ? `${s.level_db} dB` : "—"}</td>
                    <td className="small">
                      {s.experimental && <span className="pill pill-warn">Estimate</span>} {s.quiet && <span className="pill">Quiet · muted at first</span>} {s.hint ?? (s.id === "residual" ? "Sound no stem captured. Keeps the full mix complete." : "")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {analysis?.quietStems?.length ? (
            <p className="muted small">
              Quiet parts, kept but muted at first (turn them on in Session if you hear a real part): {analysis.quietStems.join(", ")}.
            </p>
          ) : null}
          {analysis?.silentStems?.length ? (
            <p className="muted small">Silent in this song, not kept (their sound stays in "Leftover"): {analysis.silentStems.join(", ")}.</p>
          ) : null}
        </Card>

        {analysis?.guitarSplit && (
          <Banner tone="warn" title="Guitar parts are an estimate">
            The model gives one combined guitar stem. The app splits it by stereo position (left / centre / right). That works only
            when players were panned apart, and each part still contains some of the others. The three parts always add up to the
            full guitar stem, so muting all three is safe. Separate multitrack files would give clean parts.
          </Banner>
        )}

        {analysis && (
          <Details summary="Analysis details">
            <ul className="plain small">
              <li>Separation: {sep ? `${sep.model} (${sep.license})` : "skipped"}</li>
              <li>Leftover: {sep ? `${sep.residual_db} dB vs the mix` : "—"}</li>
              <li>Beats: {analysis.rhythm.method}, about {analysis.rhythm.bpm ?? "?"} BPM</li>
              <li>Chords from: {analysis.chordSource ?? "—"}</li>
              <li>Processor: {analysis.device === "cuda" ? "graphics card (GPU)" : "CPU"}</li>
              <li>Took: {analysis.elapsed_s ? `${analysis.elapsed_s} s` : "—"}</li>
            </ul>
            {analysis.warnings.map((w, i) => (
              <Banner key={i} tone="warn">
                {w}
              </Banner>
            ))}
          </Details>
        )}
      </div>
      <AnalyzePanel analyzed={!!analysis} job={job} onStart={onStart} onCancel={onCancel} />
    </div>
  );
}
