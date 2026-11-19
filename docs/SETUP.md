# Setup (Windows)

## Requirements
- Windows 10/11, x64. Mid-range laptop is enough for playback; an NVIDIA GPU makes stem separation ~10x faster.
- Visual Studio 2022 Build Tools (C++ workload), CMake ≥ 3.24, Node.js ≥ 20, Python 3.12, Git.
- Microsoft Edge WebView2 Runtime (already on Windows 11).

## 1. Third-party sources (not committed)
```
mkdir third_party && cd third_party
git clone --depth 1 --branch 9.0.3 https://github.com/juce-framework/JUCE.git
git clone --depth 1 --branch 1.4.0 https://github.com/Signalsmith-Audio/signalsmith-stretch.git
git clone --depth 1 --branch 0.6.4 https://github.com/Signalsmith-Audio/linear.git signalsmith-linear
```
WebView2 SDK: download the NuGet package `Microsoft.Web.WebView2` 1.0.3485.44 and unzip into
`third_party/webview2/Microsoft.Web.WebView2.1.0.3485.44/`.

## 2. Screens (UI)
```
cd ui
npm install
npm run build      # outputs ui/dist, loaded by the app
npm test           # theory + timeline unit tests
```

## 3. App
```
cd app
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
```
Run: `app\build\WorshipStudio_artefacts\Release\Worship Studio.exe`

UI development with hot reload: run `npm run dev` in `ui`, then start the app with `WSA_UI_URL=http://localhost:5173`.

## 4. Python analysis tools
```
cd analysis
python -m venv .venv
.venv\Scripts\python -m pip install torch==2.11.0 torchaudio==2.11.0 torchvision==0.26.0 --index-url https://download.pytorch.org/whl/cu128
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -c "import torch; print(torch.cuda.is_available())"
```
Use `/whl/cpu` instead of `/whl/cu128` on a PC without an NVIDIA GPU.

Model weights download on first use into `models/` (git-ignored). The beat tracker weights come from
`cloud.cp.jku.at`; if that server is unreachable the app falls back to a simpler beat tracker and says so.
You can place `beat_this-final0.ckpt` in `models/` by hand.

## Where your data lives
`Documents\WorshipStudio\Songs\<song>\` — original file, decoded mix, stems, analysis, your chart and cues.
Nothing is uploaded.

## Audio devices
- Output: pick in **Setup**. Windows audio (WASAPI shared mode), 48 kHz.
- Tuner input: pick **Headset Microphone (Maonocaster E2 Gen2)** for the guitar. Devices marked "virtual"
  (Maono AI Microphone, VB-Cable, Stereo Mix, Steam, Iriun) are software devices — do not use them as the dry guitar.
- Recording (E2 + PD200X as separate dry tracks): open a song → **Record**. Hear yourself through the headphone
  jack of the E2 or PD200X (the app never plays the inputs back). Turn **off** Windows/Maono "AI noise
  cancellation" and sound enhancements for both inputs: on some PCs they pass only speech, so a guitar take is silent.
  Latency calibration is not built yet, so takes can sit a few ms to ~170 ms late depending on the output device.
- Takes are saved in `<song>\takes\take-NNN\` (raw recordings + lined-up files + take.json).
