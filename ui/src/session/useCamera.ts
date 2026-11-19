import { useCallback, useEffect, useRef, useState } from "react";
import { engine } from "../engine";
import { builtInLut, loadCube, LookProcessor, neutralGains, parseCube, type LookId } from "./cameraLook";

export interface CameraDevice {
  id: string;
  label: string;
}

const STORE = "wsa.camera";

/** Which camera to use first: the one chosen before, else the EMEET, else any camera that is not a phone. */
function pick(list: CameraDevice[]): string {
  let saved = "";
  try {
    saved = localStorage.getItem(STORE) ?? "";
  } catch {
    /* storage blocked */
  }
  if (saved && list.some((d) => d.id === saved)) return saved;
  return (list.find((d) => /emeet/i.test(d.label)) ?? list.find((d) => !/iriun|virtual/i.test(d.label)) ?? list[0])?.id ?? "";
}

/** Reads a Blob as base64 without the "data:...;base64," prefix. */
function toBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

/**
 * Live camera preview, and recording the camera picture into the current take folder (video.webm, VP9).
 * The picture is recorded without sound: the take's sound is the dry E2/PD200X recording, lined up with the song.
 * Nothing is stored unless `startRecording` is called while a take is recording.
 */
export function useCamera(enabled: boolean, onRecordError?: (message: string) => void) {
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [deviceId, setDeviceId] = useState("");
  // raw = the camera itself (its settings are applied here); stream = what the app shows and records (with the look)
  const [raw, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const sending = useRef<Promise<unknown>>(Promise.resolve());
  const [recording, setRecording] = useState(false);
  const errRef = useRef(onRecordError);
  errRef.current = onRecordError;

  const listDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const cams = all.filter((d) => d.kind === "videoinput").map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
      setDevices(cams);
      setDeviceId((cur) => (cur && cams.some((c) => c.id === cur) ? cur : pick(cams)));
    } catch (e: any) {
      setError(String(e.message ?? e));
    }
  }, []);

  // Recording quality: 1080p 60 fps (default) or 4K 30 fps. The preview shows the same stream (letterboxed on
  // screen only); the recording is the camera's own picture, full frame, no bars.
  const [quality, setQualityState] = useState<CameraQuality>(() => {
    try {
      return localStorage.getItem(QUALITY_STORE) === "4k30" ? "4k30" : "1080p60";
    } catch {
      return "1080p60";
    }
  });
  const setQuality = (q: CameraQuality) => {
    setQualityState(q);
    try {
      localStorage.setItem(QUALITY_STORE, q);
    } catch {
      /* not remembered */
    }
  };
  const q = QUALITIES[quality];

  // Open the chosen camera at the chosen quality; close it when the page is left or the camera is turned off.
  const wanted = enabled || recording;
  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    let s: MediaStream | null = null;
    (async () => {
      try {
        setError("");
        s = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.fps } },
        });
        if (!alive) return s.getTracks().forEach((t) => t.stop());
        setStream(s);
        const st = s.getVideoTracks()[0]?.getSettings();
        setInfo(st ? `${st.width}×${st.height} · ${Math.round(st.frameRate ?? 0)} fps` : "");
        if (!deviceId) listDevices(); // labels are only readable after the first permission
      } catch (e: any) {
        setStream(null);
        setError(
          e?.name === "NotAllowedError"
            ? "The camera was not allowed. Allow it in the prompt, or in Windows Settings › Privacy › Camera."
            : e?.name === "NotReadableError"
              ? "The camera is in use by another app (for example OBS or Zoom). Close it there, then try again."
              : String(e.message ?? e),
        );
      }
    })();
    return () => {
      alive = false;
      s?.getTracks().forEach((t) => t.stop());
      setStream(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- q follows quality
  }, [wanted, deviceId, listDevices, quality]);

  useEffect(() => {
    listDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", listDevices);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", listDevices);
  }, [listDevices]);

  const choose = (id: string) => {
    setDeviceId(id);
    try {
      localStorage.setItem(STORE, id);
    } catch {
      /* storage blocked */
    }
  };

  // What the app shows and records (with the look when one is chosen); set at the end of the hook.
  const outRef = useRef<MediaStream | null>(null);

  /** Starts writing the camera picture into the take that is recording now. Returns an error text or "". */
  const startRecording = useCallback(async (): Promise<string> => {
    const stream = outRef.current;
    if (!stream) return "";
    // MP4 (H.264) first: plays everywhere and Windows encodes it on the GPU (JP, 2026-11-17: MP4, 1080p60 or 4K30).
    // WebM VP8 stays as the fallback.
    const mime =
      ["video/mp4;codecs=avc1.640033", "video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp8", "video/webm"].find((m) =>
        MediaRecorder.isTypeSupported(m),
      ) ?? "";
    if (!mime) return "This system cannot record video (no video encoder).";
    try {
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: q.bitrate });
      await engine.videoStart(mime, performance.timeOrigin + performance.now());
      let failed = false;
      sending.current = Promise.resolve();
      rec.ondataavailable = (e) => {
        if (!e.data.size || failed) return;
        // Chunks are sent one after another, in order. One lost piece would damage the file: stop at the first error.
        sending.current = sending.current
          .then(() => toBase64(e.data).then((b) => engine.videoChunk(b)))
          .catch((err) => {
            if (failed) return;
            failed = true;
            if (rec.state !== "inactive") rec.stop();
            errRef.current?.("The camera recording stopped: " + String(err?.message ?? err) + ". The sound of the take is not affected.");
          });
      };
      // The clock pair for lining picture and sound up is taken when the recorder really starts.
      rec.onstart = () => engine.videoMark(performance.timeOrigin + performance.now()).catch(() => {});
      rec.start(1000);
      recorder.current = rec;
      setRecording(true);
      return "";
    } catch (e: any) {
      return "The camera picture is not recorded: " + String(e.message ?? e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the current stream from outRef
  }, []);

  /** Stops the camera recording and closes the file (after the last piece has been written). */
  const stopRecording = useCallback(async () => {
    const rec = recorder.current;
    recorder.current = null;
    setRecording(false);
    if (!rec) return null;
    if (rec.state !== "inactive")
      await new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
        rec.stop();
      });
    await sending.current;
    return engine.videoStop().catch(() => null);
  }, []);

  // Leaving the screen during a take: finish the file properly (the take's sound keeps recording).
  useEffect(
    () => () => {
      const rec = recorder.current;
      recorder.current = null;
      if (!rec) return;
      if (rec.state !== "inactive") rec.stop();
      sending.current.then(() => engine.videoStop()).catch(() => {});
    },
    [],
  );

  // Focus: auto (the camera's own), or a fixed distance the user picks (keeps the room sharp, no hunting).
  // Only when the camera reports manual focus (the EMEET C60E does: 0-1023).
  const [focus, setFocusState] = useState<FocusSetting>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(FOCUS_STORE) || "null");
      if (v && typeof v.auto === "boolean" && typeof v.value === "number") return v;
    } catch {
      /* first run */
    }
    return { auto: true, value: 0.5 };
  });
  const track = raw?.getVideoTracks()[0];
  const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { focusMode?: string[]; focusDistance?: { min: number; max: number } };
  const canFocus = !!caps.focusMode?.includes("manual") && !!caps.focusDistance;
  useEffect(() => {
    if (!track || !canFocus) return;
    const r = caps.focusDistance!;
    const c = focus.auto
      ? { focusMode: "continuous" }
      : { focusMode: "manual", focusDistance: Math.round(r.min + focus.value * (r.max - r.min)) };
    track.applyConstraints({ advanced: [c as MediaTrackConstraintSet] }).catch(() => {});
    // caps is derived from the track; the track and the setting are what change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, canFocus, focus.auto, focus.value]);
  const setFocus = (f: FocusSetting) => {
    setFocusState(f);
    try {
      localStorage.setItem(FOCUS_STORE, JSON.stringify(f));
    } catch {
      /* not remembered */
    }
  };

  // ---- camera settings (in the camera itself: white balance, exposure, tone) ----
  const [tune, setTuneState] = useState<CameraTune>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(TUNE_STORE) || "null");
      if (v && typeof v === "object") return { ...DEFAULT_TUNE, ...v };
    } catch {
      /* first run */
    }
    return DEFAULT_TUNE;
  });
  const tuneCaps = (track?.getCapabilities?.() ?? {}) as Record<string, any>;
  const camDefaults = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!track) return;
    // the camera's own values the first time it opens: "Auto" / reset goes back to these
    const st = track.getSettings() as Record<string, any>;
    for (const k of ["brightness", "contrast", "saturation", "exposureCompensation"])
      if (typeof st[k] === "number" && camDefaults.current[k] === undefined) camDefaults.current[k] = st[k];
  }, [track]);
  useEffect(() => {
    if (!track) return;
    const c: Record<string, unknown> = {};
    if (tuneCaps.whiteBalanceMode) {
      if (tune.whiteBalance === "auto") c.whiteBalanceMode = "continuous";
      else {
        c.whiteBalanceMode = "manual";
        if (tuneCaps.colorTemperature) c.colorTemperature = tune.whiteBalance;
      }
    }
    const set = (k: keyof CameraTune & string) => {
      const v = tune[k];
      const cap = tuneCaps[k];
      if (!cap) return;
      c[k] = typeof v === "number" ? Math.min(cap.max, Math.max(cap.min, v)) : camDefaults.current[k];
    };
    set("brightness");
    set("contrast");
    set("saturation");
    set("exposureCompensation");
    for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
    track.applyConstraints({ advanced: [c as MediaTrackConstraintSet] }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tuneCaps follows the track
  }, [track, tune]);
  const setTune = (t: Partial<CameraTune>) =>
    setTuneState((cur) => {
      const next = { ...cur, ...t };
      try {
        localStorage.setItem(TUNE_STORE, JSON.stringify(next));
      } catch {
        /* not remembered */
      }
      return next;
    });

  // ---- look (OBS-style LUT on the GPU): baked into the preview, the pop-out and the recording ----
  const [look, setLookState] = useState<LookState>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(LOOK_STORE) || "null");
      if (v && typeof v.id === "string")
        return { id: v.id, strength: typeof v.strength === "number" ? v.strength : 1, gains: Array.isArray(v.gains) ? v.gains : [1, 1, 1] };
    } catch {
      /* first run */
    }
    return { id: "none", strength: 1, gains: [1, 1, 1] };
  });
  const setLook = (l: Partial<LookState>) =>
    setLookState((cur) => {
      const next = { ...cur, ...l };
      try {
        localStorage.setItem(LOOK_STORE, JSON.stringify(next));
      } catch {
        /* not remembered */
      }
      return next;
    });
  const [lookError, setLookError] = useState("");
  // The pop-out window (another page) follows changes made in Session, and the other way round.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      try {
        if (e.key === LOOK_STORE && e.newValue) setLookState(JSON.parse(e.newValue));
        if (e.key === TUNE_STORE && e.newValue) setTuneState({ ...DEFAULT_TUNE, ...JSON.parse(e.newValue) });
      } catch {
        /* ignore a broken value */
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const processor = useRef<LookProcessor | null>(null);
  const [looked, setLooked] = useState<MediaStream | null>(null);
  const lookOn = look.id !== "none" || look.gains.some((x) => Math.abs(x - 1) > 0.001); // a colour fix alone also needs the GPU
  // The GPU pipeline runs only while a look is chosen (no look = the camera stream as it is, zero cost).
  useEffect(() => {
    if (!raw || !lookOn) return;
    let p: LookProcessor;
    try {
      p = new LookProcessor(raw, q.fps);
    } catch (e: any) {
      setLookError(String(e.message ?? e));
      return;
    }
    setLookError("");
    processor.current = p;
    setLooked(p.stream);
    return () => {
      processor.current = null;
      setLooked(null);
      p.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- q follows quality (raw re-opens on a quality change)
  }, [raw, lookOn]);
  useEffect(() => {
    const p = processor.current;
    if (!p) return;
    p.setStrength(look.id === "none" ? 0 : look.strength);
    p.setGains(look.gains);
    let cancelled = false;
    (async () => {
      try {
        if (look.id.startsWith("cube:")) {
          const text = await loadCube(look.id.slice(5));
          if (!text) throw new Error("That LUT file is no longer saved. Import it again.");
          if (!cancelled) p.setLut(parseCube(text));
        } else p.setLut(builtInLut(look.id));
        if (!cancelled) setLookError("");
      } catch (e: any) {
        if (!cancelled) setLookError(String(e.message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [looked, look.id, look.strength, look.gains]);

  /** Measures one frame of the camera and sets the colour fix that makes its mid-tones neutral. */
  const autoColourFix = useCallback(async () => {
    if (!raw) return;
    const v = document.createElement("video");
    v.muted = true;
    v.srcObject = raw;
    await v.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 180;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(v, 0, 0, 320, 180);
    v.srcObject = null;
    setLook({ gains: neutralGains(g.getImageData(0, 0, 320, 180).data) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setLook is stable in effect
  }, [raw]);

  const stream = lookOn ? looked : raw;
  outRef.current = stream;
  return {
    devices,
    deviceId,
    choose,
    stream,
    error,
    info,
    startRecording,
    stopRecording,
    canFocus,
    focus,
    setFocus,
    quality,
    setQuality,
    tune,
    setTune,
    tuneCaps,
    /** the camera's current values (for the sliders while on Auto) */
    tuneNow: (track?.getSettings?.() ?? {}) as Record<string, any>,
    look,
    setLook,
    lookError,
    autoColourFix,
  };
}

/** auto = the camera focuses by itself; otherwise value 0..1 across the camera's manual focus range */
export interface FocusSetting {
  auto: boolean;
  value: number;
}
const FOCUS_STORE = "wsa.cameraFocus";

/**
 * Settings inside the camera (no quality loss): white balance ("auto" or a colour temperature in kelvin; a warm
 * bulb is about 3000 K), exposure compensation, brightness, contrast, saturation (null = the camera's own value).
 */
export interface CameraTune {
  whiteBalance: "auto" | number;
  exposureCompensation: number | null;
  brightness: number | null;
  contrast: number | null;
  saturation: number | null;
}
const DEFAULT_TUNE: CameraTune = { whiteBalance: "auto", exposureCompensation: null, brightness: null, contrast: null, saturation: null };
const TUNE_STORE = "wsa.cameraTune";
const LOOK_STORE = "wsa.cameraLook";
/** the chosen look, its strength, and the colour fix (per-colour gains before the look) */
export interface LookState {
  id: LookId;
  strength: number;
  gains: [number, number, number];
}

export type CameraQuality = "1080p60" | "4k30";
const QUALITY_STORE = "wsa.cameraQuality";
/** Bitrates for a clean master: about 16 Mbit/s for 1080p60, 40 Mbit/s for 4K30 (H.264). */
const QUALITIES: Record<CameraQuality, { width: number; height: number; fps: number; bitrate: number }> = {
  "1080p60": { width: 1920, height: 1080, fps: 60, bitrate: 16_000_000 },
  "4k30": { width: 3840, height: 2160, fps: 30, bitrate: 40_000_000 },
};
