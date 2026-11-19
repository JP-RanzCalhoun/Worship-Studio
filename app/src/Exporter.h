#pragma once

#include <juce_audio_formats/juce_audio_formats.h>

/** Offline render of a rehearsal mix (selected stems at chosen levels), optionally with tempo/pitch change. */
struct ExportRequest
{
    struct In { juce::File file; float gain = 1.0f; };
    std::vector<In> tracks;
    double tempo = 1.0, semitones = 0.0;
    double startSec = 0, endSec = -1; // endSec < 0 = whole song
    struct Sound { double time; juce::File file; float gain; };
    std::vector<Sound> sounds;        // click/cue sounds, only when the user opts in
    juce::File output;
    int bits = 24;
    float masterGain = 1.0f;
    bool limit = true; // safety limiter at -1 dBFS (sample peak)
};

namespace Exporter
{
/** Blocking; call from a background thread. Returns an error message or empty on success. */
juce::String render (const ExportRequest& req, std::function<bool (double)> progress);
}
