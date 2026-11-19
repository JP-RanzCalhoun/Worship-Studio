import { useEffect, useMemo, useRef, useState } from "react";
import { on } from "../bridge";
import { contextFor, shownChords } from "../chart";
import { engine } from "../engine";
import { ChordBand } from "../session/ChordBand";
import { useShowGuesses } from "../session/useShowGuesses";
import { useCamera } from "../session/useCamera";
import { type Analysis, chartOf, normalizeSong, type SongDoc } from "../song";
import { beatGrid } from "../timeline";

/**
 * Full-screen scene for a second display (the host opens it in its own window, like an OBS projector).
 * "chords": the live chord band, big. "camera": the camera picture. Esc closes it.
 * It only reads: it never changes the song or the audio engine.
 */
export function Projector({ view, songId }: { view: string; songId: string }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && engine.projectorClose();
    window.addEventListener("keydown", key);
    document.body.classList.add("projector");
    return () => {
      window.removeEventListener("keydown", key);
      document.body.classList.remove("projector");
    };
  }, []);
  return view === "camera" ? <CameraProjector /> : <ChordsProjector songId={songId} />;
}

function ChordsProjector({ songId: firstSong }: { songId: string }) {
  const [songId, setSongId] = useState(firstSong);
  useEffect(() => on("songLoaded", (id: string) => setSongId(id)), []);
  const [data, setData] = useState<{ song: SongDoc; analysis: Analysis | null } | null>(null);
  const [t, setT] = useState({ pos: 0, playing: false });
  const [showGuesses] = useShowGuesses(); // same switch as Session (shared through storage)
  useEffect(() => on("transport", (x) => setT(x)), []);
  // Read the song again every few seconds: chord edits in the main window show up here too.
  useEffect(() => {
    const load = () =>
      engine
        .readProject(songId)
        .then((p: any) => setData({ song: normalizeSong(p.song ?? {}), analysis: (p.analysis ?? null) as Analysis | null }))
        .catch(() => {});
    load();
    const id = window.setInterval(load, 3000);
    return () => window.clearInterval(id);
  }, [songId]);
  const chart = useMemo(() => (data ? chartOf(data.song, data.analysis) : null), [data]);
  const grid = useMemo(() => (data ? beatGrid(data.analysis, data.song.click, data.song.duration) : []), [data]);
  if (!data || !chart) return <div className="projector-empty">Loading the song…</div>;
  return (
    <div className="projector-stage">
      <h1 className="projector-title">{data.song.title}</h1>
      <ChordBand chords={shownChords(chart.chords, showGuesses)} sections={chart.sections} grid={grid} ctx={contextFor(data.song, data.analysis)} pos={Math.max(0, t.pos)}
        lyrics={data.song.lyrics} big empty={<span className="muted">No chart for this song yet.</span>} />
    </div>
  );
}

function CameraProjector() {
  const camera = useCamera(true);
  const v = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (v.current) v.current.srcObject = camera.stream;
  }, [camera.stream]);
  // Mirrored like the Session preview (you see yourself as in a mirror); click the picture to flip it.
  const [mirror, setMirror] = useState(true);
  return (
    <div className="projector-camera" onClick={() => setMirror(!mirror)} title="Click to mirror or un-mirror">
      {camera.error ? <div className="projector-empty">{camera.error}</div> : <video ref={v} autoPlay muted playsInline className={mirror ? "is-mirrored" : ""} />}
    </div>
  );
}
