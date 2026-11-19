#pragma once

#include "InputRecorder.h"

/**
 * One recording pass over a song: every armed input is recorded to its own dry WAV ("take"),
 * then lined up with the song so that sample 0 of each aligned file is song time `takeStartSec`.
 *
 * Timing: the inputs carry QPC timestamps per packet (see InputTrack). The playback engine reports
 * (QPC, song time) pairs while the song plays; a straight-line fit of those gives the exact QPC time
 * at which any song time was heard (plus the output latency). Both clocks then meet on the QPC clock.
 *
 * Files: <song>/takes/take-NNN/raw/<Label>.wav (+ .json timing), <song>/takes/take-NNN/<Label>.wav (aligned),
 * <song>/takes/take-NNN/take.json. The raw files are kept, so the alignment can be redone (reversible).
 */
class RecordSession
{
public:
    struct Track
    {
        juce::String label;  // "Guitar", "Vocal"
        juce::String device; // Windows endpoint ID ("{...}"), or a name / name part (older takes, tests)
    };

    /** Inputs for the UI: name, plus a warning for virtual or wireless devices. */
    static juce::var listInputs();

    juce::String start (const juce::File& songDir, const juce::Array<Track>& tracks, double takeStartSec);
    /** Call often while recording (from the message thread): one (QPC, song time) pair from the engine. */
    void addClockSample (juce::int64 qpc100ns, double songSec, double tempo = 1.0);
    /**
     * Stops, aligns and writes take.json. `outputLatencySec` = time from the engine's callback to the
     * speaker/headphones; `calibration` = measured extra offset per input, positive = takes are late (see calibrationFor);
     * `songRate` = the song's sample rate (the lined-up files use it, so they play like stems).
     * Returns the take description (or {error}).
     */
    juce::var stop (double outputLatencySec, const juce::var& calibration, double songRate);
    /** One input's value from `calibration`: { "<device name part>": seconds } or one number for all; 0 if none. */
    static double calibrationFor (const juce::var& calibration, const juce::String& device);
    std::shared_ptr<InputCleanup::Settings> cleanupFor (const juce::String& label) const;
    /**
     * Solo take (no song playing): the inputs are lined up with each other, from the moment the last one started,
     * at `rate`. Writes the lined-up files and take.json like stop(). Returns the take description (or {error}).
     */
    juce::var stopSolo (const juce::var& calibration, double rate);
    juce::File getTakeDir() const { return takeDir; }
    /** Hum filter / gate per track label ("Guitar", "Vocal") for the lined-up files of the next stop. */
    void setCleanup (std::map<juce::String, std::shared_ptr<InputCleanup::Settings>> c) { cleanup = std::move (c); }
    void cancel();

    bool isRecording() const { return recorder.isRecording(); }
    double getSeconds() const;
    /** Per-track peak since the last call (0..1) and lost-sample count. */
    juce::var takeMeters();

    /** Takes of a song, newest first (from take.json files). */
    static juce::var listTakes (const juce::File& songDir, const juce::File& currentTake = {});
    /** Folder of the take being recorded now (empty when not recording). */
    juce::File getCurrentTakeDir() const { return isRecording() ? takeDir : juce::File(); }

private:
    InputRecorder recorder;
    juce::Array<Track> armed;
    juce::File takeDir;
    std::map<juce::String, std::shared_ptr<InputCleanup::Settings>> cleanup;
    double startSec = 0;
    // song clock fit: x = QPC seconds since the first pair, y = song seconds
    juce::int64 clockQpc0 = -1;
    double cn = 0, csx = 0, csy = 0, csxx = 0, csxy = 0, lastX = 0, lastY = 0;
    double firstX = 0;
    bool jumped = false; // the play position jumped (seek, pause + play elsewhere): later pairs are ignored
};
