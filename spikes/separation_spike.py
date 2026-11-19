"""Separation feasibility spike.

Runs one or more separation models on a local song and records honest numbers:
run time, peak RAM, peak GPU memory, and how well the stems add back up to the mix.

Output goes to spikes/out/ (git-ignored). Nothing here uploads audio anywhere.

Usage:
    python separation_spike.py <input-audio> <model-file> [<model-file> ...] [--cpu] [--out DIR]
"""

from __future__ import annotations

import argparse
import json
import threading
import time
from pathlib import Path

import numpy as np
import psutil
import soundfile as sf


class ResourceSampler:
    """Samples process RAM and whole-GPU memory in the background."""

    def __init__(self, interval: float = 0.25):
        self.interval = interval
        self.peak_ram = 0
        self.peak_vram = 0
        self._stop = threading.Event()
        self._proc = psutil.Process()
        self._nvml = None
        try:
            import pynvml

            pynvml.nvmlInit()
            self._nvml = pynvml
            self._handle = pynvml.nvmlDeviceGetHandleByIndex(0)
            self._vram_base = pynvml.nvmlDeviceGetMemoryInfo(self._handle).used
        except Exception:
            self._nvml = None

    def _run(self):
        while not self._stop.is_set():
            self.peak_ram = max(self.peak_ram, self._proc.memory_info().rss)
            if self._nvml:
                used = self._nvml.nvmlDeviceGetMemoryInfo(self._handle).used
                self.peak_vram = max(self.peak_vram, used - self._vram_base)
            time.sleep(self.interval)

    def __enter__(self):
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._thread.join()


def load(path: Path) -> tuple[np.ndarray, int]:
    data, sr = sf.read(str(path), always_2d=True, dtype="float32")
    return data, sr


def residual_db(mix_path: Path, stem_paths: list[Path]) -> float | None:
    """Energy of (mix - sum(stems)) relative to the mix, in dB. Lower is better.

    Only meaningful when the stems are meant to add up to the full mix.
    """
    try:
        mix, sr = load(mix_path)
        total = None
        for p in stem_paths:
            s, s_sr = load(p)
            if s_sr != sr:
                return None
            n = min(len(mix), len(s))
            total = s[:n] if total is None else total[:n] + s[:n]
        if total is None:
            return None
        n = min(len(mix), len(total))
        err = mix[:n] - total[:n]
        return float(10 * np.log10((err**2).sum() / max((mix[:n] ** 2).sum(), 1e-12)))
    except Exception:
        return None


def stem_levels(stem_paths: list[Path]) -> dict[str, float]:
    """RMS level of each stem in dBFS, to spot empty or near-silent outputs."""
    out = {}
    for p in stem_paths:
        s, _ = load(p)
        rms = float(np.sqrt((s**2).mean()) + 1e-12)
        out[p.name] = round(20 * np.log10(rms), 1)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input", type=Path)
    ap.add_argument("models", nargs="+")
    ap.add_argument("--cpu", action="store_true", help="force CPU (hide the GPU)")
    ap.add_argument("--out", type=Path, default=Path(__file__).parent / "out")
    args = ap.parse_args()

    if args.cpu:
        import os

        os.environ["CUDA_VISIBLE_DEVICES"] = ""

    from audio_separator.separator import Separator

    results = []
    for model in args.models:
        tag = f"{Path(model).stem}{'_cpu' if args.cpu else ''}"
        out_dir = args.out / tag
        out_dir.mkdir(parents=True, exist_ok=True)
        sep = Separator(
            output_dir=str(out_dir),
            model_file_dir=str(Path(__file__).parents[1] / "models"),
            output_format="WAV",
        )
        entry = {"model": model, "device": "cpu" if args.cpu else "auto"}
        try:
            with ResourceSampler() as rs:
                t0 = time.perf_counter()
                sep.load_model(model_filename=model)
                t_load = time.perf_counter() - t0
                files = sep.separate(str(args.input))
                t_total = time.perf_counter() - t0
            stems = [out_dir / Path(f).name for f in files]
            entry.update(
                ok=True,
                load_s=round(t_load, 1),
                total_s=round(t_total, 1),
                peak_ram_gb=round(rs.peak_ram / 2**30, 2),
                peak_vram_gb=round(rs.peak_vram / 2**30, 2),
                stems=stem_levels(stems),
                residual_db=residual_db(args.input, stems),
            )
        except Exception as e:  # report failures honestly instead of hiding them
            entry.update(ok=False, error=f"{type(e).__name__}: {e}")
        print(json.dumps(entry, indent=2))
        results.append(entry)

    report = args.out / f"results{'_cpu' if args.cpu else ''}.json"
    existing = json.loads(report.read_text()) if report.exists() else []
    report.write_text(json.dumps(existing + results, indent=2))


if __name__ == "__main__":
    main()
