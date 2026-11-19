#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <atomic>
#include <cmath>
#include <vector>

/**
 * Ambient worship pad, made in code (no samples, no licence questions). Four sounds in the style of today's worship
 * records (styles, not copies of anyone's samples):
 *   Warm          soft, dark drone (the default)
 *   Shimmer       airy: the octave-up "shimmer" layers twinkle slowly over a quiet base, bright long reverb
 *                 (the Hillsong / Bethel ambient style)
 *   Analog swell  brighter saw with a sub octave and a deep, slow filter swell (the Elevation-style synth pad)
 *   Gospel organ  drawbar organ (16', 8', 5 1/3', 4', 2 2/3', 2') with a slow rotary-speaker swirl (the gospel /
 *                 Maverick City keys world)
 * Every sound plays the key's root, fifth and octave (no third: fits the major and minor chords of the key).
 *
 * Sits BEHIND the guitar (JP, 2026-11-17): quiet, dark, a 5 dB dip at 300 Hz where the acoustic guitar's body is,
 * mostly reverb, wide, and the engine ducks it under the live guitar/vocal (Engine::addMonitor). No beat, so no time
 * signature to follow. Changing key or sound crossfades (4 s); on/off fades over 3 s.
 *
 * Thread use: set* from the message thread (atomics), prepare when the device starts, render on the audio thread.
 */
class PadSynth
{
public:
    enum class Flavor { warm = 0, shimmer = 1, analog = 2, organ = 3 };

    void setOn (bool on) { wantOn.store (on); }
    void setKey (int pitchClass) { wantKey.store (((pitchClass % 12) + 12) % 12); }
    void setLevel (float gain) { level.store (juce::jlimit (0.0f, 1.0f, gain)); }
    void setFlavor (Flavor f) { flavor.store ((int) f); }
    bool isOn() const { return wantOn.load(); }
    /** Still fading out or ringing in the reverb (audio thread). */
    bool isSounding() const { return master > 1.0e-5f || current >= 0; }

    void prepare (double sampleRate)
    {
        rate = sampleRate;
        if (tables[0].empty())
        {
            // 0 soft saw (8 harmonics, 1/n^1.4) · 1 bright saw (24 harmonics, 1/n) · 2 sine
            auto build = [] (std::vector<float>& t, int harmonics, double slope, double norm) {
                t.resize (tableSize + 1);
                for (int i = 0; i <= tableSize; ++i)
                {
                    double s = 0;
                    for (int h = 1; h <= harmonics; ++h)
                        s += std::sin (juce::MathConstants<double>::twoPi * h * i / tableSize) / std::pow ((double) h, slope);
                    t[(size_t) i] = (float) (s * norm);
                }
            };
            build (tables[0], 8, 1.4, 0.55);
            build (tables[1], 24, 1.0, 0.45);
            build (tables[2], 1, 1.0, 1.0);
        }
        reverb.setSampleRate (sampleRate);
        reverb.reset();
        applyReverb (flavor.load());
        // a gentle dip where the acoustic guitar's body sits, so the pad leaves it room
        for (auto& f : dip)
        {
            f.setCoefficients (juce::IIRCoefficients::makePeakFilter (sampleRate, 300.0, 0.8, juce::Decibels::decibelsToGain (-5.0f)));
            f.reset();
        }
        for (auto& l : layers)
            l = {};
        current = -1;
        master = 0;
        bufL.assign (maxBlock, 0.0f);
        bufR.assign (maxBlock, 0.0f);
    }

    /** Audio thread: adds the pad to l/r (n samples). Cheap when off and silent. */
    void renderAdd (float* l, float* r, int n)
    {
        if (rate <= 0 || tables[0].empty() || n > (int) bufL.size())
            return;
        const bool on = wantOn.load();
        if (! on && master < 1.0e-5f)
        {
            if (layers[0].active || layers[1].active) // faded out: stop the voices (next start begins fresh)
            {
                layers[0].active = layers[1].active = false;
                current = -1;
                reverb.reset();
            }
            return;
        }

        // A new key or sound (or the first start): a new layer fades in, the old one fades out.
        const int key = wantKey.load(), fl = flavor.load();
        if (on && (current < 0 || layers[current].key != key || layers[current].flavor != fl))
        {
            const int next = current < 0 ? 0 : 1 - current;
            startLayer (layers[next], key, fl);
            if (current >= 0)
                layers[current].target = 0.0f;
            current = next;
            applyReverb (fl);
        }
        const auto& ds = design (fl);

        const float lvl = level.load();
        const float masterTarget = on ? 1.0f : 0.0f;
        const float masterStep = 1.0f / (float) (3.0 * rate); // 3 s on/off
        const float layerStep = 1.0f / (float) (4.0 * rate);  // 4 s crossfade
        const double lfoInc = juce::MathConstants<double>::twoPi * ds.lfoHz / rate;
        const double tremInc = juce::MathConstants<double>::twoPi * ds.tremHz / rate;
        for (int i = 0; i < n; ++i)
        {
            master += juce::jlimit (-masterStep, masterStep, masterTarget - master);
            const float wobble = 1.0f + ds.vibDepth * (float) std::sin (trem * 1.3); // rotary Doppler (slightly off the level swirl)
            float sl = 0, sr = 0;
            for (auto& lay : layers)
            {
                if (! lay.active)
                    continue;
                lay.env += juce::jlimit (-layerStep, layerStep, lay.target - lay.env);
                if (lay.target == 0.0f && lay.env <= 0.0f)
                {
                    lay.active = false;
                    continue;
                }
                const auto& tab = tables[(size_t) design (lay.flavor).table];
                float vl = 0, vr = 0;
                for (int v = 0; v < lay.count; ++v)
                {
                    auto& o = lay.osc[v];
                    const double pos = o.phase * tableSize;
                    const int i0 = (int) pos;
                    const float frac = (float) (pos - i0);
                    float s = (tab[(size_t) i0] + frac * (tab[(size_t) i0 + 1] - tab[(size_t) i0])) * o.amp;
                    if (o.amDepth > 0) // shimmer twinkle: each high voice breathes on its own slow cycle
                    {
                        o.amPhase += o.amInc;
                        if (o.amPhase > juce::MathConstants<double>::twoPi)
                            o.amPhase -= juce::MathConstants<double>::twoPi;
                        s *= 1.0f - o.amDepth * (0.5f + 0.5f * (float) std::sin (o.amPhase));
                    }
                    o.phase += o.inc * wobble;
                    if (o.phase >= 1.0)
                        o.phase -= 1.0;
                    vl += s * o.panL;
                    vr += s * o.panR;
                }
                sl += vl * lay.env;
                sr += vr * lay.env;
            }
            // Rotary-speaker swirl (organ): the level moves between left and right, slowly.
            if (ds.tremDepth > 0)
            {
                trem += tremInc;
                if (trem > juce::MathConstants<double>::twoPi)
                    trem -= juce::MathConstants<double>::twoPi;
                const float t = (float) std::sin (trem);
                sl *= 1.0f - ds.tremDepth * (0.5f + 0.5f * t);
                sr *= 1.0f - ds.tremDepth * (0.5f - 0.5f * t);
            }
            // Breathing low-pass (one-pole): each sound has its own centre, depth and speed (dark = behind).
            lfo += lfoInc;
            if (lfo > juce::MathConstants<double>::twoPi)
                lfo -= juce::MathConstants<double>::twoPi;
            const double fc = ds.lpBase + ds.lpDepth * std::sin (lfo);
            const float a = (float) (1.0 - std::exp (-juce::MathConstants<double>::twoPi * fc / rate));
            lpL += a * (sl - lpL);
            lpR += a * (sr - lpR);
            const float g = master * lvl * ds.gain;
            float ol = lpL * g, orr = lpR * g;
            if (ds.drive > 0) // soft tube saturation at the output level: warmth and a little grit, level kept
            {
                ol = std::tanh (ol * ds.drive) / ds.drive;
                orr = std::tanh (orr * ds.drive) / ds.drive;
            }
            bufL[(size_t) i] = ol;
            bufR[(size_t) i] = orr;
        }
        dip[0].processSamples (bufL.data(), n);
        dip[1].processSamples (bufR.data(), n);
        reverb.processStereo (bufL.data(), bufR.data(), n);
        for (int i = 0; i < n; ++i)
        {
            l[i] += bufL[(size_t) i];
            r[i] += bufR[(size_t) i];
        }
    }

    static constexpr int maxBlock = 8192;

private:
    struct Note
    {
        double ratio; // to the root (root = C2..B2, 65-123 Hz; the organ sits an octave higher)
        float amp;
        float twinkle; // 0 = steady; >0 = slow independent breathing (shimmer)
    };
    struct Design
    {
        int table;                      // 0 soft saw, 1 bright saw, 2 sine
        std::vector<double> chord;      // the chord notes: root, fifth, octave (ratios)
        std::vector<Note> partials;     // per chord note: the voices that make the sound
        int detuneVoices;               // 3 = chorus (slightly detuned voices), 1 = one clean voice (organ)
        double detune;                  // spread of the detuned voices
        double octave;                  // 1 = C2 octave, 2 = C3 octave
        double lpBase, lpDepth, lfoHz;  // breathing low-pass
        float tremHz, tremDepth;        // rotary swirl: level moving left/right
        float vibDepth;                 // rotary swirl: pitch wobble (Doppler), as a fraction of the pitch
        float drive;                    // soft tube saturation (0 = clean)
        float gain;
        float wet, dry, room, damping;  // reverb
    };

    static const Design& design (int f)
    {
        static const Design designs[4] = {
            // Warm: soft saw, dark breathing low-pass, far away
            { 0, { 1.0, 1.5, 2.0 }, { { 1, 0.55f, 0 }, { 1.5, 0.22f, 0 } }, 3, 0.005, 1, 700, 200, 0.07, 0, 0, 0, 0, 0.2f, 0.72f, 0.28f, 0.95f, 0.6f },
            // Shimmer: a quiet base, octave-up layers that twinkle, bright long reverb
            { 0, { 1.0, 1.5, 2.0 }, { { 1, 0.3f, 0 }, { 2, 0.22f, 0.5f }, { 4, 0.16f, 0.7f }, { 6, 0.08f, 0.8f } }, 3, 0.006, 1, 2600, 600, 0.05, 0, 0, 0, 0,
              0.21f, 0.84f, 0.16f, 0.97f, 0.3f },
            // Analog swell: bright saw + sub octave, deep slow filter swell
            { 1, { 1.0, 1.5, 2.0 }, { { 0.5, 0.35f, 0 }, { 1, 0.45f, 0 } }, 3, 0.008, 1, 650, 400, 0.09, 0, 0, 0, 0, 0.25f, 0.6f, 0.4f, 0.88f, 0.55f },
            // Gospel organ: drawbars 16' 8' 5 1/3' 4' 2 2/3' 2', slow rotary swirl (level + Doppler pitch wobble),
            // soft tube drive, smaller room. Pure sines alone read as a test tone (earshot, 2026-11-17).
            { 2, { 1.0, 1.5, 2.0 }, { { 0.5, 0.5f, 0 }, { 1, 0.6f, 0 }, { 1.5, 0.35f, 0 }, { 2, 0.4f, 0 }, { 3, 0.2f, 0 }, { 4, 0.18f, 0 } }, 1, 0, 2,
              3200, 300, 0.05, 0.8f, 0.35f, 0.0018f, 6.0f, 0.083f, 0.42f, 0.58f, 0.72f, 0.5f },
        };
        return designs[juce::jlimit (0, 3, f)];
    }

    void applyReverb (int fl)
    {
        const auto& ds = design (fl);
        juce::Reverb::Parameters p;
        p.roomSize = ds.room;
        p.damping = ds.damping;
        p.wetLevel = ds.wet; // mostly reverb: the pad sounds far away, behind the player
        p.dryLevel = ds.dry;
        p.width = 1.0f;
        reverb.setParameters (p);
    }

    struct Osc
    {
        double phase = 0, inc = 0;
        float amp = 0, panL = 0.7f, panR = 0.7f;
        float amDepth = 0;
        double amPhase = 0, amInc = 0;
    };
    struct Layer
    {
        Osc osc[48];
        int count = 0, key = -1, flavor = 0;
        float env = 0, target = 0;
        bool active = false;
    };

    void startLayer (Layer& lay, int key, int fl)
    {
        lay = {};
        lay.key = key;
        lay.flavor = fl;
        lay.target = 1.0f;
        lay.active = true;
        const auto& ds = design (fl);
        const double root = 65.406 * ds.octave * std::pow (2.0, key / 12.0);
        juce::Random rnd ((juce::int64) (key * 977 + fl * 31 + 1));
        const int voices = juce::jmax (1, ds.detuneVoices);
        // quieter as more notes stack, so every sound sits at about the same level
        const float norm = 1.0f / (float) (voices * ds.chord.size());
        for (double c : ds.chord)
            for (const auto& p : ds.partials)
                for (int d = 0; d < voices && lay.count < 48; ++d)
                {
                    auto& o = lay.osc[lay.count++];
                    const double det = voices == 1 ? 0.0 : ds.detune * (d - (voices - 1) * 0.5);
                    o.inc = root * c * p.ratio * (1.0 + det) / rate;
                    o.phase = rnd.nextDouble();
                    o.amp = p.amp * norm * 3.0f * (c == 1.0 ? 1.0f : c == 1.5 ? 0.82f : 0.9f);
                    const float pan = voices == 1 ? (float) (0.3 + 0.4 * rnd.nextDouble()) : (d == 0 ? 0.1f : d == voices - 1 ? 0.9f : 0.5f);
                    o.panL = std::cos (pan * juce::MathConstants<float>::halfPi);
                    o.panR = std::sin (pan * juce::MathConstants<float>::halfPi);
                    if (p.twinkle > 0)
                    {
                        o.amDepth = p.twinkle;
                        o.amPhase = rnd.nextDouble() * juce::MathConstants<double>::twoPi;
                        o.amInc = juce::MathConstants<double>::twoPi * (0.08 + 0.17 * rnd.nextDouble()) / rate; // 4-12 s cycles
                    }
                }
    }

    static constexpr int tableSize = 2048;
    std::vector<float> tables[3];
    double rate = 0;
    Layer layers[2];
    int current = -1;
    float master = 0, lpL = 0, lpR = 0;
    double lfo = 0, trem = 0;
    std::vector<float> bufL, bufR; // audio thread scratch (sized in prepare)
    juce::Reverb reverb;
    juce::IIRFilter dip[2];
    std::atomic<bool> wantOn { false };
    std::atomic<int> wantKey { 0 }, flavor { 0 };
    std::atomic<float> level { 0.6f };
};
