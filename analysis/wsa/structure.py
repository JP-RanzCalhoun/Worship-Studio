"""Song section boundaries from self-similarity, snapped to downbeats.

Labels are suggestions only (letters for repeated material plus simple hints such as
"Intro", "Instrumental", "Outro"). The user renames them; we never claim "Chorus" as fact.
"""

from __future__ import annotations

import numpy as np


def segment(
    chroma_sync: np.ndarray,
    mfcc_sync: np.ndarray,
    bar_times: np.ndarray,
    vocal_rms_sync: np.ndarray | None = None,
    min_bars: int = 8,
) -> list[dict]:
    """Bar-synchronous features -> sections.

    chroma_sync / mfcc_sync: (features x n_bars); bar_times: n_bars + 1 edges.
    vocal_rms_sync: optional per-bar vocal stem level, used to flag instrumental parts.
    """
    import librosa
    import scipy.ndimage

    n = chroma_sync.shape[1]
    if n < 2 * min_bars:
        return [_section("Song", bar_times[0], bar_times[-1], "A", 0.2)]

    feats = np.vstack(
        [
            librosa.util.normalize(chroma_sync, axis=0),
            librosa.util.normalize(mfcc_sync, axis=0),
        ]
    )
    sim = np.corrcoef(feats.T)
    sim = np.nan_to_num(sim)

    # Checkerboard novelty along the diagonal.
    w = min_bars
    kern = np.kron(np.array([[1, -1], [-1, 1]]), np.ones((w, w)))
    pad = np.pad(sim, w, mode="edge")
    novelty = np.array([(pad[i : i + 2 * w, i : i + 2 * w] * kern).sum() for i in range(n)])
    novelty = scipy.ndimage.uniform_filter1d(novelty, 2)
    novelty = (novelty - novelty.min()) / (np.ptp(novelty) + 1e-9)

    # Peaks at least min_bars apart.
    cands = [i for i in range(1, n - 1) if novelty[i] >= novelty[i - 1] and novelty[i] >= novelty[i + 1] and novelty[i] > 0.3]
    bounds = [0]
    for i in sorted(cands, key=lambda i: -novelty[i]):
        if all(abs(i - b) >= min_bars for b in bounds) and n - i >= min_bars:
            bounds.append(i)
    bounds = sorted(bounds) + [n]

    # Cluster sections by mean feature similarity to assign repeat letters.
    means = [feats[:, a:b].mean(axis=1) for a, b in zip(bounds[:-1], bounds[1:])]
    letters: list[str] = []
    protos: list[np.ndarray] = []
    for m in means:
        best, best_sim = None, 0.0
        for j, p in enumerate(protos):
            s = float(np.dot(m, p) / (np.linalg.norm(m) * np.linalg.norm(p) + 1e-9))
            if s > best_sim:
                best, best_sim = j, s
        if best is not None and best_sim > 0.96:
            letters.append(chr(ord("A") + best))
        else:
            protos.append(m)
            letters.append(chr(ord("A") + len(protos) - 1))

    sections = []
    for idx, (a, b) in enumerate(zip(bounds[:-1], bounds[1:])):
        hint = letters[idx]
        if vocal_rms_sync is not None:
            v = float(np.mean(vocal_rms_sync[a:b]))
            vmax = float(np.max(vocal_rms_sync)) + 1e-9
            if v < 0.15 * vmax:
                hint = "Intro" if idx == 0 else ("Outro" if b == n else "Instrumental")
        conf = float(novelty[a]) if a > 0 else 0.5
        sections.append(_section(hint, bar_times[a], bar_times[b], letters[idx], conf))
    return _merge_same(sections)


def _merge_same(sections: list[dict]) -> list[dict]:
    """Join neighbours with the same label: a repeated pattern inside one part is not a new section."""
    merged: list[dict] = []
    for s in sections:
        if merged and merged[-1]["label"] == s["label"]:
            merged[-1]["end"] = s["end"]
            merged[-1]["confidence"] = round(min(merged[-1]["confidence"], s["confidence"]), 2)
        else:
            merged.append(dict(s))
    return merged


def _section(label: str, start: float, end: float, group: str, conf: float) -> dict:
    return {
        "label": label,
        "group": group,
        "start": round(float(start), 3),
        "end": round(float(end), 3),
        "confidence": round(float(np.clip(conf, 0, 1)), 2),
        "suggested": True,
    }
