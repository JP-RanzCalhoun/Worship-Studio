// Configurable keyboard shortcuts. Stored per user in localStorage (a convenience, safe to lose).

export type Action = "playPause" | "back5" | "fwd5" | "toStart" | "prevSection" | "nextSection" | "toggleLoop" | "muteGuitars" | "toggleClick" | "record" | "hearGuitar" | "hearVocal" | "undo" | "redo";
/** Actions the Session screen carries out (sent to it as a "ws-action" event); they also work with no song open. */
export const SESSION_ACTIONS: Action[] = ["record", "hearGuitar", "hearVocal"];

export const ACTION_LABEL: Record<Action, string> = {
  playPause: "Play / pause",
  back5: "Back 5 seconds",
  fwd5: "Forward 5 seconds",
  toStart: "Go to start",
  prevSection: "Previous section",
  nextSection: "Next section",
  toggleLoop: "Loop on / off",
  muteGuitars: "Mute reference guitars",
  toggleClick: "Click on / off",
  record: "Record / stop (Session)",
  hearGuitar: "Hear the guitar on / off",
  hearVocal: "Hear the vocal on / off",
  undo: "Undo chart / mix change",
  redo: "Redo",
};

export const DEFAULT_KEYS: Record<Action, string> = {
  playPause: "Space",
  back5: "ArrowLeft",
  fwd5: "ArrowRight",
  toStart: "Home",
  prevSection: "BracketLeft",
  nextSection: "BracketRight",
  toggleLoop: "KeyL",
  muteGuitars: "KeyM",
  toggleClick: "KeyK",
  record: "KeyR",
  hearGuitar: "KeyG",
  hearVocal: "KeyV",
  undo: "Ctrl+KeyZ",
  redo: "Ctrl+KeyY",
};

const STORE = "wsa.shortcuts";

export function loadKeys(): Record<Action, string> {
  try {
    return { ...DEFAULT_KEYS, ...JSON.parse(localStorage.getItem(STORE) ?? "{}") };
  } catch {
    return { ...DEFAULT_KEYS };
  }
}

export function saveKeys(k: Record<Action, string>) {
  try {
    localStorage.setItem(STORE, JSON.stringify(k));
  } catch {
    /* storage unavailable: keep in memory only */
  }
}

/** "Ctrl+KeyZ" style id for a key event. Uses physical key codes so layouts do not matter. */
export function comboOf(e: KeyboardEvent): string {
  return (e.ctrlKey ? "Ctrl+" : "") + (e.shiftKey ? "Shift+" : "") + (e.altKey ? "Alt+" : "") + e.code;
}

export function prettyCombo(c: string): string {
  return c
    .replace(/Key([A-Z])/, "$1")
    .replace("BracketLeft", "[")
    .replace("BracketRight", "]")
    .replace("ArrowLeft", "←")
    .replace("ArrowRight", "→")
    .replace(/Digit(\d)/, "$1");
}
