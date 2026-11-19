// Thin bridge to the JUCE host (WebBrowserComponent native integration).
// Protocol: emit "__juce__invoke" {name, params, resultId}; host answers with "__juce__complete" {promiseId, result}.

type Listener = (payload: any) => void;

interface JuceBackend {
  addEventListener(id: string, fn: Listener): [string, number];
  removeEventListener(handle: [string, number]): void;
  emitEvent(id: string, payload: unknown): void;
}

declare global {
  interface Window {
    __JUCE__?: { backend: JuceBackend; initialisationData: { __juce__functions: string[] } };
  }
}

let nextId = 0;
const pending = new Map<number, (v: unknown) => void>();
let hookedBackend: JuceBackend | null = null;

export function engineAvailable(): boolean {
  return !!window.__JUCE__?.backend;
}

/** Host strings that look like JSON are parsed; anything that fails to parse is passed on as the raw string. */
function parseMaybeJson(raw: unknown): unknown {
  if (typeof raw !== "string" || !(raw.startsWith("{") || raw.startsWith("["))) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function hook() {
  const backend = window.__JUCE__?.backend;
  if (!backend || backend === hookedBackend) return;
  hookedBackend = backend; // a new backend object (e.g. after the host re-created it) gets its own listener
  backend.addEventListener("__juce__complete", ({ promiseId, result }) => {
    pending.get(promiseId)?.(result);
    pending.delete(promiseId);
  });
}

export class EngineUnavailable extends Error {
  constructor() {
    super("The audio engine is not connected. Open this screen from the Worship Studio app.");
  }
}

export class EngineTimeout extends Error {
  constructor(name: string, seconds: number) {
    super(`The app did not answer "${name}" within ${seconds} seconds. Try again; if it keeps happening, restart Worship Studio.`);
  }
}

/**
 * How long a call may take before the UI gives up waiting (the host may still finish the work).
 * Calls that open a file dialog or do long work get much longer limits than quick state changes.
 */
const LONG_CALLS: Record<string, number> = {
  importSong: 3600, // file dialog + decode
  importPath: 900,
  exportMix: 3600, // file dialog + render
  captureSave: 900,
  recStop: 900, // lines up long takes (and a solo take: mix + import)
  soloRecover: 900, // mixes and imports solo takes left by a crash
  setCues: 300, // loads spoken cue sounds
  renderCues: 300, // Windows speech renders each cue word
  loadSong: 120,
  peaks: 120,
  analyze: 60,
  sidecarInfo: 300, // a cold start (first run, antivirus scan) loads Python + PyTorch + CUDA
  setDevices: 60,
  captureStart: 30, // Windows can take a few seconds to start process capture
  recStart: 60, // opens each input (up to 10 s each)
  recMonitor: 60,
  tuner: 30,
  projectorOpen: 30, // creates a second browser window
  videoChunk: 60, // about 1 s of camera video per call
  deleteSong: 60,
};
const DEFAULT_TIMEOUT_S = 20;

/** Call a native function. Results come back as parsed JSON when the host returns a JSON string. */
export async function call<T = unknown>(name: string, ...params: unknown[]): Promise<T> {
  if (!window.__JUCE__) throw new EngineUnavailable();
  hook();
  const id = nextId++;
  const seconds = LONG_CALLS[name] ?? DEFAULT_TIMEOUT_S;
  let timer = 0;
  const result = new Promise<unknown>((resolve, reject) => {
    pending.set(id, resolve);
    timer = window.setTimeout(() => {
      pending.delete(id); // a late answer is ignored
      reject(new EngineTimeout(name, seconds));
    }, seconds * 1000);
  });
  try {
    window.__JUCE__.backend.emitEvent("__juce__invoke", { name, params, resultId: id });
    const raw = parseMaybeJson(await result);
    if (raw && typeof raw === "object" && !Array.isArray(raw) && typeof (raw as any).error === "string" && !(raw as any).path)
      throw new Error((raw as any).error);
    return raw as T;
  } finally {
    window.clearTimeout(timer);
    pending.delete(id);
  }
}

/** Subscribe to an event pushed by the host. Returns an unsubscribe function. */
export function on(event: string, fn: Listener): () => void {
  if (!window.__JUCE__) return () => {};
  const handle = window.__JUCE__.backend.addEventListener(event, (p) => fn(parseMaybeJson(p)));
  return () => window.__JUCE__?.backend.removeEventListener(handle);
}
