#pragma once

#include <juce_audio_formats/juce_audio_formats.h>
#include "MonitorTap.h"

/**
 * Records the sound played by the app's built-in browser (and nothing else) to a WAV file.
 *
 * Uses Windows process-loopback capture (Windows 10 2004+ / Windows 11): it records the audio
 * output of one process tree, here the WebView2 browser processes started by this app. The app's
 * own playback engine runs in our main process, so it is NOT captured. This works like recording
 * the speakers: no download, no access to the website's files.
 */
class BrowserCapture : private juce::Thread
{
public:
    BrowserCapture();
    ~BrowserCapture() override;

    /** Starts recording to `file` (an empty File = listen only: nothing is written). Returns an error or empty. */
    juce::String start (const juce::File& file);
    /** Stops and closes the file. Returns the recorded length in seconds. */
    double stop();

    bool isRecording() const { return isThreadRunning() && ! failed.load(); }
    /** Set when a running capture had to stop (browser closed, device gone, disk full). Cleared by this call. */
    juce::String takeFailure();
    /** Packets Windows marked as lost (the recording has a small gap there). */
    int getGlitches() const { return glitches.load(); }
    /** Silence written in place of lost sound, in seconds. */
    double getGapSeconds() const { return gapFrames.load() / (double) sampleRate; }
    double getSeconds() const { return framesWritten.load() / (double) sampleRate; }
    float takePeak() { return peak.exchange (0.0f); }
    /** Every captured packet is also handed to `t` (the app plays the page's sound itself). Set before start. */
    void setTap (std::shared_ptr<MonitorTap> t) { tap = std::move (t); }

    static constexpr int sampleRate = 48000;

private:
    void run() override;
    void capture();
    /** The app's one WebView2 browser process (0 = none, ambiguousBrowser = more than one). */
    static juce::uint32 findBrowserProcessId();
    static constexpr juce::uint32 ambiguousBrowser = 0xFFFFFFFFu;

    juce::File target;
    juce::TimeSliceThread writerThread { "capture-writer" };
    std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter> writer; // disk writes off the capture thread
    std::atomic<juce::int64> framesWritten { 0 };
    std::atomic<float> peak { 0.0f };
    std::atomic<bool> failed { false };
    std::atomic<int> glitches { 0 };
    std::atomic<juce::int64> gapFrames { 0 };
    juce::CriticalSection errorLock;
    juce::String threadError, failure;
    juce::WaitableEvent started;
    juce::uint32 browserPid = 0;
    std::shared_ptr<MonitorTap> tap;
};
