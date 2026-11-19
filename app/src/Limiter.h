#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

/**
 * Safety peak limiter for the playback bus and exports. Never used on recorded inputs.
 *
 * Look-ahead design (latency L samples, L ~ 1.5 ms):
 *   need[t]    = ceiling / peak[t] (or 1)
 *   hold[t]    = min(need[t-L .. t])            -- covers every sample still in the delay line
 *   ramp[t]    = mean(hold[t-L .. t])           -- smooth linear attack over L samples, no gain steps
 *   gain[t]    = ramp falls at once, rises with an ~80 ms release
 * Output y[t] = x[t-L] * gain[t]. Because every hold value averaged into ramp[t] includes x[t-L],
 * gain <= need[t-L]: the output never exceeds the ceiling (a SAMPLE peak; inter-sample peaks can be
 * slightly higher). Bypass keeps the delay running at unity gain, so toggling never replays stale
 * audio and the latency never changes. Real-time safe after prepare().
 */
class SafetyLimiter
{
public:
    void prepare (double sampleRate, float ceilingDb = -1.0f, double lookaheadMs = 1.5, double releaseMs = 80.0)
    {
        L = std::max (1, (int) std::round (sampleRate * lookaheadMs / 1000.0));
        delay.setSize (2, L);
        delay.clear();
        needs.assign ((size_t) L + 1, 1.0f);
        holds.assign ((size_t) L + 1, 1.0f);
        holdSum = (double) (L + 1);
        dPos = nPos = hPos = 0;
        ceiling = juce::Decibels::decibelsToGain (ceilingDb);
        release = (float) std::exp (-1.0 / (sampleRate * releaseMs / 1000.0));
        gain = 1.0f;
        minGainSeen = 1.0f;
    }

    /** Processes in place. Always adds exactly latencySamples() of delay. */
    void process (float* l, float* r, int n)
    {
        const float* const end = l + n;
        for (; l < end; ++l, ++r)
        {
            const float peak = std::max (std::abs (*l), std::abs (*r));
            const float need = (! bypass && peak > ceiling) ? ceiling / peak : 1.0f;

            needs[(size_t) nPos] = need;
            nPos = (nPos + 1) % (L + 1);
            float hold = 1.0f;
            for (float v : needs)
                hold = std::min (hold, v);

            holdSum += hold - holds[(size_t) hPos];
            holds[(size_t) hPos] = hold;
            hPos = (hPos + 1) % (L + 1);
            if (hPos == 0) // exact re-sum once per window: no drift over a long song
            {
                holdSum = 0.0;
                for (float v : holds)
                    holdSum += v;
            }
            const float ramp = (float) (holdSum / (L + 1));

            gain = ramp < gain ? ramp : ramp + (gain - ramp) * release;

            float* dl = delay.getWritePointer (0);
            float* dr = delay.getWritePointer (1);
            const float outL = dl[dPos], outR = dr[dPos]; // written L samples ago
            dl[dPos] = *l;
            dr[dPos] = *r;
            dPos = (dPos + 1) % L;
            *l = outL * gain;
            *r = outR * gain;
            minGainSeen = std::min (minGainSeen, gain);
        }
    }

    /** Lowest gain since the last call, in dB (0 = not limiting). */
    float takeGainReductionDb()
    {
        const float g = minGainSeen;
        minGainSeen = 1.0f;
        return juce::Decibels::gainToDecibels (g, -60.0f);
    }

    int latencySamples() const { return L; }
    bool bypass = false;

private:
    juce::AudioBuffer<float> delay;
    std::vector<float> needs, holds;
    double holdSum = 1.0;
    int L = 64, dPos = 0, nPos = 0, hPos = 0;
    float ceiling = 0.89f, release = 0.999f, gain = 1.0f, minGainSeen = 1.0f;
};

/**
 * Output stage for click and cues: keeps music + voice under the ceiling, and keeps the click audible.
 *
 * Step 1 turns down the voice bus (click, cues), but never below `minVoiceGain` (-6 dB).
 * Step 2, only if that is still too loud: the music dips just enough for the click (like a sidechain).
 * Per sample (both channels share one voice gain and one music gain):
 *   voiceTarget = max (minVoiceGain, min over ch of (|m|+|v| <= c ? 1 : (c - |m|) / |v|))
 *   musicNeed   = min over ch of (|m| + voiceTarget |v| <= c ? 1 : (c - voiceTarget |v|) / |m|)
 * Both gains are smoothed with the same hold + ramp as SafetyLimiter, so each is <= its target at the
 * output sample and |gm m + gv v| <= musicNeed |m| + voiceTarget |v| <= c.
 * Same delay L as SafetyLimiter, so music and voices stay aligned.
 */
class VoiceDucker
{
public:
    void prepare (double sampleRate, float ceilingDb = -1.0f, double lookaheadMs = 1.5, double releaseMs = 80.0)
    {
        L = std::max (1, (int) std::round (sampleRate * lookaheadMs / 1000.0));
        delay.setSize (4, L);
        delay.clear();
        dPos = 0;
        ceiling = juce::Decibels::decibelsToGain (ceilingDb);
        const float release = (float) std::exp (-1.0 / (sampleRate * releaseMs / 1000.0));
        voice.prepare (L, release);
        music.prepare (L, release);
    }

    /** music (ml, mr) and voices (vl, vr) in; the sum out in ml, mr. Adds exactly L samples of delay. */
    void process (float* ml, float* mr, const float* vl, const float* vr, int n)
    {
        for (int i = 0; i < n; ++i)
        {
            float vt = 1.0f, mNeed = 1.0f;
            if (! bypass)
            {
                auto vNeed = [this] (float m, float v) {
                    const float am = std::abs (m), av = std::abs (v);
                    return am + av <= ceiling || av <= 0.0f ? 1.0f : juce::jlimit (0.0f, 1.0f, (ceiling - am) / av);
                };
                vt = std::max (minVoiceGain, std::min (vNeed (ml[i], vl[i]), vNeed (mr[i], vr[i])));
                auto mNeedCh = [this, vt] (float m, float v) {
                    const float am = std::abs (m), av = std::abs (v) * vt;
                    return am + av <= ceiling || am <= 0.0f ? 1.0f : juce::jlimit (0.0f, 1.0f, (ceiling - av) / am);
                };
                mNeed = std::min (mNeedCh (ml[i], vl[i]), mNeedCh (mr[i], vr[i]));
            }
            const float gv = voice.push (vt), gm = music.push (mNeed);

            float* d0 = delay.getWritePointer (0);
            float* d1 = delay.getWritePointer (1);
            float* d2 = delay.getWritePointer (2);
            float* d3 = delay.getWritePointer (3);
            const float oml = d0[dPos], omr = d1[dPos], ovl = d2[dPos], ovr = d3[dPos];
            d0[dPos] = ml[i];
            d1[dPos] = mr[i];
            d2[dPos] = vl[i];
            d3[dPos] = vr[i];
            dPos = (dPos + 1) % L;
            ml[i] = oml * gm + ovl * gv;
            mr[i] = omr * gm + ovr * gv;
            minGainSeen = std::min (minGainSeen, gv);
            minMusicSeen = std::min (minMusicSeen, gm);
        }
    }

    /** Lowest voice gain since the last call, in dB (0 = not ducked). */
    float takeDuckDb()
    {
        const float g = minGainSeen;
        minGainSeen = 1.0f;
        return juce::Decibels::gainToDecibels (g, -60.0f);
    }
    /** Lowest music gain since the last call, in dB (0 = the music was not dipped for the click). */
    float takeMusicDipDb()
    {
        const float g = minMusicSeen;
        minMusicSeen = 1.0f;
        return juce::Decibels::gainToDecibels (g, -60.0f);
    }

    int latencySamples() const { return L; }
    bool bypass = false;
    float minVoiceGain = 0.5f; // -6 dB: the click never goes lower than this

private:
    /** Look-ahead gain smoother: min-hold over L+1 samples, moving-average ramp down, exponential release. */
    struct Smoother
    {
        std::vector<float> needs, holds;
        double holdSum = 1.0;
        int L = 64, nPos = 0, hPos = 0;
        float release = 0.999f, gain = 1.0f;

        void prepare (int len, float rel)
        {
            L = len;
            needs.assign ((size_t) L + 1, 1.0f);
            holds.assign ((size_t) L + 1, 1.0f);
            holdSum = (double) (L + 1);
            nPos = hPos = 0;
            release = rel;
            gain = 1.0f;
        }
        float push (float need)
        {
            needs[(size_t) nPos] = need;
            nPos = (nPos + 1) % (L + 1);
            float hold = 1.0f;
            for (float v : needs)
                hold = std::min (hold, v);
            holdSum += hold - holds[(size_t) hPos];
            holds[(size_t) hPos] = hold;
            hPos = (hPos + 1) % (L + 1);
            if (hPos == 0)
            {
                holdSum = 0.0;
                for (float v : holds)
                    holdSum += v;
            }
            const float ramp = (float) (holdSum / (L + 1));
            gain = ramp < gain ? ramp : ramp + (gain - ramp) * release;
            return gain;
        }
    };

    juce::AudioBuffer<float> delay;
    Smoother voice, music;
    int L = 64, dPos = 0;
    float ceiling = 0.89f, minGainSeen = 1.0f, minMusicSeen = 1.0f;
};
