#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <atomic>
#include <cmath>
#include <memory>
#include <vector>

/**
 * Input cleanup for a guitar or vocal input (JP, 2026-11-17: E2 Gen2 buzz audible even with the guitar volume low):
 *  - Hum filter: very narrow notches at the mains frequency (60 Hz in the Philippines, 50 Hz elsewhere) and its
 *    first 8 harmonics. Removes hum, leaves the guitar's tone (each notch is about 1.5-12 Hz wide).
 *  - Noise gate: silences the buzz between phrases and opens within 0.5 ms when you play; holds 80 ms, then
 *    closes over 150 ms (no chopped tails). It turns the input down 40 dB rather than off (sounds natural).
 * No look-ahead, so no added delay: safe for live monitoring. Takes keep their raw file; the lined-up take is
 * cleaned with the same settings, so the cleanup can be undone by lining the take up again without it.
 *
 * Settings are shared (atomics) between the UI thread and the audio/capture thread that runs process().
 */
class InputCleanup
{
public:
    struct Settings
    {
        std::atomic<bool> hum { false }, gate { false };
        std::atomic<float> humHz { 60.0f };
        std::atomic<float> thresholdDb { -50.0f };
        /** Loudest sample since the UI last read it (after the hum filter, before the gate): for "Learn noise". */
        std::atomic<float> peak { 0.0f };
    };

    explicit InputCleanup (std::shared_ptr<Settings> s = {}) : settings (std::move (s)) {}
    void setSettings (std::shared_ptr<Settings> s) { settings = std::move (s); }

    /** Cleans `n` samples of `numCh` channels in place, at `rate`. */
    void process (float* const* ch, int numCh, int n, double rate)
    {
        auto s = settings;
        if (s == nullptr || n <= 0 || numCh <= 0)
            return;
        const bool hum = s->hum.load(), gate = s->gate.load();
        if (hum)
        {
            const float hz = s->humHz.load();
            if (numCh != chans || rate != fRate || hz != fHz)
                design (numCh, rate, hz);
            for (int c = 0; c < numCh; ++c)
                for (auto& f : notches[(size_t) c])
                    f->processSamples (ch[c], n);
        }
        float blockPeak = 0;
        for (int c = 0; c < numCh; ++c)
            for (int i = 0; i < n; ++i)
                blockPeak = std::max (blockPeak, std::abs (ch[c][i]));
        if (blockPeak > s->peak.load())
            s->peak.store (blockPeak);
        if (gate)
        {
            const float thr = juce::Decibels::decibelsToGain (s->thresholdDb.load());
            const float close = thr * 0.63f; // 4 dB hysteresis: no chatter at the edge
            const float floorGain = juce::Decibels::decibelsToGain (-40.0f);
            const float openStep = 1.0f / (float) (0.0005 * rate);    // 0.5 ms
            const float closeStep = 1.0f / (float) (0.150 * rate);    // 150 ms
            const int holdSamples = (int) (0.080 * rate);              // 80 ms
            for (int i = 0; i < n; ++i)
            {
                float pk = 0;
                for (int c = 0; c < numCh; ++c)
                    pk = std::max (pk, std::abs (ch[c][i]));
                if (pk > thr)
                {
                    open = true;
                    hold = holdSamples;
                }
                else if (open && pk < close && --hold <= 0)
                    open = false;
                const float target = open ? 1.0f : 0.0f;
                g += juce::jlimit (-closeStep, openStep, target - g);
                const float gain = floorGain + (1.0f - floorGain) * g;
                for (int c = 0; c < numCh; ++c)
                    ch[c][i] *= gain;
            }
        }
    }

    /** Settings from the UI's JSON: { hum, humHz, gate, thresholdDb }. */
    static void read (Settings& s, const juce::var& v)
    {
        if (v.hasProperty ("hum")) s.hum = (bool) v["hum"];
        if (v.hasProperty ("gate")) s.gate = (bool) v["gate"];
        if (v.hasProperty ("humHz")) s.humHz = juce::jlimit (40.0f, 70.0f, (float) (double) v["humHz"]);
        if (v.hasProperty ("thresholdDb")) s.thresholdDb = juce::jlimit (-90.0f, -10.0f, (float) (double) v["thresholdDb"]);
    }

private:
    void design (int numCh, double rate, float hz)
    {
        chans = numCh;
        fRate = rate;
        fHz = hz;
        notches.clear();
        notches.resize ((size_t) numCh);
        for (auto& list : notches)
            for (int k = 1; k <= 8 && k * hz < rate * 0.45; ++k)
            {
                auto f = std::make_unique<juce::IIRFilter>(); // not copyable
                f->setCoefficients (juce::IIRCoefficients::makeNotchFilter (rate, k * hz, 40.0));
                list.push_back (std::move (f));
            }
    }

    std::shared_ptr<Settings> settings;
    std::vector<std::vector<std::unique_ptr<juce::IIRFilter>>> notches;
    int chans = 0;
    double fRate = 0;
    float fHz = 0;
    bool open = false;
    int hold = 0;
    float g = 1.0f;
};
