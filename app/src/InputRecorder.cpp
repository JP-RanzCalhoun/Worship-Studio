#include "InputRecorder.h"

#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <ksmedia.h>
#include <wrl/client.h>

using namespace juce;
using Microsoft::WRL::ComPtr;

namespace
{
// PKEY_Device_FriendlyName (defined here to avoid the INITGUID dance).
const PROPERTYKEY friendlyNameKey { { 0xa45c254e, 0xdf1c, 0x4efd, { 0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0 } }, 14 };

String friendlyName (IMMDevice* d)
{
    ComPtr<IPropertyStore> props;
    if (FAILED (d->OpenPropertyStore (STGM_READ, &props)))
        return {};
    PROPVARIANT v;
    PropVariantInit (&v);
    String name;
    if (SUCCEEDED (props->GetValue (friendlyNameKey, &v)) && v.vt == VT_LPWSTR)
        name = String (v.pwszVal);
    PropVariantClear (&v);
    return name;
}

/** Windows' endpoint ID of a device ("{0.0.1.00000000}.{guid}"): stable, unique even for two identical mics. */
String endpointId (IMMDevice* d)
{
    LPWSTR id = nullptr;
    if (FAILED (d->GetId (&id)) || id == nullptr)
        return {};
    String s (id);
    CoTaskMemFree (id);
    return s;
}

/** Calls `fn (device, name)` for every active capture endpoint until it returns true. */
template <typename Fn> void forEachInput (Fn&& fn)
{
    ComPtr<IMMDeviceEnumerator> en;
    ComPtr<IMMDeviceCollection> all;
    if (FAILED (CoCreateInstance (__uuidof (MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS (&en)))
        || FAILED (en->EnumAudioEndpoints (eCapture, DEVICE_STATE_ACTIVE, &all)))
        return;
    UINT n = 0;
    all->GetCount (&n);
    for (UINT i = 0; i < n; ++i)
    {
        ComPtr<IMMDevice> d;
        if (SUCCEEDED (all->Item (i, &d)) && fn (d.Get(), friendlyName (d.Get())))
            return;
    }
}

enum class SampleKind { f32, i16, i24, i32 };
} // namespace

// ============================================================================ InputTrack

double InputTrack::Stats::measuredRate() const
{
    if (fitRate > 0)
        return fitRate;
    // Fallback: frames between the first and the last packet's first sample.
    const double secs = (lastQpc100ns - firstQpc100ns) / 1.0e7;
    const int64 span = frames - lastPacketFrames;
    return secs > 1.0 && span > 0 ? span / secs : (double) sampleRate;
}

var InputTrack::Stats::toVar() const
{
    DynamicObject::Ptr o = new DynamicObject();
    o->setProperty ("device", device);
    o->setProperty ("sampleRate", sampleRate);
    o->setProperty ("channels", channels);
    o->setProperty ("frames", frames);
    o->setProperty ("firstQpc100ns", firstQpc100ns);
    o->setProperty ("lastQpc100ns", lastQpc100ns);
    o->setProperty ("lastPacketFrames", lastPacketFrames);
    o->setProperty ("measuredRate", measuredRate());
    o->setProperty ("ppm", sampleRate > 0 ? (measuredRate() / sampleRate - 1.0) * 1.0e6 : 0.0);
    o->setProperty ("fitRate", fitRate);
    o->setProperty ("rawMode", rawMode);
    o->setProperty ("glitches", glitches);
    o->setProperty ("gapFrames", gapFrames);
    Array<var> gaps;
    for (int i = 0; i < gapAt.size(); ++i)
        gaps.add (Array<var> { (double) gapAt[i] / jmax (1, sampleRate), 1000.0 * (double) gapLen[i] / jmax (1, sampleRate) });
    o->setProperty ("gaps", gaps); // [seconds into the take, ms lost]
    o->setProperty ("overruns", overruns);
    return var (o.get());
}

InputTrack::InputTrack() : Thread ("input-track") {}

InputTrack::~InputTrack()
{
    stop();
}

StringArray InputTrack::listInputs()
{
    StringArray names;
    for (auto& [name, id] : listInputsWithIds())
        names.add (name);
    return names;
}

std::vector<std::pair<String, String>> InputTrack::listInputsWithIds()
{
    std::vector<std::pair<String, String>> out;
    const HRESULT init = CoInitializeEx (nullptr, COINIT_MULTITHREADED); // fails harmlessly if COM is already set up
    forEachInput ([&] (IMMDevice* d, const String& name) {
        out.emplace_back (name, endpointId (d));
        return false;
    });
    if (SUCCEEDED (init))
        CoUninitialize();
    return out;
}

String InputTrack::start (const String& deviceNamePart, const File& file)
{
    if (isRecording())
        return "Already recording.";
    namePart = deviceNamePart;
    target = file;
    stats = {};
    frames = 0;
    {
        const ScopedLock sl (errorLock);
        threadError = {};
    }
    started.reset();
    startThread (Priority::highest);
    const bool signalled = started.wait (10000);
    String error;
    {
        const ScopedLock sl (errorLock);
        error = threadError;
    }
    if (error.isEmpty() && ! signalled)
        error = "The input took too long to start. Unplug it, plug it in again, and retry.";
    if (error.isEmpty() && ! isThreadRunning())
        error = "The input did not start.";
    if (error.isNotEmpty())
    {
        signalThreadShouldExit();
        stopThread (10000);
        writer.reset();
        writerThread.stopThread (2000);
        if (target != File())
            target.deleteFile();
        return error;
    }
    return {};
}

InputTrack::Stats InputTrack::stop()
{
    if (isThreadRunning())
        stopThread (3000);
    writer.reset(); // flushes what is buffered, then closes the WAV
    writerThread.stopThread (3000);
    stats.frames = frames.load();
    if (target != File() && target.existsAsFile())
        target.withFileExtension ("json").replaceWithText (JSON::toString (stats.toVar()));
    return stats;
}

void InputTrack::run()
{
    CoInitializeEx (nullptr, COINIT_MULTITHREADED);
    captureLoop();
    CoUninitialize(); // after every COM object of captureLoop() is released
}

void InputTrack::captureLoop()
{
    auto fail = [this] (const String& why, HRESULT hr) {
        {
            const ScopedLock sl (errorLock);
            threadError = why + (hr != S_OK ? " (code 0x" + String::toHexString ((int) hr) + ")" : String());
        }
        started.signal();
    };

    // Which input: by Windows endpoint ID (exact, unique), else by exact name, else by a name part that matches
    // only one input. A part that matches two inputs is refused: never record from the wrong device (audit AUD-01).
    ComPtr<IMMDevice> device, byPart;
    String byPartName;
    int partMatches = 0;
    const bool isId = namePart.startsWith ("{");
    forEachInput ([&] (IMMDevice* d, const String& name) {
        if (isId ? endpointId (d) == namePart : name == namePart)
        {
            device = d;
            stats.device = name;
            return true;
        }
        if (! isId && name.containsIgnoreCase (namePart))
        {
            ++partMatches;
            byPart = d;
            byPartName = name;
        }
        return false;
    });
    if (device == nullptr && partMatches == 1)
    {
        device = byPart;
        stats.device = byPartName;
    }
    if (device == nullptr && partMatches > 1)
        return fail ("More than one input matches \"" + namePart + "\". Choose the input again in the list.", S_OK);
    if (device == nullptr)
        return fail (isId ? String ("The chosen input is not connected. Plug it in, then press Inputs to refresh.")
                          : "Input \"" + namePart + "\" was not found. Is it plugged in?",
                     S_OK);

    ComPtr<IAudioClient> client;
    HRESULT hr = device->Activate (__uuidof (IAudioClient), CLSCTX_ALL, nullptr, &client);
    if (FAILED (hr))
        return fail ("Could not open " + stats.device, hr);

    // Shared mode uses the device's own format (set in Windows Sound settings); we convert to float.
    WAVEFORMATEX* mix = nullptr;
    if (FAILED (hr = client->GetMixFormat (&mix)))
        return fail ("Could not read the format of " + stats.device, hr);
    stats.sampleRate = (int) mix->nSamplesPerSec;
    stats.channels = mix->nChannels;
    bool isFloat = mix->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
    if (mix->wFormatTag == WAVE_FORMAT_EXTENSIBLE)
        isFloat = reinterpret_cast<WAVEFORMATEXTENSIBLE*> (mix)->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    const SampleKind kind = isFloat ? SampleKind::f32
                          : mix->wBitsPerSample == 16 ? SampleKind::i16
                          : mix->wBitsPerSample == 24 ? SampleKind::i24
                                                      : SampleKind::i32;
    if (isFloat && mix->wBitsPerSample != 32)
    {
        CoTaskMemFree (mix);
        return fail ("Unsupported format on " + stats.device, S_OK);
    }

    // Dry takes: ask for the raw stream, without Windows/vendor effects (noise suppression, voice gating, AGC).
    // Not every driver supports it; then the stream stays in default mode and the take is marked.
    {
        ComPtr<IAudioClient2> client2;
        if (SUCCEEDED (client.As (&client2)))
        {
            AudioClientProperties props {};
            props.cbSize = sizeof (props);
            props.eCategory = AudioCategory_Other;
            props.Options = AUDCLNT_STREAMOPTIONS_RAW;
            stats.rawMode = SUCCEEDED (client2->SetClientProperties (&props));
        }
    }

    HANDLE ready = CreateEventW (nullptr, FALSE, FALSE, nullptr);
    // Live monitoring: ask Windows for its smallest shared-mode period (smaller packets = less delay).
    // Recordings keep the normal period (their timing does not depend on it).
    bool initialised = false;
    if (lowLatency)
    {
        ComPtr<IAudioClient3> client3;
        UINT32 defP = 0, fundP = 0, minP = 0, maxP = 0;
        if (SUCCEEDED (client.As (&client3)) && SUCCEEDED (client3->GetSharedModeEnginePeriod (mix, &defP, &fundP, &minP, &maxP))
            && minP > 0 && minP < defP)
        {
            hr = client3->InitializeSharedAudioStream (AUDCLNT_STREAMFLAGS_EVENTCALLBACK, minP, mix, nullptr);
            initialised = SUCCEEDED (hr);
            if (initialised)
                stats.periodFrames = (int) minP;
        }
    }
    if (! initialised)
        hr = client->Initialize (AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 100 * 10000 /* 100 ms */, 0, mix, nullptr);
    CoTaskMemFree (mix);
    ComPtr<IAudioCaptureClient> capture;
    if (SUCCEEDED (hr))
        hr = client->SetEventHandle (ready);
    if (SUCCEEDED (hr))
        hr = client->GetService (IID_PPV_ARGS (&capture));
    if (FAILED (hr))
    {
        CloseHandle (ready);
        return fail ("Could not start " + stats.device, hr);
    }

    // 24-bit WAV, the device's own rate and channel count.
    if (target != File())
    {
        target.getParentDirectory().createDirectory();
        target.deleteFile();
        std::unique_ptr<OutputStream> stream = std::make_unique<FileOutputStream> (target);
        WavAudioFormat wav;
        auto* w = wav.createWriterFor (stream, AudioFormatWriterOptions{}
                                                   .withSampleRate (stats.sampleRate)
                                                   .withNumChannels (stats.channels)
                                                   .withBitsPerSample (24)
                                                   .withSampleFormat (AudioFormatWriterOptions::SampleFormat::integral))
                      .release();
        if (w == nullptr)
        {
            CloseHandle (ready);
            return fail ("Could not create the recording file.", S_OK);
        }
        writerThread.startThread();
        writer = std::make_unique<AudioFormatWriter::ThreadedWriter> (w, writerThread, stats.sampleRate * 5);
    }

    if (FAILED (hr = client->Start()))
    {
        CloseHandle (ready);
        return fail ("Could not start " + stats.device, hr);
    }
    if (tap != nullptr)
        tap->setSourceRate (stats.sampleRate);
    started.signal();

    const int ch = stats.channels;
    AudioBuffer<float> buf (ch, stats.sampleRate); // 1 s: far more than one packet
    AudioBuffer<float> clean (ch, stats.sampleRate);
    InputCleanup cleaner (cleanupSettings);
    const int bytesPerSample = kind == SampleKind::i16 ? 2 : kind == SampleKind::i24 ? 3 : 4;
    // Timing: x = device position (frames since the first packet), y = QPC (100 ns since the first packet).
    // A least-squares line through all packets after the first second gives the true rate and start time;
    // single timestamps jitter and the first packets of a stream are often late or bunched.
    int64 dev0 = -1, qpc0 = 0, expectNext = 0;
    double fn = 0, fsx = 0, fsy = 0, fsxx = 0, fsxy = 0;
    AudioBuffer<float> zeros (ch, 4096);
    zeros.clear();
    while (! threadShouldExit())
    {
        if (WaitForSingleObject (ready, 200) != WAIT_OBJECT_0)
            continue;
        UINT32 packet = 0;
        while (SUCCEEDED (capture->GetNextPacketSize (&packet)) && packet > 0)
        {
            BYTE* data = nullptr;
            UINT32 got = 0;
            DWORD flags = 0;
            UINT64 devPos = 0, qpc = 0;
            if (FAILED (capture->GetBuffer (&data, &got, &flags, &devPos, &qpc)))
                break;
            const int n = (int) jmin<UINT32> (got, (UINT32) buf.getNumSamples());
            if ((flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0 && frames.load() > 0)
                ++stats.glitches;
            if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || data == nullptr)
                buf.clear (0, n);
            else
                for (int c = 0; c < ch; ++c)
                {
                    float* dst = buf.getWritePointer (c);
                    const BYTE* src = data + c * bytesPerSample;
                    const int stride = ch * bytesPerSample;
                    for (int i = 0; i < n; ++i, src += stride)
                        switch (kind)
                        {
                            case SampleKind::f32: dst[i] = *reinterpret_cast<const float*> (src); break;
                            case SampleKind::i16: dst[i] = *reinterpret_cast<const int16*> (src) / 32768.0f; break;
                            case SampleKind::i24: dst[i] = (int32) ((uint32) src[0] << 8 | (uint32) src[1] << 16 | (uint32) src[2] << 24) / 2147483648.0f; break;
                            case SampleKind::i32: dst[i] = *reinterpret_cast<const int32*> (src) / 2147483648.0f; break;
                        }
                }
            capture->ReleaseBuffer (got);
            if (tap != nullptr) // live monitoring: hand the packet on before anything slower happens
            {
                if (cleanupSettings != nullptr) // also measures the level for "Learn noise"
                {
                    // hum filter / gate on what you hear; a copy, so a recording stream's file stays dry
                    clean.setSize (ch, n, false, false, true);
                    for (int c = 0; c < ch; ++c)
                        clean.copyFrom (c, 0, buf, c, 0, n);
                    cleaner.process (clean.getArrayOfWritePointers(), ch, n, stats.sampleRate);
                    tap->push (clean.getArrayOfReadPointers(), ch, n);
                }
                else
                    tap->push (buf.getArrayOfReadPointers(), ch, n);
            }

            if (dev0 < 0)
            {
                dev0 = (int64) devPos;
                qpc0 = (int64) qpc;
                expectNext = dev0;
                stats.firstQpc100ns = qpc0;
            }
            // Lost samples (the device position jumped): write silence so later audio stays at the right time.
            // A packet with a timestamp error has no trustworthy position or time: keep its audio, skip the timing.
            const bool badTime = (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) != 0;
            const int64 gap = badTime ? 0 : (int64) devPos - expectNext;
            if (gap >= (int64) stats.sampleRate * 30)
                ++stats.glitches; // a pause this long is not filled (the device stopped); counted so the take is flagged
            else if (gap > 0)
            {
                // Streams often skip a few ms while they start (seen on every device in the first 0.25 s, before any
                // music): fill those too, but only report gaps after the first half second as lost sound.
                if (frames.load() >= stats.sampleRate / 2)
                {
                    ++stats.glitches;
                    stats.gapFrames += (int) gap;
                }
                if (stats.gapAt.size() < 10)
                {
                    stats.gapAt.add (frames.load());
                    stats.gapLen.add (gap);
                }
                for (int64 left = gap; left > 0;)
                {
                    const int z = (int) jmin<int64> (left, zeros.getNumSamples());
                    if (writer != nullptr && ! writer->write (zeros.getArrayOfReadPointers(), z))
                        ++stats.overruns;
                    frames += z;
                    left -= z;
                }
            }
            expectNext = badTime ? expectNext + got : (int64) devPos + got;
            const double x = (double) ((int64) devPos - dev0), y = (double) ((int64) qpc - qpc0);
            if (! badTime && x >= stats.sampleRate)
            {
                fn += 1;
                fsx += x;
                fsy += y;
                fsxx += x * x;
                fsxy += x * y;
            }
            stats.lastQpc100ns = (int64) qpc;
            stats.lastPacketFrames = n;
            if (writer != nullptr && ! writer->write (buf.getArrayOfReadPointers(), n))
                ++stats.overruns;
            frames += n;
            const float pk = buf.getMagnitude (0, n);
            if (pk > peak.load())
                peak = pk;
        }
    }
    client->Stop();
    CloseHandle (ready);

    // Fit y = a + b x: rate = 1e7 / b; the first sample's true time = qpc0 + a.
    const double den = fn * fsxx - fsx * fsx;
    if (fn >= 50 && den > 0)
    {
        const double slope = (fn * fsxy - fsx * fsy) / den;
        const double icpt = (fsy - slope * fsx) / fn;
        if (slope > 0)
        {
            stats.fitRate = 1.0e7 / slope;
            stats.firstQpc100ns = qpc0 + (int64) std::llround (icpt);
        }
    }
}

// ============================================================================ InputRecorder

String InputRecorder::start (const Array<Source>& sources)
{
    if (isRecording())
        return "Already recording.";
    tracks.clear();
    for (auto& s : sources)
    {
        auto* t = tracks.add (new InputTrack());
        auto error = t->start (s.deviceNamePart, s.file);
        if (error.isNotEmpty())
        {
            stop();
            for (auto& x : sources)
                if (x.file != File())
                    x.file.deleteFile(), x.file.withFileExtension ("json").deleteFile();
            tracks.clear();
            return error;
        }
    }
    return {};
}

Array<InputTrack::Stats> InputRecorder::stop()
{
    Array<InputTrack::Stats> all;
    for (auto* t : tracks)
        all.add (t->stop());
    return all;
}

bool InputRecorder::isRecording() const
{
    for (auto* t : tracks)
        if (t->isRecording())
            return true;
    return false;
}

String InputRecorder::alignTake (const File& in, const InputTrack::Stats& stats, int64 startQpc100ns, double targetRate, double fileRate,
                                 const File& out, std::shared_ptr<InputCleanup::Settings> cleanupSettings)
{
    InputCleanup cleaner (cleanupSettings); // hum filter / gate on the lined-up take (the raw file stays dry)
    AudioFormatManager fm;
    fm.registerBasicFormats();
    std::unique_ptr<AudioFormatReader> reader (fm.createReaderFor (in));
    if (reader == nullptr)
        return "Could not read " + in.getFileName();
    const int ch = (int) reader->numChannels;
    const double rate = stats.measuredRate();
    const double ratio = rate / targetRate; // input samples per output sample

    // Where output sample 0 falls in the input (in input samples). Negative = the input started later.
    const double startIn = (startQpc100ns - stats.firstQpc100ns) / 1.0e7 * rate;
    const int64 lead = startIn < 0 ? (int64) std::llround (-startIn / ratio) : 0; // output samples of silence first
    int64 pos = startIn > 0 ? (int64) std::llround (startIn) : 0;                // first input sample used
    const int64 total = lead + (int64) ((reader->lengthInSamples - pos) / ratio);
    // The sinc filter delays its output by L input samples (measured: an impulse at 300 comes out at 400)
    // and starts with a silent history. Start reading L earlier and throw away the first 2L/ratio outputs:
    // the history then holds real samples and the next output lines up exactly with input sample `pos`.
    const int L = (int) std::ceil (WindowedSincInterpolator::getBaseLatency());
    pos -= L;
    const int warmUp = (int) std::llround (2 * L / ratio);

    out.deleteFile();
    std::unique_ptr<OutputStream> stream = std::make_unique<FileOutputStream> (out);
    WavAudioFormat wav;
    std::unique_ptr<AudioFormatWriter> writer (wav.createWriterFor (stream, AudioFormatWriterOptions{}
                                                                               .withSampleRate (fileRate)
                                                                               .withNumChannels (ch)
                                                                               .withBitsPerSample (24)
                                                                               .withSampleFormat (AudioFormatWriterOptions::SampleFormat::integral)));
    if (writer == nullptr)
        return "Could not create " + out.getFileName();

    constexpr int block = 8192;
    AudioBuffer<float> outBuf (ch, block);
    outBuf.clear();
    for (int64 done = 0; done < lead; done += block)
        writer->writeFromAudioSampleBuffer (outBuf, 0, (int) jmin<int64> (block, lead - done));

    std::vector<WindowedSincInterpolator> interp ((size_t) ch);
    const int inNeed = (int) std::ceil (block * ratio) + 64;
    AudioBuffer<float> inBuf (ch, inNeed);
    {
        reader->read (&inBuf, 0, inNeed, pos, true, true);
        int used = 0;
        for (int c = 0; c < ch; ++c)
            used = interp[(size_t) c].process (ratio, inBuf.getReadPointer (c), outBuf.getWritePointer (c), warmUp);
        pos += used;
    }
    for (int64 done = lead; done < total;)
    {
        const int n = (int) jmin<int64> (block, total - done);
        reader->read (&inBuf, 0, inNeed, pos, true, true); // zero-filled past the end
        int used = 0;
        for (int c = 0; c < ch; ++c)
            used = interp[(size_t) c].process (ratio, inBuf.getReadPointer (c), outBuf.getWritePointer (c), n);
        cleaner.process (outBuf.getArrayOfWritePointers(), ch, n, fileRate);
        writer->writeFromAudioSampleBuffer (outBuf, 0, n);
        pos += used;
        done += n;
    }
    return {};
}
