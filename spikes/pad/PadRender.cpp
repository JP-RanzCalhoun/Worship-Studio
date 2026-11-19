// Renders each ambient pad sound offline (no audio device) and prints its level, so the sounds can be checked
// and compared by ear: PadRender <out folder> [key 0-11]
// Each file: 24 s at 48 kHz, pad on at 0 s in the key, a key change up a fourth at 14 s (crossfade check),
// off at 20 s (fade-out and reverb tail).

#include <juce_audio_formats/juce_audio_formats.h>
#include "../../app/src/PadSynth.h"

int main (int argc, char** argv)
{
    using namespace juce;
    const File out = File::getCurrentWorkingDirectory().getChildFile (argc > 1 ? argv[1] : "pads");
    const int key = argc > 2 ? String (argv[2]).getIntValue() : 7; // G
    out.createDirectory();
    const double rate = 48000;
    const int block = 480, seconds = 24;
    const char* names[] = { "warm", "shimmer", "analog", "organ" };
    for (int f = 0; f < 4; ++f)
    {
        PadSynth pad;
        pad.prepare (rate);
        pad.setFlavor ((PadSynth::Flavor) f);
        pad.setKey (key);
        pad.setLevel (0.5f); // the app's default fader
        pad.setOn (true);
        AudioBuffer<float> all (2, (int) rate * seconds);
        all.clear();
        std::vector<float> l (block), r (block);
        double sum = 0;
        int64 n = 0;
        bool bad = false;
        for (int pos = 0; pos + block <= all.getNumSamples(); pos += block)
        {
            const double t = pos / rate;
            if (t >= 14 && t < 14 + block / rate)
                pad.setKey (key + 5);
            if (t >= 20 && t < 20 + block / rate)
                pad.setOn (false);
            std::fill (l.begin(), l.end(), 0.0f);
            std::fill (r.begin(), r.end(), 0.0f);
            pad.renderAdd (l.data(), r.data(), block);
            for (int i = 0; i < block; ++i)
            {
                if (! std::isfinite (l[i]) || ! std::isfinite (r[i]))
                    bad = true;
                all.setSample (0, pos + i, l[(size_t) i]);
                all.setSample (1, pos + i, r[(size_t) i]);
                if (t >= 5 && t < 13) // steady part, after the fade-in
                {
                    sum += 0.5 * (l[(size_t) i] * l[(size_t) i] + r[(size_t) i] * r[(size_t) i]);
                    ++n;
                }
            }
        }
        const float peak = all.getMagnitude (0, all.getNumSamples());
        const double rmsDb = 10.0 * std::log10 (sum / jmax<int64> (1, n) + 1e-12);
        auto file = out.getChildFile (String (names[f]) + ".wav");
        file.deleteFile();
        std::unique_ptr<OutputStream> stream = std::make_unique<FileOutputStream> (file);
        WavAudioFormat wav;
        std::unique_ptr<AudioFormatWriter> w (wav.createWriterFor (stream, AudioFormatWriterOptions{}.withSampleRate (rate).withNumChannels (2).withBitsPerSample (24)));
        if (w != nullptr)
            w->writeFromAudioSampleBuffer (all, 0, all.getNumSamples());
        printf ("%-8s peak %6.1f dBFS  steady RMS %6.1f dBFS  %s\n", names[f], Decibels::gainToDecibels (peak), rmsDb, bad ? "NaN/INF!" : "ok");
    }
    return 0;
}
