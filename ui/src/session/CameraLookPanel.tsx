import { useEffect, useState } from "react";
import { Banner, Button } from "../components/ui";
import { BUILT_IN_LOOKS, listCubes, parseCube, removeCube, saveCube, type LookId } from "./cameraLook";
import type { useCamera } from "./useCamera";

type Camera = ReturnType<typeof useCamera>;

const WB_PRESETS: { label: string; k: number }[] = [
  { label: "Warm bulb", k: 3000 },
  { label: "Neutral", k: 4000 },
  { label: "Daylight", k: 5600 },
];

/**
 * Camera look: settings inside the camera (white balance, exposure, tone) and an OBS-style colour look (LUT),
 * with live preview. Floating, so the camera picture stays visible while adjusting. The look is baked into the
 * recording; the camera settings are saved in the camera for every session.
 */
export function CameraLookPanel({ camera, recording, onClose }: { camera: Camera; recording: boolean; onClose: () => void }) {
  const { tune, setTune, tuneCaps, look, setLook } = camera;
  const [cubes, setCubes] = useState<string[]>([]);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    listCubes().then(setCubes).catch(() => {});
  }, []);

  const importCube = async (f: File | undefined) => {
    if (!f) return;
    setMsg("");
    try {
      if (f.size > 30_000_000) throw new Error("That file is too big for a LUT.");
      const text = await f.text();
      parseCube(text); // check before saving
      const name = f.name.replace(/\.cube$/i, "");
      await saveCube(name, text);
      setCubes(await listCubes());
      setLook({ id: `cube:${name}` });
    } catch (e: any) {
      setMsg(String(e.message ?? e));
    }
  };

  const slider = (key: "exposureCompensation" | "brightness" | "contrast" | "saturation", label: string) => {
    const cap = tuneCaps[key];
    if (!cap) return null;
    const auto = tune[key] === null;
    const value = (tune[key] as number | null) ?? (typeof camera.tuneNow[key] === "number" ? camera.tuneNow[key] : undefined);
    return (
      <label className="look-row" key={key}>
        <span>{label}</span>
        <input type="range" min={cap.min} max={cap.max} step={cap.step || 1} value={value ?? (cap.min + cap.max) / 2}
          className={auto ? "is-auto" : ""} aria-label={label} onChange={(e) => setTune({ [key]: +e.target.value })} />
        <Button size="sm" variant="quiet" pressed={auto} onClick={() => setTune({ [key]: null })} title="The camera's own value">
          Auto
        </Button>
      </label>
    );
  };

  const wb = tune.whiteBalance;
  const wbCap = tuneCaps.colorTemperature;
  // switching the look on or off mid-take would cut the recording: only between looks while recording
  const lockOnOff = recording;

  return (
    <aside className="look-panel" aria-label="Camera look" role="dialog">
      <header className="panel-head">
        <span className="strong">Camera look</span>
        <span className="spacer" />
        <Button size="sm" variant="quiet" onClick={onClose} aria-label="Close">
          ✕
        </Button>
      </header>

      <h3 className="eyebrow">Look (colour filter, recorded)</h3>
      <div className="look-grid" role="radiogroup" aria-label="Look">
        {BUILT_IN_LOOKS.map((l) => (
          <Button key={l.id} size="sm" pressed={look.id === l.id} title={l.hint}
            disabled={lockOnOff && (l.id === "none") !== (look.id === "none")} onClick={() => setLook({ id: l.id })}>
            {l.name}
          </Button>
        ))}
        {cubes.map((c) => (
          <span key={c} className="look-cube">
            <Button size="sm" pressed={look.id === `cube:${c}`} title="Imported LUT" disabled={lockOnOff && look.id === "none"}
              onClick={() => setLook({ id: `cube:${c}` as LookId })}>
              {c}
            </Button>
            <Button size="sm" variant="quiet" aria-label={`Remove ${c}`} title="Remove this LUT"
              onClick={async () => {
                await removeCube(c);
                setCubes(await listCubes());
                if (look.id === `cube:${c}`) setLook({ id: "none" });
              }}>
              ✕
            </Button>
          </span>
        ))}
      </div>
      {look.id !== "none" && (
        <label className="look-row">
          <span>Strength</span>
          <input type="range" min={0} max={1} step={0.05} value={look.strength} aria-label="Look strength"
            onChange={(e) => setLook({ strength: +e.target.value })} />
          <span className="muted small">{Math.round(look.strength * 100)}%</span>
        </label>
      )}
      <div className="look-row">
        <span>Colour fix</span>
        <span className="row-tight">
          <Button size="sm" onClick={() => camera.autoColourFix()} disabled={lockOnOff && look.id === "none" && look.gains.every((g) => g === 1)}
            title="Measures your picture and removes the colour cast of the room light (yellow, pink...). Click again after the light changes.">
            Auto colour fix
          </Button>
          {look.gains.some((g) => g !== 1) && (
            <Button size="sm" variant="quiet" onClick={() => setLook({ gains: [1, 1, 1] })} disabled={lockOnOff && look.id === "none"}>
              Undo
            </Button>
          )}
        </span>
        <span className="muted small">{look.gains.some((g) => g !== 1) ? `R ${look.gains[0]} G ${look.gains[1]} B ${look.gains[2]}` : ""}</span>
      </div>
      <label className="btn btn-quiet btn-sm look-import">
        Import a .cube LUT…
        <input type="file" accept=".cube" hidden onChange={(e) => importCube(e.target.files?.[0])} />
      </label>
      {lockOnOff && <p className="small muted">While recording you can change between looks, not turn the look on or off.</p>}

      <h3 className="eyebrow">Camera settings (in the camera)</h3>
      {wbCap && (
        <>
          <div className="look-row">
            <span>White balance</span>
            <span className="row-tight">
              <Button size="sm" pressed={wb === "auto"} onClick={() => setTune({ whiteBalance: "auto" })}>
                Auto
              </Button>
              {WB_PRESETS.map((p) => (
                <Button key={p.k} size="sm" pressed={wb === p.k} onClick={() => setTune({ whiteBalance: p.k })} title={`${p.k} K`}>
                  {p.label}
                </Button>
              ))}
            </span>
          </div>
          {wb !== "auto" && (
            <label className="look-row">
              <span>{wb} K</span>
              <input type="range" min={wbCap.min} max={wbCap.max} step={50} value={wb} aria-label="White balance in kelvin"
                onChange={(e) => setTune({ whiteBalance: +e.target.value })} />
              <span className="muted small">{wb < 3800 ? "for warm light" : wb > 5200 ? "for daylight" : ""}</span>
            </label>
          )}
        </>
      )}
      {slider("exposureCompensation", "Exposure")}
      {slider("brightness", "Brightness")}
      {slider("contrast", "Contrast")}
      {slider("saturation", "Saturation")}
      <div className="look-actions">
        <Button size="sm" variant="quiet"
          onClick={() => {
            setTune({ whiteBalance: "auto", exposureCompensation: null, brightness: null, contrast: null, saturation: null });
            setLook({ id: "none", strength: 1, gains: [1, 1, 1] });
          }}>
          Reset all
        </Button>
      </div>
      {(msg || camera.lookError) && <Banner tone="error">{msg || camera.lookError}</Banner>}
      <p className="small muted">
        Tip: keep White balance on Auto and press “Auto colour fix” for the room light (it also removes pink casts, which white
        balance cannot). For night: raise Exposure first (cleaner than brightening later), then “Night” or “Warm film”.
      </p>
    </aside>
  );
}
