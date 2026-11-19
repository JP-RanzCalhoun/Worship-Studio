#pragma once

#include <juce_audio_formats/juce_audio_formats.h>
#include "MonitorTap.h"
#include "InputCleanup.h"

/**
 * Records one USB/analog input device to its own WAV file (a "dry" take: no effects, no click).
 *
 * Each device runs on its own WASAPI shared-mode stream and its own clock. Every packet carries a
 * QPC timestamp (Windows high-resolution clock), so after the take we know exactly when the first
 * sample arrived and the device's real sample rate. That is what aligns two devices with each other
 * and with the song, and what corrects clock drift after the take (see `InputRecorder`).
 *
 * Disk writes happen on a separate writer thread (5 s buffer), so a slow disk does not drop audio.
 * If `file` is empty, nothing is stored (dry run: counts, timing and level only).
 */
class InputTrack : private juce::Thread
{
public:
    struct Stats
    {
        juce::String device;
        int sampleRate = 0, channels = 0;
        juce::int64 frames = 0;
        juce::int64 firstQpc100ns = 0, lastQpc100ns = 0; // time of the first / last packet's first sample
        juce::int64 lastPacketFrames = 0;
        double fitRate = 0;  // rate from a straight-line fit of (device position, QPC) over the whole take
        bool rawMode = false; // Windows accepted the raw (no effects) stream
        int glitches = 0;    // places where samples were lost (Windows flag or a jump in the device position)
        int gapFrames = 0;   // silence written in place of lost samples (keeps the timeline exact)
        juce::Array<juce::int64> gapAt, gapLen; // first gaps: file position and length (frames), for diagnosis
        int overruns = 0;    // blocks the writer thread could not take in time (disk too slow)
        int periodFrames = 0; // low-latency stream: Windows' period in frames (0 = the normal 10 ms stream)
        double measuredRate() const;
        juce::var toVar() const;
    };

    InputTrack();
    ~InputTrack() override;

    /** Opens the input with this Windows endpoint ID ("{...}"), else this exact name, else the only input whose name
        contains it, and starts recording. Returns an error or empty. */
    juce::String start (const juce::String& deviceNamePart, const juce::File& file);
    /** Stops, closes the file and writes `<file>.json` with the timing stats. */
    Stats stop();

    bool isRecording() const { return isThreadRunning(); }
    /** Live monitoring: every captured packet is also handed to `t` (set before start; must outlive the stream). */
    void setTap (std::shared_ptr<MonitorTap> t) { tap = std::move (t); }
    /** Hum filter / noise gate on what the monitor hears (the recorded raw file stays dry). Set before start. */
    void setCleanup (std::shared_ptr<InputCleanup::Settings> s) { cleanupSettings = std::move (s); }
    /** Ask Windows for its smallest shared-mode period (for live monitoring). Set before start. */
    void setLowLatency (bool on) { lowLatency = on; }
    int getPeriodFrames() const { return stats.periodFrames; }
    float takePeak() { return peak.exchange (0.0f); }
    juce::int64 getFrames() const { return frames.load(); }
    int getSampleRate() const { return stats.sampleRate; }

    /** Names of the active input devices (for the UI). */
    static juce::StringArray listInputs();
    /** (friendly name, Windows endpoint ID) of every active input. */
    static std::vector<std::pair<juce::String, juce::String>> listInputsWithIds();

private:
    void run() override;
    void captureLoop();

    juce::String namePart;
    juce::File target;
    std::shared_ptr<MonitorTap> tap; // set before start, read by the capture thread
    bool lowLatency = false;
    std::shared_ptr<InputCleanup::Settings> cleanupSettings;
    Stats stats;
    std::atomic<juce::int64> frames { 0 };
    std::atomic<float> peak { 0.0f };
    juce::CriticalSection errorLock;
    juce::String threadError; // guarded by errorLock
    juce::WaitableEvent started;
    juce::TimeSliceThread writerThread { "input-writer" };
    std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter> writer;
};

/**
 * Records several inputs at once (for example E2 Gen2 = guitar, PD200X = vocal), one file each.
 * Afterwards `alignTake` turns the raw files into tracks that start at the same moment and run
 * at the same rate (drift corrected), using the QPC timestamps.
 */
class InputRecorder
{
public:
    struct Source
    {
        juce::String deviceNamePart;
        juce::File file; // empty = dry run (nothing stored)
    };

    juce::String start (const juce::Array<Source>& sources);
    juce::Array<InputTrack::Stats> stop();
    bool isRecording() const;
    int size() const { return tracks.size(); }
    InputTrack* get (int i) { return tracks[i]; }

    /**
     * Writes `out` = `in` resampled so that output sample k is the sound at QPC time
     * startQpc100ns + k / outPerQpcSecond (silence before the first input sample, earlier samples dropped).
     * `outPerQpcSecond` is the output rate measured on the QPC clock (e.g. 48000 x the song clock's speed);
     * `fileRate` is the rate written in the WAV header. Returns an error or empty.
     * Uses windowed-sinc resampling (high quality); a few ppm of drift becomes an exact length.
     */
    static juce::String alignTake (const juce::File& in, const InputTrack::Stats& stats, juce::int64 startQpc100ns,
                                   double outPerQpcSecond, double fileRate, const juce::File& out,
                                   std::shared_ptr<InputCleanup::Settings> cleanup = {});

private:
    juce::OwnedArray<InputTrack> tracks;
};
