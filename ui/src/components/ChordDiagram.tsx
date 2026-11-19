import type { Shape } from "../theory/guitar";

/** Small SVG chord box. Frets are low E to high e; -1 = muted, 0 = open. */
export function ChordDiagram({ shape, size = 64 }: { shape: Shape; size?: number }) {
  const played = shape.frets.filter((f) => f > 0);
  const minFret = played.length ? Math.min(...played) : 1;
  const maxFret = played.length ? Math.max(...played) : 1;
  const base = maxFret > 4 ? minFret : 1; // first fret shown
  const w = size,
    h = size * 1.15,
    padX = w * 0.16,
    padTop = h * 0.2,
    gridW = w - 2 * padX,
    gridH = h - padTop - h * 0.06;
  const sx = gridW / 5,
    fy = gridH / 4;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="chord-diagram" role="img" aria-label={`Chord diagram, frets ${shape.frets.map((f) => (f < 0 ? "x" : f)).join(" ")}`}>
      {base === 1 ? (
        <rect x={padX} y={padTop - 3} width={gridW} height={3} fill="currentColor" />
      ) : (
        <text x={2} y={padTop + fy * 0.7} fontSize={size * 0.15} fill="currentColor">
          {base}
        </text>
      )}
      {[0, 1, 2, 3, 4].map((i) => (
        <line key={"f" + i} x1={padX} x2={padX + gridW} y1={padTop + i * fy} y2={padTop + i * fy} stroke="currentColor" strokeOpacity={0.5} />
      ))}
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <line key={"s" + i} y1={padTop} y2={padTop + gridH} x1={padX + i * sx} x2={padX + i * sx} stroke="currentColor" strokeOpacity={0.5} />
      ))}
      {shape.barre && played.length > 0 && (() => {
        const idx = shape.frets.map((f, i) => (f === minFret ? i : -1)).filter((i) => i >= 0);
        const a = idx[0], b = idx[idx.length - 1];
        if (b <= a) return null;
        return <rect x={padX + a * sx - size * 0.05} y={padTop + (minFret - base + 0.5) * fy - size * 0.05} width={(b - a) * sx + size * 0.1} height={size * 0.1} rx={size * 0.05} fill="var(--diagram, var(--accent))" />;
      })()}
      {shape.frets.map((f, i) => {
        const x = padX + i * sx;
        if (f < 0)
          return (
            <text key={i} x={x} y={padTop - 6} fontSize={size * 0.14} textAnchor="middle" fill="currentColor">
              ×
            </text>
          );
        if (f === 0) return <circle key={i} cx={x} cy={padTop - 9} r={size * 0.04} fill="none" stroke="currentColor" />;
        return <circle key={i} cx={x} cy={padTop + (f - base + 0.5) * fy} r={size * 0.055} fill="var(--diagram, var(--accent))" />;
      })}
    </svg>
  );
}
