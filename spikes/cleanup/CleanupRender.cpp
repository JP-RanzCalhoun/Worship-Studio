// Offline check of InputCleanup (hum filter, gate, vocal polish) on a WAV file.
// CleanupRender in.wav out.wav [--hum] [--gate dB] [--vocal liftDb]
#include <juce_audio_formats/juce_audio_formats.h>
#include "../../app/src/InputCleanup.h"

int main (int argc, char** argv)
{
    if (argc < 3)
    {
        std::puts ("CleanupRender in.wav out.wav [--hum] [--gate dB] [--vocal liftDb]");
        return 1;
    }
    auto s = std::make_shared<InputCleanup::Settings>();
    for (int i = 3; i < argc; ++i)
    {
        const juce::String a (argv[i]);
        if (a == "--hum") s->hum = true;
        if (a == "--gate" && i + 1 < argc) { s->gate = true; s->thresholdDb = (float) std::atof (argv[++i]); }
        if (a == "--vocal" && i + 1 < argc) { s->vocal = true; s->lift = (float) std::atof (argv[++i]); }
    }
    juce::AudioFormatManager fm;
    fm.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> r (fm.createReaderFor (juce::File (juce::String (argv[1]))));
    if (r == nullptr) { std::puts ("cannot read input"); return 1; }
    const int ch = (int) r->numChannels;
    juce::AudioBuffer<float> buf (ch, (int) r->lengthInSamples);
    r->read (&buf, 0, (int) r->lengthInSamples, 0, true, true);
    InputCleanup cleaner (s);
    for (int pos = 0; pos < buf.getNumSamples(); pos += 480) // 10 ms packets, like the live capture
    {
        const int n = std::min (480, buf.getNumSamples() - pos);
        float* p[8];
        for (int c = 0; c < ch && c < 8; ++c) p[c] = buf.getWritePointer (c, pos);
        cleaner.process (p, std::min (ch, 8), n, r->sampleRate);
    }
    juce::File out { juce::String (argv[2]) };
    out.deleteFile();
    juce::WavAudioFormat wav;
    std::unique_ptr<juce::AudioFormatWriter> w (wav.createWriterFor (new juce::FileOutputStream (out), r->sampleRate, (unsigned) ch, 24, {}, 0));
    w->writeFromAudioSampleBuffer (buf, 0, buf.getNumSamples());
    std::printf ("wrote %s (%d ch, %.1f s)\n", argv[2], ch, buf.getNumSamples() / r->sampleRate);
    return 0;
}
