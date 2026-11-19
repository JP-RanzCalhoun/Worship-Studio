import { useEffect, useMemo, useRef, useState } from "react";
import { on } from "../bridge";
import { resolveTuning } from "../chart";
import { Banner, Button, Card, Field, Toggle } from "../components/ui";
import { type Devices, engine } from "../engine";
import { TUNINGS } from "../theory/guitar";
import { SHARP_NAMES } from "../theory/notes";

const midiName = (m: number) => SHARP_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

export function Tuner({ tuningName }: { tuningName?: string }) {
  const [devices, setDevices] = useState<Devices | null>(null);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [muteSong, setMuteSong] = useState(true);
  const [a4, setA4] = useState(440);
  const [tuning, setTuning] = useState(tuningName && !tuningName.startsWith("custom:") ? tuningName : TUNINGS[0].name);
  const [reading, setReading] = useState({ hz: 0, clarity: 0, level: 0 });
  const [err, setErr] = useState("");

  useEffect(() => {
    engine
      .devices()
      .then((d) => {
        setDevices(d);
        const e2 = d.inputs.find((i) => /maonocaster|e2 gen/i.test(i.name) && !i.virtual);
        setInput(d.input || e2?.name || d.inputs.find((i) => !i.virtual)?.name || "");
      })
      .catch((e) => setErr(String(e.message ?? e)));
  }, []);
  useEffect(() => on("tuner", (r) => setReading(r)), []);
  const runningRef = useRef({ running: false, muted: false, output: "" });
  useEffect(
    () => () => {
      // Only undo what this screen changed.
      if (runningRef.current.running) {
        engine.tuner(false).catch(() => {});
        engine.setDevices(runningRef.current.output, "").catch(() => {}); // close the mic again
      }
      if (runningRef.current.muted) engine.setMasterMute(false).catch(() => {});
    },
    [],
  );

  // Every step that succeeded is undone if a later one fails, so a failed start never leaves the song muted
  // or the microphone open. Stop always runs every step, even if one of them fails.
  const start = async () => {
    setErr("");
    const output = devices?.output ?? "";
    let opened = false,
      tuning = false,
      muted = false;
    try {
      await engine.setDevices(output, input);
      opened = true;
      await engine.tuner(true);
      tuning = true;
      if (muteSong) {
        await engine.setMasterMute(true);
        muted = true;
      }
      runningRef.current = { running: true, muted, output };
      setRunning(true);
    } catch (e: any) {
      setErr(String(e.message ?? e));
      if (muted) await engine.setMasterMute(false).catch(() => {});
      if (tuning) await engine.tuner(false).catch(() => {});
      if (opened) await engine.setDevices(output, "").catch(() => {});
    }
  };
  const stop = async () => {
    const r = runningRef.current;
    runningRef.current = { running: false, muted: false, output: "" };
    setRunning(false);
    await engine.tuner(false).catch(() => {});
    if (r.muted) await engine.setMasterMute(false).catch(() => {});
    await engine.setDevices(r.output, "").catch(() => {}); // close the mic again
  };

  const strings = useMemo(() => resolveTuning(tuning).strings, [tuning]);
  const midi = reading.hz > 0 ? 69 + 12 * Math.log2(reading.hz / a4) : NaN;
  const nearest = Math.round(midi);
  const cents = isNaN(midi) ? 0 : Math.round((midi - nearest) * 100);
  const target = isNaN(midi) ? null : strings.reduce((b, s) => (Math.abs(s - midi) < Math.abs(b - midi) ? s : b), strings[0]);
  const inTune = Math.abs(cents) <= 3;
  const hearing = reading.clarity > 0.8 && reading.level > 0.003;
  const selected = devices?.inputs.find((i) => i.name === input);
  const state = !running ? "off" : !hearing ? "listening" : inTune ? "in" : cents < 0 ? "flat" : "sharp";
  const stateText = { off: "Tuner is off", listening: reading.level < 0.003 ? "No signal — play one string" : "Listening… let the string ring", in: "In tune", flat: "Flat — tune up", sharp: "Sharp — tune down" }[state];

  return (
    <div className="tuner-page">
      <Card className="tuner-controls">
        <div className="form-grid">
          <Field
            label="Input"
            hint={devices && !devices.inputs.some((i) => /maonocaster|e2 gen/i.test(i.name)) ? "The E2 Gen 2 is not connected. Plug it in, or use a microphone for now." : "Use the E2 Gen 2 for the guitar. A mic works as a fallback."}
          >
            <select value={input} onChange={(e) => setInput(e.target.value)} disabled={running}>
              <option value="">Choose an input…</option>
              {devices?.inputs.map((i) => (
                <option key={i.name} value={i.name}>
                  {i.name}
                  {i.virtual ? " — software device" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tuning">
            <select value={tuning} onChange={(e) => setTuning(e.target.value)}>
              {TUNINGS.map((t) => (
                <option key={t.name}>{t.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Reference A4 (Hz)">
            <input type="number" min={415} max={466} step={0.5} value={a4} onChange={(e) => setA4(+e.target.value)} />
          </Field>
          <Toggle checked={muteSong} onChange={setMuteSong} label="Mute the song while tuning" />
        </div>
        {running ? (
          <Button size="lg" onClick={stop}>
            Stop tuner
          </Button>
        ) : (
          <Button size="lg" variant="primary" onClick={start} disabled={!input}>
            Start tuner
          </Button>
        )}
        {selected?.virtual && <Banner tone="warn">This input is a software device, not your guitar interface. Choose “Headset Microphone (Maonocaster E2 Gen2)”.</Banner>}
        {err && <Banner tone="error" title="Could not open the input">{err} Check the cable and that no other app holds the device in exclusive mode.</Banner>}
      </Card>

      <div className={`tuner-display is-${state}`} aria-live="polite">
        <div className="tuner-note">{hearing ? midiName(nearest) : "—"}</div>
        <div className="tuner-scale" aria-hidden>
          {[-50, -25, 0, 25, 50].map((c) => (
            <span key={c} style={{ left: `${50 + c}%` }}>
              {c > 0 ? `+${c}` : c}
            </span>
          ))}
          <div className="tuner-zone" />
          {hearing && <div className="tuner-needle" style={{ left: `${50 + Math.max(-50, Math.min(50, cents))}%` }} />}
        </div>
        <div className="tuner-state">
          <strong>{stateText}</strong>
          {hearing && (
            <span className="num muted">
              {" "}
              · {cents > 0 ? "+" : ""}
              {cents} cents · {reading.hz.toFixed(1)} Hz
            </span>
          )}
        </div>
        <div className="tuner-strings" aria-label="Strings in this tuning">
          {strings.map((s, i) => (
            <span key={i} className={hearing && target === s ? "is-target" : ""}>
              {midiName(s)}
            </span>
          ))}
        </div>
      </div>
      <p className="muted small center">Pitch reading is not yet verified with a real guitar on this PC. Please check it against another tuner once.</p>
    </div>
  );
}
