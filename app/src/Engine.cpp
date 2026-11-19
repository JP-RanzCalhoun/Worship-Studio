#include "Engine.h"

using namespace juce;

namespace
{
constexpr int maxChunk = 32768;   // largest source block we render at once
constexpr int fifoCapacity = 1 << 16;
constexpr int stretchChunk = 256;  // stretcher output frames per step

/** Short decaying sine blip used for the metronome. */
AudioBuffer<float> makeClick (double rate, float freq, float level, double lengthSec = 0.035)
{
    // Pure sine blips sat inside the strum band and could vanish in loud passages (sound-engineer review).
    // Add a 1 ms high-passed noise tick for a clear attack. Deterministic noise, so every click is identical.
    const int n = (int) (rate * lengthSec);
    AudioBuffer<float> b (1, n);
    auto* d = b.getWritePointer (0);
    Random rng (1234);
    float prev = 0.0f;
    for (int i = 0; i < n; ++i)
    {
        const double t = i / rate;
        const double env = std::exp (-t * 90.0) * std::min (1.0, i / (rate * 0.0008));
        const float white = rng.nextFloat() * 2.0f - 1.0f;
        const float hp = white - prev; // first-difference high-pass: bright, short
        prev = white;
        const float tick = (float) (std::exp (-t * 2500.0) * 0.6 * hp);
        const double tail = std::min (1.0, (n - 1 - i) / (rate * 0.002)); // 2 ms fade-out: no cut-off click
        d[i] = (float) (level * tail * (env * std::sin (MathConstants<double>::twoPi * freq * t) + tick));
    }
    return b;
}

bool looksVirtual (const String& name)
{
    for (auto* key : { "Virtual", "CABLE", "Stereo Mix", "Steam", "Maono AI", "NVIDIA Broadcast", "Iriun" })
        if (name.containsIgnoreCase (key))
            return true;
    return false;
}
} // namespace

Engine::Engine()
{
    formats.registerBasicFormats();
    voices.reserve (128);
    tunerWindow.resize (4096, 0.0f);

    // WASAPI shared mode, output only until the user picks an input (avoids opening mics silently).
    deviceManager.setCurrentAudioDeviceType ("Windows Audio", true);
    deviceManager.initialise (0, 2, nullptr, true);
    deviceManager.addAudioCallback (this);
}

Engine::~Engine()
{
    deviceManager.removeAudioCallback (this);
    deviceManager.closeAudioDevice();
}

// ============================================================================ devices

var Engine::describeDevices()
{
    DynamicObject::Ptr o = new DynamicObject();
    auto* type = deviceManager.getCurrentDeviceTypeObject();
    Array<var> ins, outs;
    if (type != nullptr)
    {
        type->scanForDevices();
        for (auto& n : type->getDeviceNames (true))
        {
            DynamicObject::Ptr d = new DynamicObject();
            d->setProperty ("name", n);
            d->setProperty ("virtual", looksVirtual (n));
            ins.add (var (d.get()));
        }
        for (auto& n : type->getDeviceNames (false))
            outs.add (n);
    }
    auto setup = deviceManager.getAudioDeviceSetup();
    o->setProperty ("type", deviceManager.getCurrentAudioDeviceType());
    o->setProperty ("inputs", ins);
    o->setProperty ("outputs", outs);
    o->setProperty ("input", setup.inputDeviceName);
    o->setProperty ("output", setup.outputDeviceName);
    if (auto* dev = deviceManager.getCurrentAudioDevice())
    {
        o->setProperty ("sampleRate", dev->getCurrentSampleRate());
        o->setProperty ("bufferSize", dev->getCurrentBufferSizeSamples());
        o->setProperty ("bitDepth", dev->getCurrentBitDepth());
        o->setProperty ("outputLatencyMs", 1000.0 * dev->getOutputLatencyInSamples() / dev->getCurrentSampleRate());
        o->setProperty ("inputLatencyMs", 1000.0 * dev->getInputLatencyInSamples() / dev->getCurrentSampleRate());
    }
    return var (o.get());
}

String Engine::applyDeviceSetup (const String& outputName, const String& inputName)
{
    auto setup = deviceManager.getAudioDeviceSetup();
    if (outputName.isNotEmpty())
        setup.outputDeviceName = outputName;
    setup.inputDeviceName = inputName;
    setup.useDefaultInputChannels = false;
    setup.inputChannels.clear();
    if (inputName.isNotEmpty())
        setup.inputChannels.setRange (0, 2, true);
    setup.useDefaultOutputChannels = true;
    return deviceManager.setAudioDeviceSetup (setup, true);
}

// ============================================================================ tracks

String Engine::loadTracks (const std::vector<std::tuple<String, String, File>>& list)
{
    std::vector<std::unique_ptr<Track>> loaded;
    double rate = 0;
    int64 length = 0;
    WavAudioFormat wav;
    for (auto& [id, name, file] : list)
    {
        auto t = std::make_unique<Track>();
        t->id = id;
        t->name = name;
        t->file = file;
        t->reader.reset (wav.createMemoryMappedReader (file));
        if (t->reader == nullptr || ! t->reader->mapEntireFile())
            return "Could not open " + file.getFullPathName();
        if (rate == 0)
            rate = t->reader->sampleRate;
        else if (! approximatelyEqual (rate, t->reader->sampleRate))
            return "Tracks have different sample rates: " + file.getFileName();
        // Touch every page now so the audio thread never waits for the disk.
        t->reader->touchSample (0);
        for (int64 s = 0; s < t->reader->lengthInSamples; s += 256)
            t->reader->touchSample (s);
        if (! id.startsWith ("take:"))
            length = std::max (length, t->reader->lengthInSamples);
        loaded.push_back (std::move (t));
    }

    playing = false;
    {
        const SpinLock::ScopedLockType sl (trackLock);
        std::swap (tracks, loaded);
        sourceRate = rate > 0 ? rate : 44100.0;
        lengthSamples = length;
        stretch.presetDefault (2, (float) sourceRate);
        srcBlock.setSize (2, maxChunk);
        trackScratch.setSize (2, maxChunk);
        fifo.setSize (2, fifoCapacity);
    }
    loopOn = false;
    fadeOutThenPause = false;
    pendingSeek = 0.0;
    return {};
}

void Engine::unload()
{
    playing = false;
    std::vector<std::unique_ptr<Track>> old;
    {
        const SpinLock::ScopedLockType sl (trackLock);
        std::swap (tracks, old);
        lengthSamples = 0;
    }
}

double Engine::getDurationSeconds() const { return lengthSamples / sourceRate; }

// The track list is only swapped on the message thread, so message-thread readers need no lock.
// (The audio thread try-locks trackLock and would output silence while it is held.)
void Engine::setTrackParams (const String& id, float gain, bool mute, bool solo)
{
    for (auto& t : tracks)
        if (t->id == id)
        {
            t->gain = gain;
            t->mute = mute;
            t->solo = solo;
        }
}

void Engine::setTrackOffset (const String& id, int64 samples)
{
    for (auto& t : tracks)
        if (t->id == id)
            t->offset = samples;
}

var Engine::getMeters()
{
    DynamicObject::Ptr o = new DynamicObject();
    for (auto& t : tracks)
        o->setProperty (t->id, t->peak.exchange (0.0f));
    o->setProperty ("__master", masterPeak.exchange (0.0f));
    o->setProperty ("__masterPre", masterPrePeak.exchange (0.0f));
    o->setProperty ("__limiterDb", limiterGrDb.exchange (0.0f));
    o->setProperty ("__clipped", masterClipped.exchange (false));
    return var (o.get());
}

// ============================================================================ transport

void Engine::play (double fromSec, double preRollSec)
{
    if (lengthSamples <= 0)
        return;
    fadeOutThenPause = false; // a pause request from before must not fade out this new start
    fadeInRequest = true;     // resuming without a seek also fades in (no pop)
    if (! std::isnan (fromSec))
    {
        pendingPreRoll = std::max (0.0, preRollSec);
        pendingSeek = fromSec;
    }
    playing = true;
}

void Engine::pause()
{
    // The audio thread fades the next block out, then stops (no hard cut).
    // With no running device there is no next block: stop at once.
    if (deviceManager.getCurrentAudioDevice() == nullptr || ! deviceManager.getCurrentAudioDevice()->isPlaying())
    {
        playing = false;
        fadeOutThenPause = false;
        return;
    }
    if (playing)
        fadeOutThenPause = true;
}

void Engine::seek (double seconds) { pendingSeek = seconds; }

bool Engine::getClockAnchor (int64& qpc100ns, double& songSec) const
{
    for (int tries = 0; tries < 8; ++tries)
    {
        const auto s1 = anchorSeq.load (std::memory_order_acquire);
        if ((s1 & 1u) != 0)
            continue;
        qpc100ns = anchorQpc.load (std::memory_order_relaxed);
        songSec = anchorSong.load (std::memory_order_relaxed);
        std::atomic_thread_fence (std::memory_order_acquire);
        if (anchorSeq.load (std::memory_order_relaxed) == s1)
            return qpc100ns != 0;
    }
    return false;
}

void Engine::writeClockAnchor (int64 qpc100ns, double songSec)
{
    // Audio thread only (single writer). Odd sequence = being written.
    anchorSeq.fetch_add (1, std::memory_order_relaxed);
    std::atomic_thread_fence (std::memory_order_release);
    anchorQpc.store (qpc100ns, std::memory_order_relaxed);
    anchorSong.store (songSec, std::memory_order_relaxed);
    anchorSeq.fetch_add (1, std::memory_order_release);
}

double Engine::getOutputLatencySeconds()
{
    auto* dev = deviceManager.getCurrentAudioDevice();
    const double rate = deviceRate.load();
    if (dev == nullptr || rate <= 0)
        return 0.0;
    return (dev->getOutputLatencyInSamples() + limiter.latencySamples() + outDucker.latencySamples()) / rate;
}

double Engine::getPositionSeconds() const
{
    const double pending = pendingSeek.load();
    if (! std::isnan (pending))
        return pending;
    const double held = heldSeekShared.load(); // a seek waiting for its fade-out block (one block)
    if (! std::isnan (held))
        return held;
    return audiblePosShared.load() / sourceRate;
}

void Engine::setLoop (bool enabled, double startSec, double endSec)
{
    loopStart = startSec;
    loopEnd = endSec;
    loopOn = enabled && endSec > startSec + 0.05;
}

void Engine::setTempoRatio (double ratio)
{
    tempoRatio = jlimit (0.5, 1.5, ratio);
    pendingSeek = getPositionSeconds(); // re-prime the stretcher at the current spot
}

void Engine::setPitchSemitones (double semis)
{
    pitchSemis = jlimit (-12.0, 12.0, semis);
    pendingSeek = getPositionSeconds();
}

void Engine::setClick (std::vector<TimedSound> events, bool enabled, float gain)
{
    std::sort (events.begin(), events.end(), [] (auto& a, auto& b) { return a.time < b.time; });
    {
        const SpinLock::ScopedLockType sl (soundLock);
        std::swap (clickEvents, events);
    }
    clickOn = enabled;
    clickGain = gain;
}

void Engine::setCues (std::vector<TimedSound> events, std::shared_ptr<SoundBank> bank, bool enabled, float gain)
{
    std::sort (events.begin(), events.end(), [] (auto& a, auto& b) { return a.time < b.time; });
    auto oldBank = bank;
    {
        const SpinLock::ScopedLockType sl (soundLock);
        std::swap (cueEvents, events);
        std::swap (cueBank, oldBank);
        voices.clear(); // voices may point into the old bank
    }
    cuesOn = enabled;
    cueGain = gain;
    // oldBank (previous bank) is released here, on the message thread.
}

// ============================================================================ tuner

void Engine::setTunerEnabled (bool enabled)
{
    tunerFifo.reset();
    tunerOn = enabled;
}

TunerReading Engine::readTuner()
{
    // Pull new samples into a sliding window.
    const int avail = tunerFifo.getNumReady();
    if (avail > 0)
    {
        const int n = std::min (avail, (int) tunerWindow.size());
        std::vector<float> tmp ((size_t) n);
        int s1, n1, s2, n2;
        tunerFifo.prepareToRead (avail, s1, n1, s2, n2);
        // keep only the newest n samples
        std::vector<float> all;
        all.reserve ((size_t) avail);
        all.insert (all.end(), tunerData.begin() + s1, tunerData.begin() + s1 + n1);
        all.insert (all.end(), tunerData.begin() + s2, tunerData.begin() + s2 + n2);
        tunerFifo.finishedRead (n1 + n2);
        std::copy (all.end() - n, all.end(), tmp.begin());
        std::move (tunerWindow.begin() + n, tunerWindow.end(), tunerWindow.begin());
        std::copy (tmp.begin(), tmp.end(), tunerWindow.end() - n);
    }

    // YIN pitch detection.
    TunerReading r;
    const double rate = deviceRate.load();
    const int W = 2048;
    const int tauMin = (int) (rate / 1200.0), tauMax = std::min ((int) (rate / 55.0), (int) tunerWindow.size() - W - 1);
    const float* x = tunerWindow.data() + (tunerWindow.size() - (size_t) (W + tauMax + 1));
    double energy = 0;
    for (int i = 0; i < W + tauMax; ++i)
        energy += x[i] * x[i];
    r.level = (float) std::sqrt (energy / (W + tauMax));
    if (r.level < 0.002f)
        return r;

    std::vector<float> d ((size_t) tauMax + 1, 0.0f);
    for (int tau = 1; tau <= tauMax; ++tau)
    {
        double sum = 0;
        for (int i = 0; i < W; ++i)
        {
            const float diff = x[i] - x[i + tau];
            sum += diff * diff;
        }
        d[(size_t) tau] = (float) sum;
    }
    // cumulative mean normalised difference
    double running = 0;
    d[0] = 1;
    for (int tau = 1; tau <= tauMax; ++tau)
    {
        running += d[(size_t) tau];
        d[(size_t) tau] = running > 0 ? (float) (d[(size_t) tau] * tau / running) : 1.0f;
    }
    int best = -1;
    for (int tau = tauMin; tau < tauMax; ++tau)
    {
        if (d[(size_t) tau] < 0.15f)
        {
            while (tau + 1 < tauMax && d[(size_t) tau + 1] < d[(size_t) tau])
                ++tau;
            best = tau;
            break;
        }
    }
    if (best < 0)
        return r;
    // parabolic interpolation
    const float a = d[(size_t) best - 1], b = d[(size_t) best], c = d[(size_t) best + 1];
    const float denom = a - 2 * b + c;
    const float shift = std::abs (denom) > 1e-9f ? 0.5f * (a - c) / denom : 0.0f;
    r.hz = (float) (rate / (best + shift));
    r.clarity = 1.0f - b;
    return r;
}

// ============================================================================ audio thread

void Engine::audioDeviceAboutToStart (AudioIODevice* dev)
{
    deviceRate = dev->getCurrentSampleRate();
    const double rate = deviceRate.load();
    voices.clear(); // voices point into clickBank; never keep them across a rebuild
    clickBank.sounds = { makeClick (rate, 1600.0f, 0.9f), makeClick (rate, 1000.0f, 0.7f), makeClick (rate, 800.0f, 0.35f, 0.02) };
    // Cue sounds were resampled for the previous device rate; the host rebuilds them (see MainComponent).
    deviceRateChanged = true;
    limiter.prepare (rate, -1.5f);      // music
    voiceLimiter.prepare (rate, -1.0f); // click and cues
    outDucker.prepare (rate, -1.0f);    // sum: only voices are turned down to fit (sample-peak -1 dBFS)
    fadeInLength = (int) (rate * 0.004);
    devTmp.setSize (2, dev->getCurrentBufferSizeSamples() * 4 + 1024);
    voiceTmp.setSize (2, devTmp.getNumSamples()); // after devTmp: the callback checks n against devTmp only
    monitorTmp.setSize (4, devTmp.getNumSamples()); // 0-1 = live inputs and the YouTube page, 2-3 = pad
    pad.prepare (rate);
    pendingSeek = getPositionSeconds();
}

// ---------------------------------------------------------------- live monitoring

void Engine::setMonitors (std::vector<std::shared_ptr<MonitorTap>> taps)
{
    {
        const SpinLock::ScopedLockType sl (monitorLock);
        std::swap (monitors, taps);
    }
    // The old taps (now in `taps`) are released here, on the message thread (never on the audio thread).
}

Engine::OutputMode Engine::getOutputMode()
{
    const auto t = deviceManager.getCurrentAudioDeviceType();
    return t.contains ("Exclusive") ? OutputMode::exclusive : t.contains ("Low Latency") ? OutputMode::lowLatency : OutputMode::normal;
}

String Engine::setOutputMode (OutputMode mode)
{
    const String want = mode == OutputMode::exclusive    ? "Windows Audio (Exclusive Mode)"
                        : mode == OutputMode::lowLatency ? "Windows Audio (Low Latency Mode)"
                                                         : "Windows Audio";
    if (deviceManager.getCurrentAudioDeviceType() == want)
        return {};
    const bool on = mode != OutputMode::normal;
    auto before = deviceManager.getAudioDeviceSetup();
    deviceManager.setCurrentAudioDeviceType (want, true);
    auto setup = deviceManager.getAudioDeviceSetup();
    setup.outputDeviceName = before.outputDeviceName;
    setup.inputDeviceName = before.inputDeviceName;
    setup.inputChannels = before.inputChannels;
    setup.useDefaultInputChannels = before.useDefaultInputChannels;
    setup.useDefaultOutputChannels = true;
    setup.bufferSize = 0;
    auto e = deviceManager.setAudioDeviceSetup (setup, true);
    if (on && e.isEmpty())
        if (auto* dev = deviceManager.getCurrentAudioDevice())
        {
            // The smallest buffer the driver offers, but not under 3 ms (the song's time-stretch needs some room). On the
            // PD200X, 5 ms blocks gave no less delay than shared mode (2026-11-17), so the floor stays at 3 ms.
            const double rate = dev->getCurrentSampleRate();
            int best = dev->getCurrentBufferSizeSamples();
            for (auto s : dev->getAvailableBufferSizes())
                if (s >= rate * 0.003 && s < best)
                    best = s;
            if (best < dev->getCurrentBufferSizeSamples())
            {
                setup = deviceManager.getAudioDeviceSetup();
                setup.bufferSize = best;
                e = deviceManager.setAudioDeviceSetup (setup, true);
            }
        }
    if (e.isNotEmpty() && on)
    {
        // Not supported here: back to the normal mode with the same device.
        deviceManager.setCurrentAudioDeviceType ("Windows Audio", true);
        auto s = deviceManager.getAudioDeviceSetup();
        s.outputDeviceName = before.outputDeviceName;
        s.inputDeviceName = before.inputDeviceName;
        s.inputChannels = before.inputChannels;
        deviceManager.setAudioDeviceSetup (s, true);
    }
    return e;
}

double Engine::getDeviceOutputLatencySeconds()
{
    auto* dev = deviceManager.getCurrentAudioDevice();
    const double rate = deviceRate.load();
    return dev != nullptr && rate > 0 ? dev->getOutputLatencyInSamples() / rate : 0.0;
}

void Engine::addMonitor (float* const* out, int numOut, int n)
{
    if (numOut == 0 || out[0] == nullptr || n > monitorTmp.getNumSamples())
        return;
    const double rate = deviceRate.load();
    float* m = monitorTmp.getWritePointer (0);
    float* mr = monitorTmp.getWritePointer (1);
    float* pl = monitorTmp.getWritePointer (2);
    float* pr = monitorTmp.getWritePointer (3);
    FloatVectorOperations::clear (m, n);
    FloatVectorOperations::clear (mr, n);
    FloatVectorOperations::clear (pl, n);
    FloatVectorOperations::clear (pr, n);
    bool any = false;

    {
        const SpinLock::ScopedTryLockType tl (monitorLock);
        if (tl.isLocked())
            for (auto& t : monitors)
            {
                t->pullAdd (m, mr, n, rate);
                any = true;
            }
    }

    // Ambient pad (made in code), on its own clock: plays with or without the song.
    if (pad.isOn() || pad.isSounding())
    {
        pad.renderAdd (pl, pr, n);
        // Ducking: while the live guitar/vocal plays, the pad dips (up to 6 dB) and swells back when it stops,
        // so it stays behind the player (JP, 2026-11-17). Fast down (~30 ms), slow up (~0.6 s).
        float peak = 0;
        for (int i = 0; i < n; ++i)
            peak = std::max (peak, std::max (std::abs (m[i]), std::abs (mr[i])));
        const float upCoef = (float) std::exp (-n / (rate * 0.6));
        duckEnv = peak > duckEnv ? duckEnv + (peak - duckEnv) * (float) (1.0 - std::exp (-n / (rate * 0.03))) : duckEnv * upCoef;
        // -40 dBFS (quiet strum) starts ducking, -14 dBFS (normal playing) gives the full 6 dB
        const float level = juce::Decibels::gainToDecibels (duckEnv, -100.0f);
        const float duckDb = -6.0f * juce::jlimit (0.0f, 1.0f, (level + 40.0f) / 26.0f);
        const float target = juce::Decibels::decibelsToGain (duckDb);
        const float start = padDuck;
        padDuck += (target - padDuck) * (float) (1.0 - std::exp (-n / (rate * 0.05)));
        for (int i = 0; i < n; ++i) // ramp within the block: no zipper noise
        {
            const float g = start + (padDuck - start) * (float) (i + 1) / (float) n;
            pl[i] *= g;
            pr[i] *= g;
        }
        any = true;
    }

    if (! any)
        return;
    // The monitor skips the limiters (no look-ahead delay): a soft ceiling keeps the sum under -1 dBFS.
    auto soft = [] (float x) {
        const float a = std::abs (x);
        if (a <= 0.85f) // the song is limited to -1.5 dBFS (0.84): it passes untouched
            return x;
        const float y = 0.85f + 0.04f * std::tanh ((a - 0.85f) / 0.04f); // ceiling 0.89 = -1 dBFS
        return x < 0 ? -y : y;
    };
    for (int c = 0; c < juce::jmin (numOut, 2); ++c)
        if (out[c] != nullptr)
        {
            const float* padCh = c == 0 ? pl : pr;
            const float* monCh = c == 0 ? m : mr;
            for (int i = 0; i < n; ++i)
                out[c][i] = soft (out[c][i] + monCh[i] + padCh[i]);
        }
    if (numOut == 1 && out[0] != nullptr) // mono output: the right sides too
        for (int i = 0; i < n; ++i)
            out[0][i] = soft (out[0][i] + mr[i] + pr[i]);
}

void Engine::audioDeviceStopped() {}

void Engine::resetDsp (bool keepVoices)
{
    // The device resampler (windowed sinc) outputs its input L samples late and starts from a silent history.
    // Reading the source L (post-stretch) samples ahead makes the music heard match audiblePos exactly, so the
    // click, the display and recorded takes all line up with the music (L = 100 samples, about 2 ms).
    readPos += (int64) std::llround (WindowedSincInterpolator::getBaseLatency() * tempoRatio.load());
    stretch.reset();
    stretchAccum = 0;
    fifoCount = 0;
    for (auto& r : resamplers)
        r.reset();
    if (! keepVoices)
        voices.clear(); // a loop wrap lets the click on the loop end ring out
    stretchActive = ! approximatelyEqual (tempoRatio.load(), 1.0) || ! approximatelyEqual (pitchSemis.load(), 0.0);
    if (stretchActive)
    {
        stretch.setTransposeSemitones ((float) pitchSemis.load());
        // Prime the stretcher so its output starts exactly at readPos.
        const float tempo = (float) tempoRatio.load();
        const int primeLen = std::min (maxChunk, stretch.outputSeekLength (tempo));
        renderSource (srcBlock.getWritePointer (0), srcBlock.getWritePointer (1), primeLen);
        stretch.outputSeek (srcBlock.getArrayOfReadPointers(), primeLen);
        readPos += primeLen;
    }
}

void Engine::renderSource (float* l, float* r, int n)
{
    FloatVectorOperations::clear (l, n);
    FloatVectorOperations::clear (r, n);
    bool anySolo = false;
    for (auto& t : tracks)
        anySolo = anySolo || t->solo.load();

    // Part of [readPos, readPos + n) that lies inside the file.
    const int64 start = std::max<int64> (readPos, 0);
    const int64 end = std::min<int64> (readPos + n, lengthSamples);
    if (end <= start)
        return;
    const int offset = (int) (start - readPos);
    const int count = (int) (end - start);

    float* dest[2] = { trackScratch.getWritePointer (0), trackScratch.getWritePointer (1) };
    for (auto& t : tracks)
    {
        const bool audible = anySolo ? t->solo.load() : ! t->mute.load();
        const float target = audible ? t->gain.load() : 0.0f;
        const float from = t->appliedGain;
        if ((target == 0.0f && from == 0.0f) || t->reader == nullptr)
            continue;
        // The file's own sample range for [start, end) of the song (a take may start before 0 or after it).
        const int64 off = t->offset.load();
        const int64 fileStart = std::max<int64> (start - off, 0);
        const int64 fileEnd = std::min<int64> (end - off, t->reader->lengthInSamples);
        const int c = (int) std::max<int64> (0, fileEnd - fileStart);
        if (c <= 0)
            continue;
        const int at = offset + (int) (fileStart + off - start); // where in this block the file's audio lands
        t->reader->read (dest, 2, fileStart, c);
        if (t->reader->numChannels == 1)
            FloatVectorOperations::copy (dest[1], dest[0], c);
        // Ramp from the last gain to the new one across this chunk (about 6 ms): no zipper noise, no mute clicks.
        const float g = target;
        if (from == target)
        {
            FloatVectorOperations::addWithMultiply (l + at, dest[0], g, c);
            FloatVectorOperations::addWithMultiply (r + at, dest[1], g, c);
        }
        else
        {
            const float step = (target - from) / (float) c;
            for (int i = 0; i < c; ++i)
            {
                const float gi = from + step * (float) (i + 1);
                l[at + i] += dest[0][i] * gi;
                r[at + i] += dest[1][i] * gi;
            }
            t->appliedGain = target;
        }
        const auto rl = FloatVectorOperations::findMinAndMax (dest[0], c);
        const auto rr = FloatVectorOperations::findMinAndMax (dest[1], c);
        const float pk = g * std::max ({ std::abs (rl.getStart()), std::abs (rl.getEnd()), std::abs (rr.getStart()), std::abs (rr.getEnd()) });
        if (pk > t->peak.load())
            t->peak = pk;
    }
}

void Engine::fillResampleFifo (int needed)
{
    const float tempo = (float) tempoRatio.load();
    while (fifoCount < needed && fifoCount + stretchChunk <= fifoCapacity)
    {
        float* out[2] = { fifo.getWritePointer (0, fifoCount), fifo.getWritePointer (1, fifoCount) };
        if (stretchActive)
        {
            stretchAccum += stretchChunk * (double) tempo;
            const int in = (int) stretchAccum;
            stretchAccum -= in;
            renderSource (srcBlock.getWritePointer (0), srcBlock.getWritePointer (1), in);
            readPos += in;
            stretch.process (srcBlock.getArrayOfReadPointers(), in, out, stretchChunk);
        }
        else
        {
            renderSource (out[0], out[1], stretchChunk);
            readPos += stretchChunk;
        }
        fifoCount += stretchChunk;
    }
}

void Engine::addVoices (double t0, double t1, double songPerSample, int blockOffset, bool forceClick)
{
    auto schedule = [&] (const std::vector<TimedSound>& events, const std::vector<AudioBuffer<float>>& bank, float busGain) {
        auto it = std::lower_bound (events.begin(), events.end(), t0, [] (const TimedSound& e, double t) { return e.time < t; });
        for (; it != events.end() && it->time < t1; ++it)
            if (isPositiveAndBelow (it->sampleIndex, (int) bank.size()) && voices.size() < voices.capacity())
                voices.push_back ({ &bank[(size_t) it->sampleIndex], 0, it->gain * busGain,
                                    blockOffset + (int) ((it->time - t0) / songPerSample) });
    };
    if (songPerSample <= 0 || t1 <= t0)
        return;
    if (clickOn || forceClick)
        schedule (clickEvents, clickBank.sounds, clickGain);
    if (cuesOn && cueBank != nullptr)
        schedule (cueEvents, cueBank->sounds, cueGain);
}

void Engine::renderVoices (float* l, float* r, int n)
{
    for (auto& v : voices)
    {
        const int startOut = std::min (v.delay, n);
        const int len = std::min (n - startOut, v.buf->getNumSamples() - v.pos);
        if (len > 0)
        {
            const float* src = v.buf->getReadPointer (0, v.pos);
            FloatVectorOperations::addWithMultiply (l + startOut, src, v.gain, len);
            FloatVectorOperations::addWithMultiply (r + startOut, src, v.gain, len);
            v.pos += len;
        }
        v.delay = std::max (0, v.delay - n);
    }
    voices.erase (std::remove_if (voices.begin(), voices.end(), [] (const Voice& v) { return v.pos >= v.buf->getNumSamples(); }), voices.end());
}

void Engine::audioDeviceIOCallbackWithContext (const float* const* in, int numIn, float* const* out, int numOut,
                                               int n, const AudioIODeviceCallbackContext&)
{
    processBlock (in, numIn, out, numOut, n);
    addMonitor (out, numOut, n);
}

void Engine::processBlock (const float* const* in, int numIn, float* const* out, int numOut, int n)
{
    for (int c = 0; c < numOut; ++c)
        if (out[c] != nullptr)
            FloatVectorOperations::clear (out[c], n);

    // Tuner input: mono sum of the selected input's channels.
    if (tunerOn && numIn > 0)
    {
        int s1, n1, s2, n2;
        tunerFifo.prepareToWrite (n, s1, n1, s2, n2);
        auto write = [&] (int dst, int count, int srcOff) {
            for (int i = 0; i < count; ++i)
            {
                float s = 0;
                for (int c = 0; c < numIn; ++c)
                    if (in[c] != nullptr)
                        s += in[c][srcOff + i];
                tunerData[(size_t) (dst + i)] = s / (float) numIn;
            }
        };
        write (s1, n1, 0);
        write (s2, n2, n1);
        tunerFifo.finishedWrite (n1 + n2);
    }

    const SpinLock::ScopedTryLockType tl (trackLock);
    const SpinLock::ScopedTryLockType sl2 (soundLock);
    if (! tl.isLocked() || ! sl2.isLocked() || tracks.empty() || numOut == 0 || n > devTmp.getNumSamples())
        return;

    const double rs = sourceRate, rd = deviceRate.load();
    const double tempo = tempoRatio.load();
    const double songPerSample = tempo / rd;
    limiter.bypass = voiceLimiter.bypass = outDucker.bypass = ! limiterOn.load();
    float* l = devTmp.getWritePointer (0);
    float* r = devTmp.getWritePointer (1);

    // ---- seeks. While playing, a seek first plays one block that fades out, then jumps (no hard cut).
    double seekTo = pendingSeek.exchange (std::numeric_limits<double>::quiet_NaN());
    bool fadeForSeek = false;
    if (! std::isnan (heldSeek))
    {
        if (std::isnan (seekTo))
            seekTo = heldSeek; // the fade-out block has played: jump now (a newer seek wins)
        heldSeek = std::numeric_limits<double>::quiet_NaN();
    }
    else if (! std::isnan (seekTo) && playing && preRollRemaining == 0 && audiblePos < (double) lengthSamples)
    {
        heldSeek = seekTo;
        heldSeekShared = seekTo;
        seekTo = std::numeric_limits<double>::quiet_NaN();
        fadeForSeek = true;
    }
    if (! std::isnan (seekTo))
    {
        double preRollSec = pendingPreRoll.exchange (0.0);
        // A seek to a negative time (e.g. tempo changed during a count-in) continues the count-in.
        if (seekTo < 0)
        {
            preRollSec = std::max (preRollSec, -seekTo);
            seekTo = 0;
        }
        readPos = (int64) std::llround (seekTo * rs);
        audiblePos = (double) readPos;
        resetDsp (false);
        // Pre-roll length is song time; at a slower tempo it lasts longer in real time.
        preRollRemaining = (int64) (preRollSec * rd / tempo);
        fadeInRemaining = fadeInLength;
        audiblePosShared = audiblePos - preRollRemaining * songPerSample * rs;
        heldSeekShared = std::numeric_limits<double>::quiet_NaN();
    }

    // End of the song: stop and flush the limiter tail in this same block (no silent block before the tail).
    if (playing && audiblePos >= (double) lengthSamples && preRollRemaining == 0)
    {
        playing = false;
        tailRemaining = 2 * limiter.latencySamples() + n;
    }
    if (! playing)
    {
        if (anchorQpc.load (std::memory_order_relaxed) != 0)
            writeClockAnchor (0, 0.0); // stopped: no song clock
        if (preRollRemaining > 0)
        {
            preRollRemaining = 0;
            voices.clear();
            audiblePosShared = audiblePos;
        }
        // After a pause or the song end, push silence through the limiters until their delay has drained
        // (no stale tail later), and let a click or spoken cue still sounding at the song end finish.
        if (tailRemaining > 0 || ! voices.empty())
        {
            FloatVectorOperations::clear (l, n);
            FloatVectorOperations::clear (r, n);
            outputStage (l, r, n, false);
            tailRemaining = std::max (0, tailRemaining - n);
            if (! masterMuted)
            {
                FloatVectorOperations::copy (out[0], l, n);
                if (numOut > 1 && out[1] != nullptr)
                    FloatVectorOperations::copy (out[1], r, n);
            }
        }
        return;
    }

    FloatVectorOperations::clear (l, n);
    FloatVectorOperations::clear (r, n);

    // ---- song clock for recording: when this block starts, the song is at audiblePos. During a count-in the
    // song does not move, so there is no valid pair (an old one would line a take up from the wrong time).
    if (preRollRemaining == 0)
    {
        const int64 ticks = Time::getHighResolutionTicks(), freq = Time::getHighResolutionTicksPerSecond();
        writeClockAnchor ((ticks / freq) * 10'000'000 + (ticks % freq) * 10'000'000 / freq, audiblePos / rs);
    }
    else
        writeClockAnchor (0, 0.0);

    // ---- count-in: clicks (and spoken counts) on the song grid before the start point, song audio silent.
    int offset = 0;
    if (preRollRemaining > 0)
    {
        offset = (int) std::min<int64> (n, preRollRemaining);
        const double t0 = audiblePos / rs - preRollRemaining * songPerSample;
        addVoices (t0, t0 + offset * songPerSample, songPerSample, 0, true);
        preRollRemaining -= offset;
    }
    if (fadeInRequest.exchange (false) && fadeInRemaining == 0)
        fadeInRemaining = fadeInLength;

    // ---- song audio. A loop wraps at the exact sample of its end, not at the next block.
    const int m = n - offset;
    for (int done = 0; done < m;)
    {
        int chunk = m - done;
        bool wrapAfter = false;
        if (loopOn && preRollRemaining == 0)
        {
            const double toEnd = (loopEnd.load() - audiblePos / rs) / songPerSample;
            if (toEnd < 0.5)
            {
                wrapLoop();
                continue;
            }
            if (toEnd < chunk)
            {
                chunk = std::max (1, (int) std::ceil (toEnd));
                wrapAfter = true;
            }
        }
        renderSongChunk (l + offset + done, r + offset + done, chunk, offset + done);
        done += chunk;
        if (wrapAfter)
            wrapLoop();
    }
    audiblePosShared = audiblePos - preRollRemaining * songPerSample * rs;

    const bool stopAfterBlock = fadeOutThenPause.exchange (false);
    outputStage (l, r, n, stopAfterBlock || fadeForSeek);
    if (stopAfterBlock)
    {
        playing = false;
        voices.clear(); // faded out in this block; the tail flush must not play them on unfaded
        tailRemaining = 2 * limiter.latencySamples() + n;
    }

    if (masterMuted)
        return;
    FloatVectorOperations::copy (out[0], l, n);
    if (numOut > 1 && out[1] != nullptr)
        FloatVectorOperations::copy (out[1], r, n);
}

void Engine::wrapLoop()
{
    readPos = (int64) std::llround (loopStart.load() * sourceRate);
    audiblePos = (double) readPos;
    resetDsp (true); // the click on the loop start keeps ringing; nothing past the end was scheduled
    fadeInRemaining = fadeInLength;
}

void Engine::renderSongChunk (float* l, float* r, int count, int blockOffset)
{
    const double rs = sourceRate, rd = deviceRate.load(), tempo = tempoRatio.load();
    const double ratio = rs / rd, songPerSample = tempo / rd;

    // Resample the post-stretch source-rate audio to the device rate.
    fillResampleFifo ((int) std::ceil (count * ratio) + 8);
    const int used = resamplers[0].process (ratio, fifo.getReadPointer (0), l, count, fifoCount, 0);
    resamplers[1].process (ratio, fifo.getReadPointer (1), r, count, fifoCount, 0);
    for (int c = 0; c < 2; ++c)
        std::memmove (fifo.getWritePointer (c), fifo.getReadPointer (c, used), sizeof (float) * (size_t) (fifoCount - used));
    fifoCount -= used;

    // Click and cues follow the song timeline but are never stretched or pitch-shifted.
    // In a loop, nothing at or after the loop end is scheduled (the loop start's click plays instead).
    const double t0 = audiblePos / rs;
    double t1 = t0 + count * songPerSample;
    if (loopOn)
        t1 = std::min (t1, loopEnd.load());
    addVoices (t0, t1, songPerSample, blockOffset, false);

    // Fade-in after a jump.
    for (int i = 0; i < count && fadeInRemaining > 0; ++i, --fadeInRemaining)
    {
        const float g = 1.0f - (float) fadeInRemaining / (float) fadeInLength;
        l[i] *= g;
        r[i] *= g;
    }
    // Fade-out into a loop end.
    if (loopOn)
    {
        const double fadeSec = fadeInLength / rd * tempo, end = loopEnd.load();
        for (int i = 0; i < count; ++i)
        {
            const double t = t0 + i * songPerSample;
            if (t > end - fadeSec)
            {
                const float g = (float) jlimit (0.0, 1.0, (end - t) / fadeSec);
                l[i] *= g;
                r[i] *= g;
            }
        }
    }
    audiblePos += count * ratio * tempo;
}

void Engine::outputStage (float* l, float* r, int n, bool fadeOut)
{
    // Music bus: master gain.
    const float mg = masterGain.load();
    FloatVectorOperations::multiply (l, mg, n);
    FloatVectorOperations::multiply (r, mg, n);
    const float pre = std::max ({ FloatVectorOperations::findMaximum (l, n), -FloatVectorOperations::findMinimum (l, n),
                                  FloatVectorOperations::findMaximum (r, n), -FloatVectorOperations::findMinimum (r, n) });

    // Click and cue bus.
    float* vl = voiceTmp.getWritePointer (0);
    float* vr = voiceTmp.getWritePointer (1);
    FloatVectorOperations::clear (vl, n);
    FloatVectorOperations::clear (vr, n);
    renderVoices (vl, vr, n);

    // A pause or seek fades music AND voices out over this block. The fade is applied BEFORE the limiters:
    // their look-ahead delay then only holds faded audio, so the next block cannot replay an unfaded tail.
    if (fadeOut)
    {
        const int len = std::min (n, fadeInLength);
        for (int i = 0; i < n; ++i)
        {
            const float g = i < len ? 1.0f - (float) i / (float) len : 0.0f;
            l[i] *= g;
            r[i] *= g;
            vl[i] *= g;
            vr[i] *= g;
        }
    }

    // Music: safety limiter at -1.5 dBFS. Voices: own limiter, same delay.
    limiter.process (l, r, n);
    voiceLimiter.process (vl, vr, n);

    // Sum: the click/cue bus is turned down first (at most 6 dB); only beyond that does the music dip briefly.
    outDucker.process (l, r, vl, vr, n);

    const float post = std::max ({ FloatVectorOperations::findMaximum (l, n), -FloatVectorOperations::findMinimum (l, n),
                                   FloatVectorOperations::findMaximum (r, n), -FloatVectorOperations::findMinimum (r, n) });
    if (pre > masterPrePeak.load())
        masterPrePeak = pre;
    if (post > masterPeak.load())
        masterPeak = post;
    if (post > 1.0f)
        masterClipped = true;
    const float gr = limiter.takeGainReductionDb();
    voiceLimiter.takeGainReductionDb();
    outDucker.takeDuckDb();
    if (gr < limiterGrDb.load())
        limiterGrDb = gr;
}
