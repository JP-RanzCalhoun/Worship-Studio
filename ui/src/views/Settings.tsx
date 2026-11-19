import { useEffect, useState } from "react";
import { Banner, Button, Card, Details, Field, Segmented } from "../components/ui";
import { type Devices, engine, type SidecarInfo } from "../engine";
import { ACTION_LABEL, comboOf, DEFAULT_KEYS, prettyCombo, saveKeys, type Action } from "../shortcuts";

export function Settings({
  theme,
  setTheme,
  keys,
  setKeys,
}: {
  theme: string;
  setTheme: (t: "dark" | "light") => void;
  keys: Record<Action, string>;
  setKeys: (k: Record<Action, string>) => void;
}) {
  const [devices, setDevices] = useState<Devices | null>(null);
  const [info, setInfo] = useState<SidecarInfo | null>(null);
  const [infoErr, setInfoErr] = useState("");
  const [root, setRoot] = useState("");
  const [devErr, setDevErr] = useState("");
  const [listening, setListening] = useState<Action | null>(null);
  const [notice, setNotice] = useState("");

  const refresh = () => engine.devices().then(setDevices).catch((e) => setDevErr(String(e.message ?? e)));
  useEffect(() => {
    refresh();
    engine.sidecarInfo().then(setInfo).catch((e) => setInfoErr(String(e.message ?? e)));
    engine.libraryRoot().then(setRoot).catch(() => {});
  }, []);

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setListening(null);
      if (["Control", "Shift", "Alt"].includes(e.key)) return;
      const combo = comboOf(e);
      const taken = (Object.keys(keys) as Action[]).find((a) => a !== listening && keys[a] === combo);
      // Never leave two actions on one key: the other action takes over this action's old key.
      const next = { ...keys, [listening]: combo, ...(taken ? { [taken]: keys[listening] } : {}) };
      setKeys(next);
      saveKeys(next);
      setNotice(taken ? `${prettyCombo(combo)} was used by “${ACTION_LABEL[taken]}”. That action now uses ${prettyCombo(keys[listening])}.` : "");
      setListening(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, keys, setKeys]);

  const setOutput = async (output: string) => {
    try {
      await engine.setDevices(output, devices?.input ?? "");
      setDevErr("");
    } catch (e: any) {
      setDevErr(String(e.message ?? e));
    }
    refresh();
  };
  const dupes = Object.values(keys).filter((v, i, a) => a.indexOf(v) !== i);

  return (
    <div className="settings">
      <h1>Settings</h1>
      <div className="two-col">
        <div className="stack">
          <Card title="Sound output">
            <Field label="Play through" hint="Headphones on the E2 Gen 2 avoid the speaker sound reaching the guitar mic later.">
              <select value={devices?.output ?? ""} onChange={(e) => setOutput(e.target.value)}>
                {devices?.outputs.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </Field>
            {devErr && <Banner tone="error">{devErr}</Banner>}
            {devices && (
              <Details summary="Technical details">
                <ul className="plain small">
                  <li>Driver: {devices.type} (WASAPI shared mode)</li>
                  <li>Sample rate: {devices.sampleRate} Hz</li>
                  <li>Buffer: {devices.bufferSize} samples ({devices.bufferSize && devices.sampleRate ? ((1000 * devices.bufferSize) / devices.sampleRate).toFixed(1) : "?"} ms)</li>
                  <li>Reported output latency: {devices.outputLatencyMs?.toFixed(1)} ms — the delay before you hear playback</li>
                </ul>
              </Details>
            )}
            <Banner tone="info">To record the E2 Gen 2 and PD200X as separate tracks, open Session (with a song, or Record solo from the Library).</Banner>
          </Card>

          <Card title="Look">
            <Field label="Theme" group>
              <Segmented
                label="Theme"
                value={theme as "dark" | "light"}
                onChange={setTheme}
                options={[
                  { value: "dark", label: "Dark" },
                  { value: "light", label: "Light" },
                ]}
              />
            </Field>
          </Card>

          <Card title="Your data">
            <p>
              Songs are stored on this PC: <code>{root}</code>
            </p>
            <Button size="sm" onClick={() => engine.reveal(root)}>
              Open folder
            </Button>
            <p className="muted small">Nothing is uploaded. Model files download once from their publishers.</p>
          </Card>
        </div>

        <div className="stack">
          <Card
            title="Keyboard shortcuts"
            actions={
              <Button
                size="sm"
                variant="quiet"
                onClick={() => {
                  setKeys({ ...DEFAULT_KEYS });
                  saveKeys({ ...DEFAULT_KEYS });
                }}
              >
                Reset
              </Button>
            }
          >
            <p className="muted small">Shortcuts work everywhere except while typing in a text box. Click Change, then press the new key (Esc cancels).</p>
            <table className="table">
              <tbody>
                {(Object.keys(ACTION_LABEL) as Action[]).map((a) => (
                  <tr key={a}>
                    <td>{ACTION_LABEL[a]}</td>
                    <td>
                      <kbd className={dupes.includes(keys[a]) ? "is-dupe" : ""}>{listening === a ? "Press a key…" : prettyCombo(keys[a])}</kbd>
                    </td>
                    <td>
                      <Button size="sm" variant="quiet" onClick={() => setListening(a)}>
                        Change
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {notice && <Banner tone="info">{notice}</Banner>}
            {dupes.length > 0 && <Banner tone="warn">Two actions share a key. Only the first will run.</Banner>}
            <Banner tone="info">MIDI and Bluetooth foot pedals: planned for a later milestone.</Banner>
          </Card>

          <Card title="Analysis tools">
            {infoErr ? (
              <Banner tone="error" title="Not installed">
                {infoErr}
              </Banner>
            ) : info ? (
              <>
                <p>
                  {info.cuda ? `GPU: ${info.gpu} (${info.vram_gb} GB)` : "CPU only"} · Python {info.python} · PyTorch {info.torch ?? "missing"}
                </p>
                <ul className="plain small">
                  {Object.entries(info.presets).map(([k, p]) => (
                    <li key={k}>
                      <b>{p.label}</b> — {p.note} <span className="muted">License: {(p as any).license}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="muted">Checking…</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
