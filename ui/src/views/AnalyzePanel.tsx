import { useEffect, useState } from "react";
import { Banner, Button, Card, Field, Progress, Segmented } from "../components/ui";
import { engine, type SidecarInfo } from "../engine";
import type { JobState } from "../useAnalysisJobs";

/** Starts the analysis sidecar for one song. The job itself is tracked at app level (useAnalysisJobs). */
export function AnalyzePanel({
  analyzed,
  job,
  onStart,
  onCancel,
}: {
  analyzed: boolean;
  job?: JobState;
  onStart: (quality: string, device: string) => void;
  onCancel: () => void;
}) {
  const [info, setInfo] = useState<SidecarInfo | null>(null);
  const [infoErr, setInfoErr] = useState("");
  const [quality, setQuality] = useState("fast");
  const [device, setDevice] = useState("auto");
  const [okUnverified, setOkUnverified] = useState(false); // explicit opt-in for weights with no known licence

  useEffect(() => {
    engine.sidecarInfo().then(setInfo).catch((e) => setInfoErr(String(e.message ?? e)));
  }, []);

  const gpu = info?.cuda && device !== "cpu";
  const preset = info?.presets?.[quality] as (SidecarInfo["presets"][string] & { license?: string }) | undefined;
  const running = !!job?.running;

  return (
    <Card title={analyzed ? "Analyze again" : "Analyze this song"}>
      <p className="muted">
        Splits the song into stems, then estimates beats, key, chords and sections. It runs on this PC; nothing is uploaded.
        {analyzed ? " Chords you confirmed and sections you named are kept." : ""}
      </p>
      {infoErr ? (
        <Banner tone="error" title="Analysis tools not found">
          {infoErr} See docs/SETUP.md, step “Python analysis tools”.
        </Banner>
      ) : (
        <>
          <div className="form-grid">
            <Field label="Quality" hint={preset?.note} group>
              <Segmented
                label="Quality"
                value={quality}
                onChange={(q) => {
                  setQuality(q);
                  setOkUnverified(false); // the opt-in is per choice
                }}
                options={Object.entries(info?.presets ?? { fast: { label: "Standard" } as any }).map(([k, v]) => ({ value: k, label: (v as any).label.split(" (")[0] }))}
              />
            </Field>
            <Field label="Processor" hint={info ? (gpu ? `${info.gpu} (${info.vram_gb} GB)` : "CPU: works on any PC, several times slower") : "Checking…"} group>
              <Segmented
                label="Processor"
                value={device}
                onChange={setDevice}
                options={[
                  { value: "auto", label: "GPU if available" },
                  { value: "cpu", label: "CPU only" },
                ]}
              />
            </Field>
          </div>
          {preset?.license?.startsWith("UNVERIFIED") ? (
            <Banner tone="warn" title="This model has no known licence">
              <label className="checkbox-line">
                <input type="checkbox" checked={okUnverified} onChange={(e) => setOkUnverified(e.target.checked)} /> Use it anyway, for my own
                study only. I will not share these stems.
              </label>
            </Banner>
          ) : (
            preset?.license && <p className="muted small">Model licence: {preset.license}.</p>
          )}
          {running ? (
            <Progress pct={job!.pct} label={job!.message} onCancel={onCancel} />
          ) : (
            <Button variant="primary" size="lg" onClick={() => onStart(quality, device)}
              disabled={!info || (!!preset?.license?.startsWith("UNVERIFIED") && !okUnverified)}>
              {analyzed ? "Analyze again" : "Analyze"}
            </Button>
          )}
          <p className="muted small">You can keep playing, or leave this page. The result appears when it is done.</p>
        </>
      )}
      {job?.cancelled && !running && <Banner tone="info">Cancelled. Nothing was changed.</Banner>}
      {job?.error && <Banner tone="error" title="Analysis failed">{job.error}</Banner>}
    </Card>
  );
}
