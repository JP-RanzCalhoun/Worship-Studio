import { useState, type CSSProperties, type RefObject } from "react";

const STORE = "wsa.sceneSplit";

interface Split {
  /** share of the width for the song (YouTube) box, 0.2-0.8 */
  col: number;
  /** height of the boxes row in CSS px; null = automatic */
  height: number | null;
}

function load(): Split {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) || "null");
    if (v && typeof v.col === "number") return { col: Math.min(0.8, Math.max(0.2, v.col)), height: typeof v.height === "number" ? v.height : null };
  } catch {
    /* first run */
  }
  return { col: 0.5, height: null };
}

/**
 * OBS-style sizing of the Session boxes: drag the line between the video and the camera (width), and the line
 * under them (height). Remembered; double-click a line to reset it.
 */
export function useSceneSplit() {
  const [split, setSplit] = useState<Split>(load);
  // Merges into the latest value (two quick drags never overwrite each other with a stale copy).
  const save = (patch: Partial<Split>) =>
    setSplit((cur) => {
      const s = { ...cur, ...patch };
      try {
        localStorage.setItem(STORE, JSON.stringify(s));
      } catch {
        /* not remembered */
      }
      return s;
    });
  /** style for the .scenes row (both boxes shown = 3 columns with the divider) */
  const scenesStyle = (both: boolean, browsing: boolean): CSSProperties => {
    if (browsing) return {};
    return {
      ...(both ? { gridTemplateColumns: `minmax(0, ${split.col}fr) 10px minmax(0, ${1 - split.col}fr)` } : {}),
      ...(split.height ? { flex: `0 0 ${split.height}px` } : {}),
    };
  };
  return { split, save, scenesStyle };
}

/** A draggable divider. "col": between the two boxes; "row": under the boxes row. */
export function Splitter({
  dir,
  target,
  split,
  save,
}: {
  dir: "col" | "row";
  target: RefObject<HTMLElement | null>;
  split: Split;
  save: (patch: Partial<Split>) => void;
}) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = target.current;
    if (!el) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const box = el.getBoundingClientRect();
    let next: Partial<Split> = {};
    const move = (ev: PointerEvent) => {
      if (dir === "col") next = { col: Math.min(0.8, Math.max(0.2, (ev.clientX - box.left) / box.width)) };
      else next = { height: Math.round(Math.min(window.innerHeight * 0.8, Math.max(150, ev.clientY - box.top))) };
      // live preview while dragging (no storage write per move)
      if (next.col !== undefined) el.style.gridTemplateColumns = `minmax(0, ${next.col}fr) 10px minmax(0, ${1 - next.col}fr)`;
      else el.style.flex = `0 0 ${next.height}px`;
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      if (next.col !== undefined || next.height !== undefined) save(next);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const reset = () => save(dir === "col" ? { col: 0.5 } : { height: null });
  const keys = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.03;
    if (dir === "col" && (e.key === "ArrowLeft" || e.key === "ArrowRight"))
      save({ col: Math.min(0.8, Math.max(0.2, split.col + (e.key === "ArrowLeft" ? -step : step))) });
    if (dir === "row" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const h = split.height ?? target.current?.getBoundingClientRect().height ?? 300;
      save({ height: Math.round(Math.max(150, h + (e.key === "ArrowUp" ? -40 : 40))) });
    }
  };
  return (
    <div
      className={`splitter splitter-${dir}`}
      role="separator"
      aria-orientation={dir === "col" ? "vertical" : "horizontal"}
      aria-label={dir === "col" ? "Resize the video and camera boxes" : "Resize the boxes' height"}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={reset}
      onKeyDown={keys}
    />
  );
}
