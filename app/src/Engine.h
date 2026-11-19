#pragma once

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include "signalsmith-stretch.h"
#include "Limiter.h"
#include "MonitorTap.h"
#include "PadSynth.h"

/** One playable track: the full mix or a separated stem. Read from a memory-mapped WAV. */
struct Track
{
    juce::String id, name;
    juce::File file;
    std::unique_ptr<juce::MemoryMappedAudioFormatReader> reader;
    std::atomic<float> gain { 1.0f };
    std::atomic<bool> mute { false }, solo { false };
    float appliedGain = 0.0f; // audio thread only: gain ramps from here, so fader moves and mutes never click
    std::atomic<juce::int64> offset { 0 }; // song sample where this file's sample 0 plays (takes; stems are 0)
    std::atomic<float> peak { 0.0f }; // meter, reset by the UI poller
};

/** A one-shot sound placed on the song timeline (a click or a spoken cue word). */
struct TimedSound
{
    double time = 0;        // song seconds
    int sampleIndex = 0;    // index into the sound bank
    float gain = 1.0f;
};

struct SoundBank
{
    std::vector<juce::AudioBuffer<float>> sounds; // mono, device rate
};

/** Pitch result for the tuner. */
struct TunerReading
{
    float hz = 0, clarity = 0, level = 0;
};

/**
 * Real-time playback engine.
 *
 * Signal path (per device block):
 *   tracks (source rate) -> gain/mute/solo sum -> [time/pitch stretch] -> resample to device rate
 *   -> + click bus + cue bus (scheduled on the song timeline, never stretched)
 *   -> output
 * Input (tuner only in this milestone) is analysed off the audio thread.
 */
class Engine : private juce::AudioIODeviceCallback
{
public:
    Engine();
    ~Engine() override;

    // ----- device -----
    juce::AudioDeviceManager& getDeviceManager() { return deviceManager; }
    juce::var describeDevices();
    juce::String applyDeviceSetup (const juce::String& outputName, const juce::String& inputName);

    // ----- song -----
    /** Loads tracks (all must share one sample rate). Stops playback. Returns an error or empty. */
    juce::String loadTracks (const std::vector<std::tuple<juce::String, juce::String, juce::File>>& tracks);
    void unload();
    double getDurationSeconds() const;
    double getSourceRate() const { return sourceRate; }

    void setTrackParams (const juce::String& id, float gain, bool mute, bool solo);
    /** A take starts at a song time other than 0: its sample 0 plays at song sample `samples` (may be negative). */
    void setTrackOffset (const juce::String& id, juce::int64 samples);
    juce::var getMeters();

    // ----- transport -----
    /** Starts playback. With fromSec, seeks first; preRollSec of count-in plays before the song audio. */
    void play (double fromSec = std::numeric_limits<double>::quiet_NaN(), double preRollSec = 0);
    void pause();
    bool isPlaying() const { return playing.load(); }
    double getTempo() const { return tempoRatio.load(); }
    /** Latest (QPC 100 ns, song seconds) pair from a playing block (no count-in). False if no block has played yet. */
    bool getClockAnchor (juce::int64& qpc100ns, double& songSec) const;
    /** Time from the audio callback to the speaker: device latency + the output stage's look-ahead. */
    double getOutputLatencySeconds();
    /** Seeks; negative times are allowed (pre-roll for a count-in). */
    void seek (double seconds);
    double getPositionSeconds() const;
    void setLoop (bool enabled, double startSec, double endSec);
    void setTempoRatio (double ratio);
    void setPitchSemitones (double semis);

    // ----- click and cues -----
    void setClick (std::vector<TimedSound> events, bool enabled, float gain);
    void setCues (std::vector<TimedSound> events, std::shared_ptr<SoundBank> bank, bool enabled, float gain);
    void setMasterMuted (bool muted) { masterMuted = muted; }
    void setMasterGain (float g) { masterGain = g; }
    void setLimiterOn (bool on) { limiterOn = on; }

    // ----- tuner -----
    void setTunerEnabled (bool enabled);
    TunerReading readTuner();

    double getDeviceRate() const { return deviceRate.load(); }
    /** True once after the device (re)started; the host then rebuilds rate-dependent cue sounds. */
    bool consumeDeviceRateChanged() { return deviceRateChanged.exchange (false); }
    void setCueGain (float g) { cueGain = g; }
    void setCuesEnabled (bool on) { cuesOn = on; }

    // ----- ambient pad (made in code; plays with or without the song) -----
    PadSynth& getPad() { return pad; }

    // ----- live monitoring (inputs, possibly from other devices, mixed into this output) -----
    /** The inputs heard live (empty = off). Each tap is filled by an InputTrack and has its own level. */
    void setMonitors (std::vector<std::shared_ptr<MonitorTap>> taps);
    /**
     * Output mode, keeping the same output device. normal = Windows shared mode (10 ms blocks);
     * lowLatency = shared with Windows' smallest period (where the driver allows); exclusive = the app owns the
     * device with small blocks (lowest delay; nothing else can play through that device meanwhile).
     * If a mode is not supported, falls back to normal and returns the error.
     */
    enum class OutputMode { normal, lowLatency, exclusive };
    juce::String setOutputMode (OutputMode mode);
    OutputMode getOutputMode();
    /** Device output latency alone (no limiter look-ahead): the monitor skips the limiters. */
    double getDeviceOutputLatencySeconds();


private:
    void audioDeviceIOCallbackWithContext (const float* const* in, int numIn, float* const* out, int numOut,
                                           int numSamples, const juce::AudioIODeviceCallbackContext&) override;
    /** The song, click and cue output (everything except the live monitor). */
    void processBlock (const float* const* in, int numIn, float* const* out, int numOut, int numSamples);
    void addMonitor (float* const* out, int numOut, int numSamples);
    void audioDeviceAboutToStart (juce::AudioIODevice*) override;
    void audioDeviceStopped() override;

    void renderSource (float* l, float* r, int numSamples); // source-rate mix at readPos
    void fillResampleFifo (int neededFrames);
    void addVoices (double t0, double t1, double songPerSample, int blockOffset, bool forceClick);
    void renderSongChunk (float* l, float* r, int count, int blockOffset);
    void wrapLoop();
    void outputStage (float* l, float* r, int n, bool fadeOut);
    void renderVoices (float* l, float* r, int numSamples);
    void resetDsp (bool keepVoices = false);

    juce::AudioDeviceManager deviceManager;
    juce::AudioFormatManager formats;

    // Tracks are swapped under trackLock; the audio thread uses a try-lock and outputs silence if busy.
    juce::SpinLock trackLock;
    std::vector<std::unique_ptr<Track>> tracks;
    double sourceRate = 44100.0;
    juce::int64 lengthSamples = 0;

    std::atomic<bool> playing { false }, masterMuted { false };
    std::atomic<double> deviceRate { 48000.0 };
    std::atomic<double> tempoRatio { 1.0 }, pitchSemis { 0.0 };
    std::atomic<bool> loopOn { false };
    std::atomic<double> loopStart { 0 }, loopEnd { 0 };
    std::atomic<double> pendingSeek { std::numeric_limits<double>::quiet_NaN() };
    std::atomic<double> pendingPreRoll { 0 };
    juce::int64 preRollRemaining = 0; // device samples of count-in left

    // Audio-thread state.
    juce::int64 readPos = 0;          // next source sample to read (may be negative)
    double audiblePos = 0;            // source samples, what the listener hears now
    std::atomic<double> audiblePosShared { 0 };
    // Song clock for recording: QPC time (100 ns) of a callback and the song time of that block's first sample.
    // Written by the audio thread under a sequence counter (odd = being written), read by getClockAnchor.
    std::atomic<juce::uint32> anchorSeq { 0 };
    std::atomic<juce::int64> anchorQpc { 0 };
    std::atomic<double> anchorSong { 0 };
    void writeClockAnchor (juce::int64 qpc100ns, double songSec); // audio thread; qpc 0 = no valid pair
    signalsmith::stretch::SignalsmithStretch<float> stretch;
    bool stretchActive = false;
    juce::AudioBuffer<float> srcBlock, trackScratch;
    double stretchAccum = 0;  // fractional input samples carried between stretch chunks
    juce::AudioBuffer<float> fifo;    // post-stretch audio at source rate, waiting for the resampler
    int fifoCount = 0;
    juce::WindowedSincInterpolator resamplers[2];
    juce::AudioBuffer<float> devTmp;

    // Click and cue scheduling.
    juce::SpinLock soundLock;
    std::vector<TimedSound> clickEvents, cueEvents;
    std::shared_ptr<SoundBank> cueBank;
    SoundBank clickBank;              // 0 = accent, 1 = beat, 2 = subdivision
    std::atomic<bool> clickOn { false }, cuesOn { false };
    std::atomic<float> clickGain { 0.7f }, cueGain { 0.9f };
    struct Voice { const juce::AudioBuffer<float>* buf; int pos; float gain; int delay; };
    std::vector<Voice> voices;

    // Tuner input FIFO (mono, device rate).
    std::atomic<bool> tunerOn { false };
    std::atomic<bool> deviceRateChanged { false };

    // Master bus: gain -> safety limiter (playback only) -> meters.
    // Music, click/cues and the final output each have their own limiter (same delay, so they stay in sync).
    // Click and cues are limited separately so a loud click can never turn the music down on the beat.
    SafetyLimiter limiter, voiceLimiter;
    VoiceDucker outDucker; // final stage: click/cues down (max 6 dB), then a brief music dip, so the sum stays under -1 dBFS
    double heldSeek = std::numeric_limits<double>::quiet_NaN(); // audio thread: seek waiting for its fade-out block
    std::atomic<double> heldSeekShared { std::numeric_limits<double>::quiet_NaN() }; // the same, for getPositionSeconds
    int tailRemaining = 0; // audio thread: limiter delay still to flush after a pause
    juce::AudioBuffer<float> voiceTmp;
    std::atomic<bool> fadeOutThenPause { false }, fadeInRequest { false };
    std::atomic<float> masterGain { 1.0f };
    std::atomic<bool> limiterOn { true };
    std::atomic<float> masterPeak { 0.0f }, masterPrePeak { 0.0f }, limiterGrDb { 0.0f };
    std::atomic<bool> masterClipped { false };
    int fadeInRemaining = 0, fadeInLength = 192; // short ramp after every seek/loop jump: no pop
    // Live monitoring (swapped under monitorLock; the audio thread try-locks).
    juce::SpinLock monitorLock;
    std::vector<std::shared_ptr<MonitorTap>> monitors;
    PadSynth pad;
    float duckEnv = 0, padDuck = 1; // audio thread: the pad's ducking under the live inputs
    juce::AudioBuffer<float> monitorTmp;
    juce::AbstractFifo tunerFifo { 1 << 15 };
    std::vector<float> tunerData = std::vector<float> (1 << 15);
    std::vector<float> tunerWindow;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Engine)
};
