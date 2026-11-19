// Test for InputRecorder (M2b). Two parts:
//  1. "live A B seconds": dry run on two real inputs. Nothing is stored (privacy): only counts, timing, glitches, level.
//  2. "align DIR": alignTake on synthetic files (no microphone). Checks the drift and offset correction.
#include "../../app/src/InputRecorder.h"
#include <windows.h>

using namespace juce;

static int live (const String& a, const String& b, int seconds)
{
    InputRecorder rec;
    Array<InputRecorder::Source> src;
    src.add ({ a, {} });
    src.add ({ b, {} });
    auto err = rec.start (src);
    if (err.isNotEmpty())
        return std::printf ("start failed: %s\n", err.toRawUTF8()), 1;
    std::printf ("  t(s)   frames A     frames B\n");
    for (int s = 10; s <= seconds; s += 10)
    {
        Thread::sleep (10000);
        std::printf ("%6d  %10lld  %10lld\n", s, (long long) rec.get (0)->getFrames(), (long long) rec.get (1)->getFrames());
    }
    auto st = rec.stop();
    for (auto& x : st)
        std::printf ("%s\n", JSON::toString (x.toVar(), true).toRawUTF8());
    if (st.size() == 2)
    {
        const double startDiffMs = (st[1].firstQpc100ns - st[0].firstQpc100ns) / 1.0e4;
        const double rel = (st[0].measuredRate() / st[1].measuredRate() - 1.0) * 1.0e6;
        std::printf ("B started %.2f ms after A. A vs B: %+.2f ppm -> %.2f ms after 5 minutes (corrected by alignTake)\n", startDiffMs, rel, rel * 0.3);
    }
    return 0;
}

static int align (const File& dir)
{
    // A 1 kHz tone "recorded" by a device whose clock runs 100 ppm fast, starting 250 ms after the song start.
    const double nominal = 48000, actual = 48000 * 1.0001;
    const int frames = (int) (actual * 60); // 60 s
    auto in = dir.getChildFile ("rt_in.wav"), out = dir.getChildFile ("rt_out.wav");
    {
        in.deleteFile();
        std::unique_ptr<OutputStream> s = std::make_unique<FileOutputStream> (in);
        WavAudioFormat wav;
        std::unique_ptr<AudioFormatWriter> w (wav.createWriterFor (s, AudioFormatWriterOptions{}.withSampleRate (nominal).withNumChannels (1).withBitsPerSample (24)));
        AudioBuffer<float> b (1, frames);
        for (int i = 0; i < frames; ++i)
            b.setSample (0, i, 0.5f * (float) std::sin (2 * MathConstants<double>::pi * 1000.0 * i / actual)); // 1 kHz in real time
        w->writeFromAudioSampleBuffer (b, 0, frames);
    }
    InputTrack::Stats st;
    st.sampleRate = 48000;
    st.channels = 1;
    st.frames = frames;
    st.firstQpc100ns = 10'000'000 + 2'500'000; // song starts at QPC 1 s, the input 250 ms later
    st.lastPacketFrames = 480;
    st.lastQpc100ns = st.firstQpc100ns + (int64) std::llround ((frames - 480) / actual * 1.0e7);
    std::printf ("measured rate %.3f (true %.3f)\n", st.measuredRate(), actual);

    auto err = InputRecorder::alignTake (in, st, 10'000'000, nominal, nominal, out);
    if (err.isNotEmpty())
        return std::printf ("align failed: %s\n", err.toRawUTF8()), 1;
    AudioFormatManager fm;
    fm.registerBasicFormats();
    std::unique_ptr<AudioFormatReader> r (fm.createReaderFor (out));
    AudioBuffer<float> b (1, (int) r->lengthInSamples);
    r->read (&b, 0, b.getNumSamples(), 0, true, false);
    // Expected: 12000 samples of silence (250 ms), then 1 kHz at exactly 48 samples per cycle, 60 s long.
    int firstSound = 0;
    while (firstSound < b.getNumSamples() && std::abs (b.getSample (0, firstSound)) < 1e-3f)
        ++firstSound;
    std::printf ("length %.4f s (expected 60.2500), sound starts at sample %d (expected 12000)\n", b.getNumSamples() / nominal, firstSound);
    // Phase check near the end: compare with an ideal 1 kHz tone that starts at sample 12000.
    double err2 = 0, ref2 = 0;
    for (int i = b.getNumSamples() - 48000; i < b.getNumSamples() - 4800; ++i)
    {
        const double ideal = 0.5 * std::sin (2 * MathConstants<double>::pi * 1000.0 * (i - 12000) / nominal);
        err2 += (b.getSample (0, i) - ideal) * (b.getSample (0, i) - ideal);
        ref2 += ideal * ideal;
    }
    std::printf ("error vs ideal tone in the last second: %.1f dB (lower is better; -40 dB or less = in sync)\n", 10 * std::log10 (err2 / ref2));
    in.deleteFile();
    out.deleteFile();
    return 0;
}

int main (int argc, char* argv[])
{
    CoInitializeEx (nullptr, COINIT_MULTITHREADED);
    const String mode = argc > 1 ? argv[1] : "";
    if (mode == "live" && argc >= 4)
        return live (argv[2], argv[3], argc > 4 ? atoi (argv[4]) : 60);
    if (mode == "interp")
    {
        // Where does an impulse at input 300 come out? (measures the interpolator's real delay)
        std::vector<float> in (2000, 0.0f), out (1000, 0.0f);
        in[300] = 1.0f;
        WindowedSincInterpolator w;
        const int used = w.process (1.0, in.data(), out.data(), 1000);
        int peakAt = 0;
        for (int i = 0; i < 1000; ++i)
            if (std::abs (out[(size_t) i]) > std::abs (out[(size_t) peakAt]))
                peakAt = i;
        std::printf ("base latency %.1f, used %d, impulse in at 300 -> out at %d\n", WindowedSincInterpolator::getBaseLatency(), used, peakAt);
        return 0;
    }
    if (mode == "align" && argc >= 3)
        return align (File (String (argv[2])));
    std::printf ("usage: RecorderTest live <A> <B> [seconds] | align <dir>\n");
    return 1;
}
