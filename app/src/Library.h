#pragma once

#include <juce_audio_formats/juce_audio_formats.h>

/**
 * Song projects on disk. One folder per song:
 *   song.json      user data (chart edits, cues, mixer, capo...). Owned by the UI.
 *   analysis.json  machine analysis. Written only by the sidecar.
 *   source/        untouched copy of the imported file
 *   mix.wav        decoded full mix (float WAV, original sample rate)
 *   stems/*.wav    separated stems
 *   cues/*.wav     rendered spoken cues
 */
class Library
{
public:
    Library();

    juce::File getRoot() const { return root; }
    juce::File songDir (const juce::String& id) const;
    /** Song time (s) where the active take starts (song.json "activeTake"), 0 if none. */
    double activeTakeStart (const juce::String& id) const;

    juce::var listSongs() const;
    /** Copies and decodes an audio file into a new project. Returns the new id, or throws a String error. */
    juce::String importSong (const juce::File& source, std::function<void (double)> onProgress);
    juce::var readProject (const juce::String& id) const;
    juce::String writeSong (const juce::String& id, const juce::String& json);
    juce::String deleteSong (const juce::String& id);
    /** Deletes stem folders that analysis.json no longer points to (best effort). */
    void cleanupStems (const juce::String& id);

    /** (id, name, file) for every playable track: stems if present, else the mix. */
    std::vector<std::tuple<juce::String, juce::String, juce::File>> tracksFor (const juce::String& id) const;

    /** Peak envelope (max abs per bin) of the mix, for the waveform view. */
    juce::var peaks (const juce::String& id, int bins) const;

    static bool writeWav (const juce::File& f, const juce::AudioBuffer<float>& buf, double rate, int bits);
    static bool writeWavTo (const juce::File& f, const juce::AudioBuffer<float>& buf, double rate, int bits);

private:
    juce::File resolveStem (const juce::File& songDir, const juce::String& stored) const;
    juce::File root;
    mutable juce::AudioFormatManager formats;
};
