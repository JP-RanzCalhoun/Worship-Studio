#include "Exporter.h"
#include "Library.h"
#include "signalsmith-stretch.h"
#include "Limiter.h"

using namespace juce;

String Exporter::render (const ExportRequest& req, std::function<bool (double)> progress)
{
    AudioFormatManager fm;
    fm.registerBasicFormats();

    std::vector<std::unique_ptr<AudioFormatReader>> readers;
    double rate = 0;
    int64 length = 0;
    for (auto& t : req.tracks)
    {
        readers.emplace_back (fm.createReaderFor (t.file));
        if (readers.back() == nullptr)
            return "Cannot read " + t.file.getFileName();
        // All parts of a song share one rate (the analysis resamples stems to the mix). Refuse anything else:
        // mixing rates would export at the wrong speed and length.
        if (rate > 0 && ! approximatelyEqual (rate, readers.back()->sampleRate))
            return "The parts of this song have different sample rates (" + t.file.getFileName() + "). Re-analyze the song, then export again.";
        rate = readers.back()->sampleRate;
        length = std::max (length, readers.back()->lengthInSamples);
    }
    if (readers.empty())
        return "Nothing to export: every track is muted.";

    const int64 start = (int64) (req.startSec * rate);
    const int64 end = req.endSec > 0 ? std::min (length, (int64) (req.endSec * rate)) : length;
    if (end <= start)
        return "Export range is empty.";
    const int64 inLen = end - start;

    // 1) Sum tracks (the full source range fits in memory for song-length material).
    AudioBuffer<float> mix (2, (int) inLen), tmp (2, 65536);
    mix.clear();
    for (size_t i = 0; i < readers.size(); ++i)
    {
        for (int64 pos = 0; pos < inLen; pos += tmp.getNumSamples())
        {
            const int n = (int) std::min<int64> (tmp.getNumSamples(), inLen - pos);
            readers[i]->read (tmp.getArrayOfWritePointers(), 2, start + pos, n);
            if (readers[i]->numChannels == 1)
                tmp.copyFrom (1, 0, tmp, 0, 0, n);
            for (int c = 0; c < 2; ++c)
                mix.addFrom (c, (int) pos, tmp, c, 0, n, req.tracks[i].gain);
        }
        if (progress && ! progress (0.4 * (double) (i + 1) / (double) readers.size()))
            return "Cancelled";
    }

    // 2) Optional tempo/pitch change (exact-length offline stretch).
    AudioBuffer<float> out;
    const bool stretchIt = std::abs (req.tempo - 1.0) > 1e-6 || std::abs (req.semitones) > 1e-6;
    if (stretchIt)
    {
        signalsmith::stretch::SignalsmithStretch<float> st;
        st.presetDefault (2, (float) rate);
        st.setTransposeSemitones ((float) req.semitones);
        const int outLen = (int) std::llround (inLen / req.tempo);
        out.setSize (2, outLen);
        st.exact (mix.getArrayOfReadPointers(), (int) inLen, out.getArrayOfWritePointers(), outLen);
    }
    else
    {
        std::swap (out, mix); // no copy: the summed source is the output
    }
    mix.setSize (0, 0); // free the source copy before the next steps (long songs)
    if (progress && ! progress (0.8))
        return "Cancelled";

    // 3) Optional click/cue sounds on their own bus, placed on the stretched timeline (as in playback).
    AudioBuffer<float> voices;
    if (! req.sounds.empty())
    {
        voices.setSize (2, out.getNumSamples());
        voices.clear();
    }
    for (auto& s : req.sounds)
    {
        std::unique_ptr<AudioFormatReader> r (fm.createReaderFor (s.file));
        if (r == nullptr)
            continue;
        AudioBuffer<float> snd (1, (int) r->lengthInSamples);
        r->read (snd.getArrayOfWritePointers(), 1, 0, snd.getNumSamples());
        const int at = (int) std::llround ((s.time - req.startSec) / req.tempo * rate);
        // simple rate match: sounds are rendered at 48 kHz, resample by index when needed
        const double step = r->sampleRate / rate;
        for (int i = 0; at + i < voices.getNumSamples(); ++i)
        {
            const int si = (int) (i * step);
            if (si >= snd.getNumSamples())
                break;
            if (at + i < 0)
                continue;
            const float v = snd.getSample (0, si) * s.gain;
            voices.addSample (0, at + i, v);
            voices.addSample (1, at + i, v);
        }
    }

    // 4) The same output stage as live playback: music limiter at -1.5 dBFS, click/cue bus with its own
    //    limiter, then the ducker (click down at most 6 dB, then a brief music dip) so the sum stays <= -1 dBFS.
    //    Processed in blocks, in place: the output lags the input by the stage's delay, so writes never
    //    overtake reads.
    out.applyGain (req.masterGain);
    float limitedDb = 0.0f;
    if (req.limit)
    {
        SafetyLimiter music, voiceLim;
        VoiceDucker ducker;
        music.prepare (rate, -1.5f);
        voiceLim.prepare (rate, -1.0f);
        ducker.prepare (rate, -1.0f);
        const int lat = music.latencySamples() + ducker.latencySamples();
        const int len = out.getNumSamples();
        constexpr int block = 4096;
        AudioBuffer<float> m (2, block), v (2, block);
        for (int pos = 0; pos < len + lat; pos += block)
        {
            const int n = std::min (block, len + lat - pos);
            const int have = std::clamp (len - pos, 0, n); // input left (zeros after the end flush the delay)
            m.clear();
            v.clear();
            for (int c = 0; c < 2; ++c)
            {
                if (have > 0)
                    m.copyFrom (c, 0, out, c, pos, have);
                if (have > 0 && voices.getNumSamples() > 0)
                    v.copyFrom (c, 0, voices, c, pos, have);
            }
            music.process (m.getWritePointer (0), m.getWritePointer (1), n);
            voiceLim.process (v.getWritePointer (0), v.getWritePointer (1), n);
            ducker.process (m.getWritePointer (0), m.getWritePointer (1), v.getReadPointer (0), v.getReadPointer (1), n);
            // m now holds the output for input positions pos - lat ... pos - lat + n
            const int dst = pos - lat, skip = std::max (0, -dst), count = std::min (n - skip, len - (dst + skip));
            if (count > 0)
                for (int c = 0; c < 2; ++c)
                    out.copyFrom (c, dst + skip, m, c, skip, count);
        }
        limitedDb = music.takeGainReductionDb();
    }
    else if (voices.getNumSamples() > 0)
    {
        for (int c = 0; c < 2; ++c)
            out.addFrom (c, 0, voices, c, 0, out.getNumSamples());
    }
    const float peak = out.getMagnitude (0, out.getNumSamples()); // every channel (this overload checks all)
    if (! Library::writeWav (req.output, out, rate, req.bits))
        return "Could not write " + req.output.getFullPathName();
    if (progress)
        progress (1.0);
    if (peak > 1.0f)
        return "WARNING: the export peaks at " + String (Decibels::gainToDecibels (peak), 1) + " dBFS and clips. Turn the safety limiter on or lower the levels.";
    if (limitedDb < -3.0f)
        return "WARNING: the safety limiter reduced peaks by up to " + String (-limitedDb, 1) + " dB. Lower the stem levels for a cleaner mix.";
    return {};
}
