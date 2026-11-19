"""Command-line entry point used by the desktop app.

Every line on stdout is one JSON object:
  {"type": "progress", "stage": "...", "pct": 0-100, "message": "..."}
  {"type": "result", ...}
  {"type": "error", "message": "..."}

The app cancels a job by killing this process. Partial outputs are written to a temp
folder and moved into place only when complete.

Commands:
  python -m wsa.cli info
  python -m wsa.cli analyze --source SONG --project DIR [--quality fast|balanced|best] [--device auto|cpu|cuda]
  python -m wsa.cli tts --out DIR --text "Verse 1" --text "1" ...
  python -m wsa.cli clean-vocal --input TAKE/Vocal.wav --out TAKE/Vocal.clean.wav [--device auto|cpu|cuda]
"""

from __future__ import annotations

import argparse
import os
import json
import shutil
import sys
import time
import traceback
import uuid
from pathlib import Path


def emit(**obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def progress(stage: str, pct: float, message: str = ""):
    emit(type="progress", stage=stage, pct=round(pct, 1), message=message)


def cmd_info(_args):
    import platform

    info = {"python": platform.python_version(), "cuda": False, "gpu": None, "vram_gb": None}
    try:
        import torch

        info["torch"] = torch.__version__
        if torch.cuda.is_available():
            p = torch.cuda.get_device_properties(0)
            info.update(cuda=True, gpu=p.name, vram_gb=round(p.total_memory / 2**30, 1))
    except ImportError:
        info["torch"] = None
    from .separate import PRESETS

    info["presets"] = {k: {"label": v.label, "note": v.note, "stems": v.stems, "license": v.license} for k, v in PRESETS.items()}
    emit(type="result", **info)


def cmd_analyze(args):
    from . import pipeline

    source = Path(args.source)
    project = Path(args.project)
    if not source.exists():
        raise FileNotFoundError(f"Song file not found: {source}")
    project.mkdir(parents=True, exist_ok=True)
    # Remove work folders left by cancelled or crashed jobs (their process is gone).
    import psutil

    for old in project.glob(".work-*"):
        pid = old.name.split("-")[-1]
        if not (pid.isdigit() and psutil.pid_exists(int(pid))):
            shutil.rmtree(old, ignore_errors=True)
    # One work folder per job, so two jobs can never delete each other's files.
    work = project / f".work-{os.getpid()}"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()

    t0 = time.perf_counter()
    try:
        result = pipeline.analyze(source, work, quality=args.quality, device=args.device, skip_separation=args.no_stems, on_progress=progress)
    except BaseException:
        shutil.rmtree(work, ignore_errors=True)  # a failed run leaves nothing behind
        raise
    result["elapsed_s"] = round(time.perf_counter() - t0, 1)

    # Move finished outputs into a NEW folder. The app may still be playing the old stems
    # (memory-mapped, so Windows cannot delete them); it switches over and cleans up on next load.
    if (work / "stems").exists():
        # Unique name: two analyses in the same second (or a leftover folder) must never collide.
        stems_dst = project / f"stems-{int(time.time())}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
        shutil.move(str(work / "stems"), str(stems_dst))
        # Paths are stored RELATIVE to the song folder, so moving the library (e.g. OneDrive) keeps working.
        for s in result.get("stems", []):
            s["path"] = f"{stems_dst.name}/{Path(s['path']).name}"
            if not (project / s["path"]).is_file():
                raise RuntimeError(f"Stem file missing after the move: {s['path']}. The previous analysis was kept.")
    tmp = project / "analysis.json.tmp"
    tmp.write_text(json.dumps(result, indent=2))
    os.replace(tmp, project / "analysis.json")  # atomic: never a half-written analysis
    shutil.rmtree(work, ignore_errors=True)
    emit(type="result", analysis=str(project / "analysis.json"), elapsed_s=result["elapsed_s"])


def cmd_tts(args):
    from .tts import render

    out = Path(args.out)
    from .tts import leads

    files = render(args.text, out, rate=args.rate, voice=args.voice)
    lead = leads(files)
    # Relative to the song folder ("cues/cue_x.wav"), so a moved library keeps its cues.
    rel = {t: f"{out.name}/{Path(p).name}" for t, p in files.items()}
    emit(type="result", files=rel, leads=lead)


def cmd_clean_vocal(args):
    """Guitar bleed out of a vocal take: the stem splitter keeps only the voice. The input is never changed;
    the result is written next to it (same channels and rate) only when complete."""
    import numpy as np
    import soundfile as sf

    from .separate import separate

    src, out = Path(args.input), Path(args.out)
    if not src.is_file():
        raise FileNotFoundError(f"Vocal take not found: {src}")
    info = sf.info(str(src))
    work = out.parent / f".work-clean-{os.getpid()}"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    t0 = time.perf_counter()
    try:
        progress("separating", 2, "Removing the guitar from the vocal")
        stems = separate(src, work / "stems", "fast", args.device, info.duration, progress)
        voc = next((s for s in stems if s["id"] == "vocals"), None)
        if voc is None:
            raise RuntimeError("The splitter returned no vocal stem.")
        y, sr = sf.read(voc["path"], dtype="float32", always_2d=True)
        if info.channels == 1 and y.shape[1] > 1:
            y = y.mean(axis=1, keepdims=True)  # back to mono like the take
        # for the report: how loud the guitar that was taken out is, next to the voice that was kept
        db = lambda a: 20 * np.log10(np.sqrt(np.mean(a**2)) + 1e-12)
        gtr = next((s for s in stems if s["id"] == "guitar"), None)
        g_db = db(sf.read(gtr["path"], dtype="float32", always_2d=True)[0]) if gtr else None
        tmp = out.with_suffix(".tmp.wav")
        sf.write(str(tmp), y, sr, subtype="FLOAT")
        os.replace(tmp, out)
        progress("done", 100, "Vocal cleaned")
        emit(type="result", path=str(out), guitar_vs_voice_db=None if g_db is None else round(float(g_db - db(y)), 1), elapsed_s=round(time.perf_counter() - t0, 1))
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main(argv=None):
    # The app kills this whole process tree on Cancel (child tools included), so tell it our process id first.
    emit(type="pid", pid=os.getpid())
    ap = argparse.ArgumentParser(prog="wsa")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("info")
    a = sub.add_parser("analyze")
    a.add_argument("--source", required=True)
    a.add_argument("--project", required=True)
    a.add_argument("--quality", default="balanced")
    a.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    a.add_argument("--no-stems", action="store_true", help="analysis only, skip separation")
    t = sub.add_parser("tts")
    t.add_argument("--out", required=True)
    t.add_argument("--text", action="append", required=True)
    t.add_argument("--rate", type=int, default=1)
    t.add_argument("--voice", default=None)
    c = sub.add_parser("clean-vocal")
    c.add_argument("--input", required=True)
    c.add_argument("--out", required=True)
    c.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    args = ap.parse_args(argv)
    try:
        {"info": cmd_info, "analyze": cmd_analyze, "tts": cmd_tts, "clean-vocal": cmd_clean_vocal}[args.cmd](args)
    except Exception as e:
        emit(type="error", message=f"{type(e).__name__}: {e}", trace=traceback.format_exc(limit=5))
        sys.exit(1)


if __name__ == "__main__":
    main()
