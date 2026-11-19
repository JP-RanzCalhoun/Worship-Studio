import { useEffect, useRef, useState } from "react";
import type { ChordSeg, Section } from "../song";
import { LOW_CONFIDENCE } from "../song";

interface Props {
  peaks: number[];
  duration: number;
  pos: number;
  sections: Section[];
  chords: ChordSeg[];
  chordLabel: (c: ChordSeg) => string;
  loop?: { a: number; b: number; enabled: boolean };
  onSeek: (t: number) => void;
  onLoop: (a: number, b: number) => void;
  theme?: string;
}

// Sections use neutral steps of the accent, so they never look like track roles.
const SECTION_ALPHA = [0.55, 0.32, 0.75, 0.22, 0.45, 0.65];

/** Waveform with section bands, chord lane, loop region and playhead. Click = seek, drag = set loop. */
export function Waveform({ peaks, duration, pos, sections, chords, chordLabel, loop, onSeek, onLoop, theme }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x0: number; moved: boolean } | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ro = new ResizeObserver(() => setWidth(c.clientWidth));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c || duration <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth,
      h = c.clientHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    const css = getComputedStyle(c);
    const v = (n: string, d: string) => css.getPropertyValue(n).trim() || d;
    const fg = v("--wave", "#7c9fd4");
    const dim = v("--wave-dim", "#3c4a62");
    const muted = v("--text-3", "#888");
    const text = v("--text", "#ddd");
    const accent = v("--section", v("--accent", "#5b9bff")); // section bands: neutral in the Stage light look
    const warn = v("--warn", "#f0b443");
    const x = (t: number) => (t / duration) * w;
    const secH = 18,
      chordH = 20,
      waveTop = secH + chordH + 4,
      waveH = h - waveTop;

    g.clearRect(0, 0, w, h);
    // sections
    const groups = [...new Set(sections.map((s) => s.group ?? s.label))];
    sections.forEach((s) => {
      g.fillStyle = accent;
      g.globalAlpha = SECTION_ALPHA[groups.indexOf(s.group ?? s.label) % SECTION_ALPHA.length];
      g.fillRect(x(s.start), 0, Math.max(1, x(s.end) - x(s.start) - 1), secH);
      g.globalAlpha = 1;
      if (s.suggested) {
        g.strokeStyle = text;
        g.setLineDash([3, 3]);
        g.strokeRect(x(s.start) + 0.5, 0.5, Math.max(1, x(s.end) - x(s.start) - 2), secH - 1);
        g.setLineDash([]);
      }
      g.fillStyle = text;
      g.font = "12px Segoe UI";
      g.save();
      g.beginPath();
      g.rect(x(s.start), 0, x(s.end) - x(s.start) - 2, secH);
      g.clip();
      g.fillText(s.label, x(s.start) + 4, 13);
      g.restore();
    });
    // chords
    g.font = "600 12px Segoe UI";
    chords.forEach((cd) => {
      const x0 = x(cd.start),
        x1 = x(cd.end);
      const low = !cd.confirmed && (cd.confidence ?? 1) < LOW_CONFIDENCE;
      g.fillStyle = muted;
      g.fillRect(x0, secH + 3, 1, chordH - 6);
      // Only draw a label that fits completely; a clipped "B|" is worse than none.
      const name = chordLabel(cd);
      if (g.measureText(name).width + 6 > x1 - x0) return;
      g.fillStyle = low ? muted : text;
      g.fillText(name, x0 + 3, secH + 14);
    });
    // loop
    if (loop && loop.b > loop.a) {
      g.fillStyle = warn;
      g.globalAlpha = loop.enabled ? 0.2 : 0.07;
      g.fillRect(x(loop.a), waveTop, x(loop.b) - x(loop.a), waveH);
      g.globalAlpha = 1;
      g.fillRect(x(loop.a), waveTop, 2, waveH);
      g.fillRect(x(loop.b) - 2, waveTop, 2, waveH);
    }
    // waveform
    const n = peaks.length;
    const played = x(Math.max(0, pos));
    for (let i = 0; i < n; i++) {
      const px = (i / n) * w;
      g.fillStyle = px <= played ? fg : dim;
      const a = peaks[i] * waveH * 0.48;
      g.fillRect(px, waveTop + waveH / 2 - a, Math.max(1, w / n), Math.max(1, 2 * a));
    }
    // playhead
    g.fillStyle = text;
    g.fillRect(played - 1, 0, 2, h);
  }, [peaks, duration, pos, sections, chords, loop, chordLabel, theme, width]);

  const timeAt = (e: React.MouseEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((e.clientX - r.left) / r.width) * duration));
  };

  return (
    <canvas
      ref={canvas}
      className="waveform"
      onMouseDown={(e) => (drag.current = { x0: timeAt(e), moved: false })}
      onMouseMove={(e) => {
        if (drag.current && Math.abs(timeAt(e) - drag.current.x0) > duration / 400) drag.current.moved = true;
      }}
      onMouseUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        const t = timeAt(e);
        if (d.moved) onLoop(Math.min(d.x0, t), Math.max(d.x0, t));
        else onSeek(t);
      }}
      title="Click to jump. Drag to set an A/B loop."
      role="slider"
      tabIndex={0}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 15 : 5;
        if (e.key === "ArrowLeft") onSeek(Math.max(0, pos - step));
        else if (e.key === "ArrowRight") onSeek(Math.min(duration, pos + step));
        else if (e.key === "Home") onSeek(0);
        else if (e.key === "End") onSeek(Math.max(0, duration - 1));
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
      aria-valuetext={`${Math.floor(Math.max(0, pos) / 60)} minutes ${Math.floor(Math.max(0, pos) % 60)} seconds`}
      aria-label="Song timeline"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(Math.max(0, pos))}
    />
  );
}
