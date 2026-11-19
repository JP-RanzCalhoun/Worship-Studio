#include "BrowserCapture.h"

#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <tlhelp32.h>
#include <wrl/implements.h>

#pragma comment(lib, "mmdevapi.lib")

using namespace juce;
using Microsoft::WRL::ComPtr;

namespace
{
/** Completion handler for ActivateAudioInterfaceAsync (must be agile: it is called on a worker thread). */
class ActivationHandler : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
                                                              Microsoft::WRL::FtmBase, IActivateAudioInterfaceCompletionHandler>
{
public:
    HANDLE done = CreateEventW (nullptr, TRUE, FALSE, nullptr);
    HRESULT result = E_FAIL;
    ComPtr<IAudioClient> client;

    ~ActivationHandler() override { CloseHandle (done); }

    STDMETHOD (ActivateCompleted) (IActivateAudioInterfaceAsyncOperation* op) override
    {
        HRESULT hrActivate = E_FAIL;
        ComPtr<IUnknown> unk;
        result = op->GetActivateResult (&hrActivate, &unk);
        if (SUCCEEDED (result))
            result = hrActivate;
        if (SUCCEEDED (result))
            result = unk.As (&client);
        SetEvent (done);
        return S_OK;
    }
};
} // namespace

BrowserCapture::BrowserCapture() : Thread ("browser-capture") {}

BrowserCapture::~BrowserCapture()
{
    stop();
}

uint32 BrowserCapture::findBrowserProcessId()
{
    // The WebView2 browser process ("msedgewebview2.exe") started by THIS app is a direct child of our process.
    // Its process tree holds the audio service that actually plays web audio. Every WebView of the app (main UI,
    // YouTube view, projector, chord-sheet window) uses the same user-data folder, so WebView2 runs exactly ONE
    // browser process for all of them, and the YouTube audio is always in its tree. If a second one ever appears
    // (another profile), we cannot tell which plays YouTube: refuse instead of capturing silence (audit, 2026-11-17).
    const DWORD self = GetCurrentProcessId();
    HANDLE snap = CreateToolhelp32Snapshot (TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE)
        return 0;
    PROCESSENTRY32W e { sizeof (e) };
    uint32 found = 0;
    int count = 0;
    for (BOOL ok = Process32FirstW (snap, &e); ok; ok = Process32NextW (snap, &e))
        if (e.th32ParentProcessID == self && _wcsicmp (e.szExeFile, L"msedgewebview2.exe") == 0)
        {
            found = e.th32ProcessID;
            ++count;
        }
    CloseHandle (snap);
    return count == 1 ? found : (count > 1 ? ambiguousBrowser : 0);
}

String BrowserCapture::start (const File& file)
{
    if (isRecording())
        return "Already recording.";
    browserPid = findBrowserProcessId();
    if (browserPid == ambiguousBrowser)
        return "The app has more than one browser process, so it cannot tell which one plays YouTube. Restart the app.";
    if (browserPid == 0)
        return "The built-in browser is not running. Open the Session screen first.";

    target = file;
    if (target != File())
    {
        target.getParentDirectory().createDirectory();
        target.deleteFile();
        std::unique_ptr<OutputStream> stream = std::make_unique<FileOutputStream> (target);
        WavAudioFormat wav;
        auto* w = wav.createWriterFor (stream, AudioFormatWriterOptions{}
                                                   .withSampleRate (sampleRate)
                                                   .withNumChannels (2)
                                                   .withBitsPerSample (16)
                                                   .withSampleFormat (AudioFormatWriterOptions::SampleFormat::integral))
                      .release();
        if (w == nullptr)
            return "Could not create the recording file.";
        writerThread.startThread();
        writer = std::make_unique<AudioFormatWriter::ThreadedWriter> (w, writerThread, sampleRate * 10); // 10 s buffer
    }
    if (tap != nullptr)
        tap->setSourceRate (sampleRate);

    framesWritten = 0;
    glitches = 0;
    gapFrames = 0;
    failed = false;
    {
        const ScopedLock sl (errorLock);
        threadError = failure = {};
    }
    started.reset();
    startThread (Priority::high);
    const bool signalled = started.wait (10000);
    String error;
    {
        const ScopedLock sl (errorLock);
        error = threadError;
    }
    if (! signalled && error.isEmpty())
        error = "Windows took too long to start the browser audio capture. Try again.";
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

String BrowserCapture::takeFailure()
{
    const ScopedLock sl (errorLock);
    auto f = failure;
    failure = {};
    return f;
}

double BrowserCapture::stop()
{
    // The capture thread never blocks on the disk (ThreadedWriter), so it ends within one wait (100 ms).
    if (isThreadRunning())
        stopThread (10000);
    writer.reset(); // writes what is still buffered, then the WAV header
    writerThread.stopThread (5000);
    return getSeconds();
}

void BrowserCapture::run()
{
    CoInitializeEx (nullptr, COINIT_MULTITHREADED);
    capture();
    CoUninitialize(); // after every COM object of capture() is released
}

void BrowserCapture::capture()
{
    auto fail = [this] (const String& why, HRESULT hr) {
        {
            const ScopedLock sl (errorLock);
            threadError = why + " (code 0x" + String::toHexString ((int) hr) + "). Process audio capture needs Windows 10 2004 or newer.";
        }
        started.signal();
    };
    auto stopWith = [this] (const String& why) {
        const ScopedLock sl (errorLock);
        failure = why;
        failed = true;
    };

    AUDIOCLIENT_ACTIVATION_PARAMS params {};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = browserPid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT pv {};
    pv.vt = VT_BLOB;
    pv.blob.cbSize = sizeof (params);
    pv.blob.pBlobData = reinterpret_cast<BYTE*> (&params);

    auto handler = Microsoft::WRL::Make<ActivationHandler>();
    ComPtr<IActivateAudioInterfaceAsyncOperation> op;
    HRESULT hr = ActivateAudioInterfaceAsync (VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof (IAudioClient), &pv, handler.Get(), &op);
    if (FAILED (hr))
        return fail ("Could not start browser audio capture", hr);
    WaitForSingleObject (handler->done, 8000);
    if (FAILED (handler->result) || handler->client == nullptr)
        return fail ("Windows refused browser audio capture", handler->result);

    // Process loopback delivers exactly the format we ask for: 48 kHz, stereo, 16-bit.
    WAVEFORMATEX fmt {};
    fmt.wFormatTag = WAVE_FORMAT_PCM;
    fmt.nChannels = 2;
    fmt.nSamplesPerSec = sampleRate;
    fmt.wBitsPerSample = 16;
    fmt.nBlockAlign = (WORD) (fmt.nChannels * fmt.wBitsPerSample / 8);
    fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;

    auto& client = handler->client;
    HANDLE ready = CreateEventW (nullptr, FALSE, FALSE, nullptr);
    hr = client->Initialize (AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                             200 * 10000 /* 200 ms */, 0, &fmt, nullptr);
    ComPtr<IAudioCaptureClient> captureClient;
    if (SUCCEEDED (hr))
        hr = client->SetEventHandle (ready);
    if (SUCCEEDED (hr))
        hr = client->GetService (IID_PPV_ARGS (&captureClient));
    if (SUCCEEDED (hr))
        hr = client->Start();
    if (FAILED (hr))
    {
        CloseHandle (ready);
        return fail ("Could not open browser audio", hr);
    }
    started.signal();

    AudioBuffer<float> buf (2, 48000);
    AudioBuffer<float> zeros (2, 4800);
    zeros.clear();
    int64 qpcFirst = -1; // 100 ns units; the first packet's time and frame count anchor the timeline
    while (! threadShouldExit() && ! failed.load())
    {
        if (WaitForSingleObject (ready, 100) != WAIT_OBJECT_0)
            continue;
        UINT32 packet = 0;
        for (;;)
        {
            hr = captureClient->GetNextPacketSize (&packet);
            if (FAILED (hr))
            {
                // The browser process ended or Windows invalidated the stream: stop and say so.
                stopWith ("The recording stopped because the browser sound stream ended (code 0x" + String::toHexString ((int) hr)
                          + "). What was recorded so far is kept.");
                break;
            }
            if (packet == 0)
                break;
            BYTE* data = nullptr;
            UINT32 frames = 0;
            DWORD flags = 0;
            UINT64 devPos = 0, qpc = 0;
            if (FAILED (hr = captureClient->GetBuffer (&data, &frames, &flags, &devPos, &qpc)))
            {
                stopWith ("The recording stopped: Windows could not read the browser sound (code 0x" + String::toHexString ((int) hr) + ").");
                break;
            }
            const int n = (int) jmin<UINT32> (frames, (UINT32) buf.getNumSamples());
            if (qpcFirst < 0)
                qpcFirst = (int64) qpc;
            else if ((flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0)
            {
                // Sound was lost (the PC was busy). Fill the gap with silence so everything after it stays at the
                // right time against the song (otherwise the rest of the recording would be early).
                ++glitches;
                const int64 expected = ((int64) qpc - qpcFirst) * sampleRate / 10'000'000;
                int64 gap = expected - framesWritten.load();
                // Capped at 5 s: the writer's buffer holds 10 s, and a longer gap is not a dropout but a stall.
                gap = jmin<int64> (gap, (int64) sampleRate * 5);
                if (gap > sampleRate / 1000)
                {
                    gapFrames += gap;
                    while (gap > 0)
                    {
                        const int z = (int) jmin<int64> (gap, zeros.getNumSamples());
                        if (writer != nullptr && ! writer->write (zeros.getArrayOfReadPointers(), z))
                            break;
                        framesWritten += z;
                        gap -= z;
                    }
                }
            }
            if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || data == nullptr)
                buf.clear (0, n);
            else
            {
                const auto* s = reinterpret_cast<const int16*> (data);
                float* l = buf.getWritePointer (0);
                float* r = buf.getWritePointer (1);
                for (int i = 0; i < n; ++i)
                {
                    l[i] = s[2 * i] / 32768.0f;
                    r[i] = s[2 * i + 1] / 32768.0f;
                }
            }
            captureClient->ReleaseBuffer (frames);
            if (tap != nullptr) // the app plays the page's sound itself (YouTube through the app)
                tap->push (buf.getArrayOfReadPointers(), 2, n);
            if (writer != nullptr && ! writer->write (buf.getArrayOfReadPointers(), n))
            {
                // The writer could not keep up for 10 s: the disk is full or very slow.
                stopWith ("The recording stopped: the disk is full or too slow. What was recorded so far is kept.");
                break;
            }
            framesWritten += n;
            const float pk = buf.getMagnitude (0, n);
            if (pk > peak.load())
                peak = pk;
        }
    }
    client->Stop();
    CloseHandle (ready);
}
