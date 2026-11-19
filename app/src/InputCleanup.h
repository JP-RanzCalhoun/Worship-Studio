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
 *  - Vocal polish (JP, 2026-11-19, PD200X a little away from the mouth while playing guitar): the usual cover-vocal
 *    chain, no look-ahead so no added delay: low cut 90 Hz, an auto-leveler that lifts the voice back up when you lean
 *    away (up to `lift` dB, slow, frozen while the gate is closed so it never pumps up bleed or room), a 3:1
 *    compressor, a de-esser (6 kHz band), and +2.5 dB of presence at 4 kHz.
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
        std::atomic<bool> vocal { false };
        std::atomic<float> lift { 9.0f }; // dB the leveler may add when you sing further away (0-12)
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
        const bool hum = s->hum.load(), gate = s->gate.load(), vocal = s->vocal.load();
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
        if (vocal)
            polish (ch, numCh, n, rate, s->lift.load(), gate);
    }

    /** Settings from the UI's JSON: { hum, humHz, gate, thresholdDb }. */
    static void read (Settings& s, const juce::var& v)
    {
        if (v.hasProperty ("hum")) s.hum = (bool) v["hum"];
        if (v.hasProperty ("gate")) s.gate = (bool) v["gate"];
        if (v.hasProperty ("humHz")) s.humHz = juce::jlimit (40.0f, 70.0f, (float) (double) v["humHz"]);
        if (v.hasProperty ("thresholdDb")) s.thresholdDb = juce::jlimit (-90.0f, -10.0f, (float) (double) v["thresholdDb"]);
        if (v.hasProperty ("vocal")) s.vocal = (bool) v["vocal"];
        if (v.hasProperty ("lift")) s.lift = juce::jlimit (0.0f, 12.0f, (float) (double) v["lift"]);
    }

private:
    /** The vocal chain, per sample; channels are linked (one gain for all). */
    void polish (float* const* ch, int numCh, int n, double rate, float liftDb, bool gateOn)
    {
        if (numCh != pChans || rate != pRate)
        {
            pChans = numCh;
            pRate = rate;
            lowCut.clear();
            presence.clear();
            sibil.clear();
            for (int c = 0; c < numCh; ++c)
            {
                lowCut.push_back (std::make_unique<juce::IIRFilter>());
                presence.push_back (std::make_unique<juce::IIRFilter>());
                sibil.push_back (std::make_unique<juce::IIRFilter>());
                lowCut[(size_t) c]->setCoefficients (juce::IIRCoefficients::makeHighPass (rate, 90.0, 0.707));
                presence[(size_t) c]->setCoefficients (juce::IIRCoefficients::makePeakFilter (rate, 4000.0, 0.9, juce::Decibels::decibelsToGain (2.5f)));
                sibil[(size_t) c]->setCoefficients (juce::IIRCoefficients::makeHighPass (rate, 6000.0, 0.707));
            }
        }
        const auto coef = [rate] (double ms) { return (float) std::exp (-1.0 / (0.001 * ms * rate)); };
        const float aRms = coef (300.0);                   // the leveler listens over ~300 ms
        const float aUp = coef (1500.0), aDown = coef (400.0); // lifts slowly, backs off a bit faster
        const float cAtt = coef (5.0), cRel = coef (120.0);  // compressor
        const float dAtt = coef (2.0), dRel = coef (60.0);   // de-esser
        const float targetDb = -20.0f, compThrDb = -18.0f, ratio = 3.0f, makeupDb = 2.0f;
        // "singing" = above the gate's threshold + 6 dB (or -48 dB without the gate): the leveler never lifts bleed or room
        const float voiceDb = (gateOn ? settings->thresholdDb.load() : -54.0f) + 6.0f;
        for (int i = 0; i < n; ++i)
        {
            float x[8];
            const int nc = std::min (numCh, 8);
            float sq = 0.0f;
            for (int c = 0; c < nc; ++c)
            {
                x[c] = lowCut[(size_t) c]->processSingleSampleRaw (ch[c][i]);
                sq += x[c] * x[c];
            }
            sq /= (float) nc;
            // 1. leveler: follow the voice's loudness; move only while you sing (gate open), else hold the gain
            ms = aRms * ms + (1.0f - aRms) * sq;
            const float levelDb = juce::Decibels::gainToDecibels (std::sqrt (ms), -120.0f);
            const bool singing = levelDb > voiceDb;
            if (singing)
            {
                const float want = juce::jlimit (-6.0f, liftDb, targetDb - levelDb);
                const float a = want > levDb ? aUp : aDown;
                levDb = a * levDb + (1.0f - a) * want;
            }
            const float lev = juce::Decibels::decibelsToGain (levDb);
            // 2. compressor 3:1 above -18 dB (peak follower), then +3 dB make-up
            float pk = 0.0f;
            for (int c = 0; c < nc; ++c)
                pk = std::max (pk, std::abs (x[c] * lev));
            env = pk > env ? cAtt * env + (1.0f - cAtt) * pk : cRel * env + (1.0f - cRel) * pk;
            const float envDb = juce::Decibels::gainToDecibels (env, -120.0f);
            const float grDb = envDb > compThrDb ? (envDb - compThrDb) * (1.0f - 1.0f / ratio) : 0.0f;
            const float g = lev * juce::Decibels::decibelsToGain (makeupDb - grDb);
            for (int c = 0; c < nc; ++c)
            {
                float y = x[c] * g;
                // 3. de-esser: turn the 6 kHz band down when it gets hot (up to -8 dB)
                const float hi = sibil[(size_t) c]->processSingleSampleRaw (y);
                const float a = std::abs (hi);
                ess = a > ess ? dAtt * ess + (1.0f - dAtt) * a : dRel * ess + (1.0f - dRel) * a;
                const float essDb = juce::Decibels::gainToDecibels (ess, -120.0f);
                const float cut = juce::jlimit (0.0f, 8.0f, (essDb + 30.0f) * 0.5f); // starts at -30 dBFS
                y = (y - hi) + hi * juce::Decibels::decibelsToGain (-cut);
                // 4. presence, then 5. a soft ceiling at -1 dBFS (no added delay): peaks bend instead of clipping
                y = presence[(size_t) c]->processSingleSampleRaw (y);
                const float ay = std::abs (y), knee = 0.7f, top = 0.891f;
                if (ay > knee)
                    y = std::copysign (knee + (top - knee) * std::tanh ((ay - knee) / (top - knee)), y);
                ch[c][i] = y;
            }
        }
    }

    std::vector<std::unique_ptr<juce::IIRFilter>> lowCut, presence, sibil; // not copyable
    int pChans = 0;
    double pRate = 0;
    float ms = 0.0f, levDb = 0.0f, env = 0.0f, ess = 0.0f;

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
