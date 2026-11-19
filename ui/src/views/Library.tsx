import { useState } from "react";
import { Button, Card, EmptyState } from "../components/ui";
import type { LibrarySong } from "../engine";

export function Library({
  songs,
  current,
  importing,
  onImport,
  onOpen,
  onSolo,
}: {
  /** record guitar and vocal without a song (it becomes a new song) */
  onSolo?: () => void;
  songs: LibrarySong[];
  current: string | null;
  importing: number | null;
  onImport: () => void;
  onOpen: (id: string) => void;
}) {
  const importBtn = (
    <>
      <Button variant="primary" size="lg" onClick={onImport} disabled={importing !== null}>
        {importing !== null ? `Importing… ${Math.round(importing * 100)}%` : "Import a song"}
      </Button>
      {onSolo && (
        <Button size="lg" onClick={onSolo} title="Record guitar and vocal without a song. It is saved as a new song here.">
          ● Record solo
        </Button>
      )}
    </>
  );
  if (!songs.length)
    return (
      <EmptyState title="Start with a song you want to learn" action={importBtn}>
        <p>Import an MP3, WAV, FLAC or M4A file you own. The app copies it into your library; the original stays where it is.</p>
        <ol className="steps-hint">
          <li>Import</li>
          <li>Analyze (stems, chords, sections)</li>
          <li>Review and prepare your guitar part</li>
          <li>Play along in Session with the reference guitars muted, and record yourself</li>
        </ol>
      </EmptyState>
    );
  return <LibraryList songs={songs} current={current} onOpen={onOpen} importBtn={importBtn} />;
}

/** "Today", "Yesterday", or the date. */
function when(ms: number): string {
  const d = new Date(ms), now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

function LibraryList({ songs, current, onOpen, importBtn }: { songs: LibrarySong[]; current: string | null; onOpen: (id: string) => void; importBtn: React.ReactNode }) {
  const [q, setQ] = useState("");
  const ready = songs.filter((s) => s.analyzed).length;
  const shown = q.trim() ? songs.filter((s) => s.title.toLowerCase().includes(q.trim().toLowerCase())) : songs;
  return (
    <div className="library-page">
      <div className="page-head">
        <div>
          <h1>Library</h1>
          <p className="muted page-sub num">
            {songs.length} {songs.length === 1 ? "song" : "songs"} · {ready} ready to play along
          </p>
        </div>
        <span className="spacer" />
        {importBtn}
      </div>
      <input className="library-find" type="search" placeholder="Find a song" aria-label="Find a song" value={q} onChange={(e) => setQ(e.target.value)} />
      <Card>
        {!shown.length && <p className="muted">No song matches “{q}”.</p>}
        <table className="table table-hover library-table" hidden={!shown.length}>
          <thead>
            <tr>
              <th>Song</th>
              <th>Key</th>
              <th>Status</th>
              <th>Changed</th>
              <th aria-hidden />
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.id} className={s.id === current ? "is-selected" : ""} onClick={() => onOpen(s.id)}>
                <td className="strong">
                  <button className="row-button" aria-current={s.id === current ? "true" : undefined} onClick={(e) => { e.stopPropagation(); onOpen(s.id); }}>
                    {s.title}
                  </button>
                  {/^Solo/.test(s.title) && <span className="pill lib-tag">Your recording</span>}
                  {s.id === current && <span className="pill lib-tag">Open</span>}
                </td>
                <td>{s.key ?? <span className="muted">—</span>}</td>
                <td>{s.analyzed ? <span className="pill pill-ok">Ready</span> : <span className="pill" title="Open it and press Analyze to get stems, chords and sections">Not analyzed</span>}</td>
                <td className="muted num">{when(s.modified)}</td>
                <td className="lib-go" aria-hidden>›</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <p className="muted small library-later">Coming later: setlists with the service order, key and capo changes between songs, and offline rehearsal packs.</p>
    </div>
  );
}
