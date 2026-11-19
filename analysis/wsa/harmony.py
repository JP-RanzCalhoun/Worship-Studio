"""Key and chord estimation from chroma.

Transparent, template-based method (no opaque model weights):
  1. Beat-synchronous chroma from the harmonic part of the song (stems when available).
  2. Score every beat against chord templates (cosine similarity).
  3. Smooth with a Viterbi pass that prefers staying on the same chord.
  4. Report a confidence per segment from the margin between best and runner-up.

This is a starting point for the user to correct, not a ground truth.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Interval sets (semitones above root) and a small prior penalty so simple triads win close calls.
QUALITIES: dict[str, tuple[tuple[int, ...], float]] = {
    "": ((0, 4, 7), 0.0),
    "m": ((0, 3, 7), 0.0),
    "7": ((0, 4, 7, 10), 0.07),
    "maj7": ((0, 4, 7, 11), 0.07),
    "m7": ((0, 3, 7, 10), 0.06),
    "sus4": ((0, 5, 7), 0.08),
    "sus2": ((0, 2, 7), 0.09),
}

# Krumhansl-Kessler key profiles.
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


@dataclass
class ChordLabel:
    root: int | None  # None = no chord
    quality: str
    bass: int | None = None

    def name(self) -> str:
        if self.root is None:
            return "N.C."
        s = NOTE_NAMES[self.root] + self.quality
        if self.bass is not None and self.bass != self.root:
            s += "/" + NOTE_NAMES[self.bass]
        return s


def _templates() -> tuple[np.ndarray, list[ChordLabel], np.ndarray]:
    mats, labels, penalties = [], [], []
    for root in range(12):
        for q, (ivs, pen) in QUALITIES.items():
            t = np.zeros(12)
            for iv in ivs:
                t[(root + iv) % 12] = 1.0
            t[root] += 0.5  # root weighs a bit more
            mats.append(t / np.linalg.norm(t))
            labels.append(ChordLabel(root, q))
            penalties.append(pen)
    return np.array(mats), labels, np.array(penalties)


def estimate_key(chroma_total: np.ndarray) -> dict:
    """Krumhansl-Schmuckler key estimate. Returns tonic, mode, and a margin-based confidence (0-1)."""
    c = chroma_total / (np.linalg.norm(chroma_total) + 1e-9)
    scores = []
    for mode, prof in (("major", MAJOR_PROFILE), ("minor", MINOR_PROFILE)):
        for tonic in range(12):
            p = np.roll(prof, tonic)
            scores.append((float(np.corrcoef(c, p)[0, 1]), tonic, mode))
    scores.sort(reverse=True)
    best, second = scores[0], scores[1]
    # Relative major/minor are often near-ties; report the alternative so the UI can show it.
    margin = best[0] - second[0]
    return {
        "tonic": NOTE_NAMES[best[1]],
        "mode": best[2],
        "name": NOTE_NAMES[best[1]] + ("m" if best[2] == "minor" else ""),
        "confidence": round(float(np.clip(margin * 2.5, 0, 0.9)), 2),  # never claim certainty
        "alternative": NOTE_NAMES[second[1]] + ("m" if second[2] == "minor" else ""),
    }


def refine_key_with_chords(key: dict, segments: list[dict]) -> dict:
    """Pick between the chroma key and its relative major/minor using which chord gets the most time."""
    if not segments:
        return key
    dur: dict[str, float] = {}
    for s in segments:
        if s["chord"] != "N.C.":
            base = s["chord"].split("/")[0]
            dur[base] = dur.get(base, 0.0) + s["end"] - s["start"]
    tonic = NOTE_NAMES.index(key["tonic"])
    if key["mode"] == "major":
        alt = NOTE_NAMES[(tonic + 9) % 12] + "m"
        this = key["tonic"]
    else:
        alt = NOTE_NAMES[(tonic + 3) % 12]
        this = key["tonic"] + "m"
    if dur.get(alt, 0) > 1.5 * dur.get(this, 0):
        name = alt
        return {
            **key,
            "tonic": name.rstrip("m"),
            "mode": "minor" if name.endswith("m") else "major",
            "name": name,
            "alternative": key["name"],
            "confidence": round(min(key["confidence"], 0.5), 2),
        }
    return key


def estimate_chords(
    chroma: np.ndarray,
    beat_times: np.ndarray,
    bass_chroma: np.ndarray | None = None,
    stay_prob: float = 0.85,
    min_energy: float = 1e-3,
) -> list[dict]:
    """Chord segments from beat-synchronous chroma (12 x n_beats).

    beat_times has n_beats + 1 entries (segment edges).
    Returns [{start, end, chord, confidence}] with consecutive equal chords merged.
    """
    T, labels, penalties = _templates()
    n = chroma.shape[1]
    energy = chroma.sum(axis=0)
    norm = chroma / (np.linalg.norm(chroma, axis=0, keepdims=True) + 1e-9)
    sim = T @ norm - penalties[:, None]  # (n_templates, n_beats)
    # "No chord" state: wins only when the frame is near-silent.
    nc = np.where(energy < min_energy * energy.max(), 1.0, 0.0)
    sim = np.vstack([sim, nc[None, :]])
    labels = labels + [ChordLabel(None, "")]

    # Viterbi over beats with uniform switching cost.
    k = sim.shape[0]
    log_stay, log_move = np.log(stay_prob), np.log((1 - stay_prob) / (k - 1))
    emit = sim * 8.0  # sharpen similarities into log-likelihood-like scores
    score = emit[:, 0].copy()
    back = np.zeros((k, n), dtype=np.int32)
    for t in range(1, n):
        best_prev = int(np.argmax(score))
        move = score[best_prev] + log_move
        stay = score + log_stay
        choose_stay = stay >= move
        back[:, t] = np.where(choose_stay, np.arange(k), best_prev)
        score = np.where(choose_stay, stay, move) + emit[:, t]
    path = np.zeros(n, dtype=np.int32)
    path[-1] = int(np.argmax(score))
    for t in range(n - 1, 0, -1):
        path[t - 1] = back[path[t], t]

    # Per-beat margin between chosen label and best other label.
    sorted_sim = np.sort(sim, axis=0)
    chosen = sim[path, np.arange(n)]
    runner = np.where(chosen >= sorted_sim[-1], sorted_sim[-2], sorted_sim[-1])
    margin = np.clip((chosen - runner) * 4 + 0.5, 0, 1)

    segments: list[dict] = []
    start = 0
    for t in range(1, n + 1):
        if t == n or path[t] != path[start]:
            lab = labels[path[start]]
            if lab.root is not None and bass_chroma is not None:
                lab = _with_bass(lab, bass_chroma[:, start:t])
            segments.append(
                {
                    "start": round(float(beat_times[start]), 3),
                    "end": round(float(beat_times[t]), 3),
                    "chord": lab.name(),
                    "confidence": round(float(margin[start:t].mean()), 2),
                }
            )
            start = t
    return segments


def _with_bass(lab: ChordLabel, bass: np.ndarray) -> ChordLabel:
    """Mark a slash chord when the bass clearly sits on the chord's 3rd or 5th."""
    prof = bass.sum(axis=1)
    if prof.sum() <= 0:
        return lab
    prof = prof / prof.sum()
    b = int(np.argmax(prof))
    if b == lab.root or prof[b] < 0.35:
        return lab
    ivs = QUALITIES[lab.quality][0]
    if (b - lab.root) % 12 in ivs[1:3]:  # 3rd or 5th only, to stay conservative
        return ChordLabel(lab.root, lab.quality, b)
    return lab
