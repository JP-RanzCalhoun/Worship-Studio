// Checks for Limiter.h (output stage): ceiling, click floor, music dip, and the pause fade (no unfaded tail).
#include <juce_audio_basics/juce_audio_basics.h>
#include "../../app/src/Limiter.h"
#include <cstdio>

using namespace juce;

int main()
{
    const double sr = 48000;
    const int n = 480, blocks = 2000;
    SafetyLimiter lim, vlim;
    VoiceDucker duck;
    lim.prepare (sr, -1.5f);
    vlim.prepare (sr, -1.0f);
    duck.prepare (sr, -1.0f);
    const float ceiling = Decibels::decibelsToGain (-1.0f);

    Random rnd (42);
    std::vector<float> l (n), r (n), vl (n), vr (n);
    float maxOut = 0, minVoice = 1, minMusic = 1;
    double phase = 0;
    int64 t = 0;
    // Loud "music" (sine + noise, peaks well over 0 dBFS, so the limiter works hard) + a click every 0.5 s.
    for (int b = 0; b < blocks; ++b)
    {
        for (int i = 0; i < n; ++i, ++t)
        {
            phase += 2 * MathConstants<double>::pi * 110 / sr;
            const float m = 1.2f * (float) std::sin (phase) + 0.3f * (rnd.nextFloat() * 2 - 1);
            l[(size_t) i] = m;
            r[(size_t) i] = -m * 0.9f;
            const int64 k = t % 24000;
            const float click = k < 480 ? 0.7f * (float) std::sin (2 * MathConstants<double>::pi * 1500 * k / sr) * (1 - k / 480.0f) : 0.0f;
            vl[(size_t) i] = vr[(size_t) i] = click;
        }
        lim.process (l.data(), r.data(), n);
        vlim.process (vl.data(), vr.data(), n);
        duck.process (l.data(), r.data(), vl.data(), vr.data(), n);
        for (int i = 0; i < n; ++i)
            maxOut = std::max ({ maxOut, std::abs (l[(size_t) i]), std::abs (r[(size_t) i]) });
        minVoice = std::min (minVoice, Decibels::decibelsToGain (duck.takeDuckDb()));
        minMusic = std::min (minMusic, Decibels::decibelsToGain (duck.takeMusicDipDb()));
    }
    std::printf ("loud music + click: max out %.4f (ceiling %.4f) %s\n", maxOut, ceiling, maxOut <= ceiling + 1e-6f ? "OK" : "FAIL");
    std::printf ("click lowest gain %.1f dB (floor -6.0) %s, music lowest dip %.1f dB\n", Decibels::gainToDecibels (minVoice),
                 minVoice >= 0.5f - 1e-6f ? "OK" : "FAIL", Decibels::gainToDecibels (minMusic));

    // Typical case: a mastered song at the default master gain (-3 dB): peaks about 0.7, click at 0.63.
    duck.prepare (sr, -1.0f);
    minVoice = minMusic = 1;
    for (int b = 0; b < 200; ++b)
    {
        for (int i = 0; i < n; ++i, ++t)
        {
            phase += 2 * MathConstants<double>::pi * 110 / sr;
            l[(size_t) i] = r[(size_t) i] = 0.7f * (float) std::sin (phase);
            const int64 k = t % 24000;
            vl[(size_t) i] = vr[(size_t) i] = k < 480 ? 0.63f * (float) std::sin (2 * MathConstants<double>::pi * 1500 * k / sr) : 0.0f;
        }
        duck.process (l.data(), r.data(), vl.data(), vr.data(), n);
        minVoice = std::min (minVoice, Decibels::decibelsToGain (duck.takeDuckDb()));
        minMusic = std::min (minMusic, Decibels::decibelsToGain (duck.takeMusicDipDb()));
    }
    std::printf ("typical song: click lowest gain %.1f dB, music lowest dip %.1f dB\n", Decibels::gainToDecibels (minVoice), Decibels::gainToDecibels (minMusic));

    // Pause: fade BEFORE the limiter, then silent blocks. Nothing louder than the fade may come out afterwards.
    lim.prepare (sr, -1.5f);
    for (int b = 0; b < 10; ++b)
    {
        for (int i = 0; i < n; ++i)
            l[(size_t) i] = r[(size_t) i] = 0.5f * (float) std::sin (2 * MathConstants<double>::pi * 440 * (b * n + i) / sr);
        if (b == 9)
            for (int i = 0; i < n; ++i)
            {
                const float g = i < 192 ? 1.0f - i / 192.0f : 0.0f;
                l[(size_t) i] *= g;
                r[(size_t) i] *= g;
            }
        lim.process (l.data(), r.data(), n);
    }
    std::fill (l.begin(), l.end(), 0.0f);
    std::fill (r.begin(), r.end(), 0.0f);
    lim.process (l.data(), r.data(), n);
    float tail = 0;
    for (float x : l)
        tail = std::max (tail, std::abs (x));
    std::printf ("pause: loudest sample after the fade block %.5f %s\n", tail, tail < 0.01f ? "OK (no click)" : "FAIL (click)");
    return 0;
}
