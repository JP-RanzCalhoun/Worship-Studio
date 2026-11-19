#pragma once

#include <juce_core/juce_core.h>
#include <atomic>
#include <cmath>
#include <vector>

/**
 * Live monitoring of one input (e.g. the guitar on the E2 Gen2) through another device's output
 * (e.g. the PD200X headphones). Software monitoring: what you hear is a little late, the recorded take
 * is not affected (takes stay dry and are lined up after the take).
 *
 * The input runs on its own clock and the output on another: a single-producer / single-consumer ring
 * (the input's capture thread writes, the engine's audio thread reads) with a small adaptive resampler that
 * keeps the ring at its target fill. That absorbs the few-ppm drift between the two USB clocks without
 * clicks, and keeps the delay constant.
 *
 * Frames are stereo: a mono input (guitar, vocal) is centred; a stereo source (the YouTube page) keeps its sides.
 */
class MonitorTap
{
public:
    explicit MonitorTap (int capacityFrames = 1 << 16) : ring ((size_t) capacityFrames * 2), cap (capacityFrames) {}

    void setSourceRate (double r) { srcRate.store (r); }
    double getSourceRate() const { return srcRate.load(); }

    /** Capture thread: one packet. Two channels stay left/right; any other count is mixed to mono (centred). */
    void push (const float* const* ch, int numCh, int n)
    {
        if (numCh <= 0 || n <= 0)
            return;
        const juce::int64 w = writeCount.load (std::memory_order_relaxed);
        const juce::int64 r = readCount.load (std::memory_order_acquire);
        const juce::int64 free = cap - 1 - (w - r);
        if (n > free)
        {
            overflows.fetch_add (1, std::memory_order_relaxed);
            n = (int) juce::jmax<juce::int64> (0, free);
        }
        const float k = 1.0f / (float) numCh;
        for (int i = 0; i < n; ++i)
        {
            const auto at = (size_t) ((w + i) % cap) * 2;
            if (numCh == 2)
            {
                ring[at] = ch[0][i];
                ring[at + 1] = ch[1][i];
            }
            else
            {
                float s = 0;
                for (int c = 0; c < numCh; ++c)
                    s += ch[c][i];
                ring[at] = ring[at + 1] = s * k;
            }
        }
        lastPacket.store (n, std::memory_order_relaxed);
        writeCount.store (w + n, std::memory_order_release);
    }

    /** Level of this input in the monitor (0..2), set from any thread. */
    void setGain (float g) { gain.store (g); }

    /**
     * Audio thread: `n` samples at `deviceRate`, added to `outL` / `outR` (times the gain).
     * The smallest safe delay: the input arrives in packets and the output takes whole blocks, so the ring must
     * hold one output block plus half an input packet (on average) plus a small margin. The margin starts at 1 ms
     * and grows by 1 ms each time the ring runs dry (max 10 ms): as little delay as this PC can do without breaks.
     * Starts only when the target is there; after running dry waits for it again (a short gap, not a stutter).
     */
    void pullAdd (float* outL, float* outR, int n, double deviceRate)
    {
        const double sr = srcRate.load();
        if (sr <= 0 || deviceRate <= 0)
            return;
        const float g = gain.load();
        const juce::int64 w = writeCount.load (std::memory_order_acquire);
        const double target = n * sr / deviceRate + 0.5 * lastPacket.load (std::memory_order_relaxed) + margin * sr;
        double avail = (double) w - readPos;

        if (! primed)
        {
            if (avail < target)
                return;
            readPos = (double) w - target; // start with exactly the target delay (drop anything older)
            avail = target;
            fill = target;
            primed = true;
        }
        // Behind by more than 40 ms (the output device stalled): jump back to the target. The drift control alone
        // drains only ~3 ms per second, so after a stall the delay would stay high for a long time (2026-11-17: 150 ms).
        if (avail > target + sr * 0.04)
        {
            readPos = (double) w - target;
            avail = target;
            fill = target;
            resyncs.fetch_add (1, std::memory_order_relaxed);
        }

        played += n;
        // Clock drift: a smoothed fill error steers the read speed by at most +-0.3 %.
        fill += 0.02 * (avail - fill);
        const double err = (fill - target) / target;
        const double ratio = sr / deviceRate * (1.0 + juce::jlimit (-0.003, 0.003, 0.002 * err));

        for (int i = 0; i < n; ++i)
        {
            const double idx = std::floor (readPos);
            if (idx + 1 >= (double) w) // ran dry: next time keep 1 ms more
            {
                underruns.fetch_add (1, std::memory_order_relaxed);
                // Not in the first 3 s: devices starting up stutter once or twice, which says nothing about later
                // (2026-11-17: start-up drops had grown the delay by 3-4 ms for good).
                if (played > deviceRate * 3.0)
                {
                    margin = juce::jmin (0.010, margin + 0.001);
                    lateUnderruns.fetch_add (1, std::memory_order_relaxed);
                }
                primed = false;
                break;
            }
            const float frac = (float) (readPos - idx);
            const auto j = (juce::int64) idx;
            const auto a = (size_t) (j % cap) * 2, b = (size_t) ((j + 1) % cap) * 2;
            outL[i] += g * (ring[a] + frac * (ring[b] - ring[a]));
            outR[i] += g * (ring[a + 1] + frac * (ring[b + 1] - ring[a + 1]));
            readPos += ratio;
        }
        fillShared.store (fill / sr, std::memory_order_relaxed);
        readCount.store ((juce::int64) std::floor (readPos), std::memory_order_release);
    }

    /** Seconds of input waiting in the ring (the buffer part of the monitoring delay). */
    double getFillSeconds() const { return fillShared.load(); }
    double getPacketSeconds() const { const double sr = srcRate.load(); return sr > 0 ? lastPacket.load() / sr : 0; }
    int getUnderruns() const { return underruns.load(); }
    /** Dropouts after the first 3 s (start-up stutter not counted): the ones a player would notice. */
    int getLateUnderruns() const { return lateUnderruns.load(); }
    int getOverflows() const { return overflows.load(); }
    int getResyncs() const { return resyncs.load(); }

private:
    std::vector<float> ring;
    const juce::int64 cap;
    std::atomic<double> srcRate { 0 };
    std::atomic<juce::int64> writeCount { 0 }, readCount { 0 };
    std::atomic<int> lastPacket { 480 };
    std::atomic<int> underruns { 0 }, overflows { 0 }, resyncs { 0 }, lateUnderruns { 0 };
    std::atomic<double> fillShared { 0 };
    std::atomic<float> gain { 1.0f };
    // audio thread only
    double readPos = 0, fill = 0, margin = 0.001;
    double played = 0; // device samples played since the first start (start-up grace)
    bool primed = false;
};
