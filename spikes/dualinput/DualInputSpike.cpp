// Spike (M2b): can two USB audio inputs run at the same time, and how far do their clocks drift?
//
// Opens two WASAPI input devices independently (each with its own callback), runs them for N seconds,
// and compares the number of samples each delivers against the PC's high-resolution clock.
// Privacy: no audio is stored; only sample counts, timing and peak levels are kept.
//
// Usage: DualInputSpike "<device A name part>" "<device B name part>" [seconds]

#include <juce_audio_devices/juce_audio_devices.h>

using namespace juce;

struct Counter : public AudioIODeviceCallback
{
    std::atomic<int64> frames { 0 };
    std::atomic<int64> callbacks { 0 };
    std::atomic<float> peak { 0.0f };
    std::atomic<int> maxGapMs { 0 };
    double lastTicks = 0;

    void audioDeviceIOCallbackWithContext (const float* const* in, int numIn, float* const*, int, int n, const AudioIODeviceCallbackContext&) override
    {
        const double now = Time::getMillisecondCounterHiRes();
        if (lastTicks > 0)
            maxGapMs = jmax (maxGapMs.load(), (int) (now - lastTicks));
        lastTicks = now;
        frames += n;
        ++callbacks;
        for (int c = 0; c < numIn; ++c)
            if (in[c] != nullptr)
            {
                auto r = FloatVectorOperations::findMinAndMax (in[c], n);
                peak = jmax (peak.load(), std::abs (r.getStart()), std::abs (r.getEnd()));
            }
    }
    void audioDeviceAboutToStart (AudioIODevice*) override {}
    void audioDeviceStopped() override {}
};

int main (int argc, char* argv[])
{
    ScopedJuceInitialiser_GUI init;
    if (argc < 3)
    {
        std::cout << "usage: DualInputSpike <deviceA> <deviceB> [seconds]\n";
        return 1;
    }
    const String partA (argv[1]), partB (argv[2]);
    const int seconds = argc > 3 ? atoi (argv[3]) : 120;

    AudioDeviceManager dm;
    OwnedArray<AudioIODeviceType> types;
    dm.createAudioDeviceTypes (types);
    AudioIODeviceType* wasapi = nullptr;
    for (auto* t : types)
        if (t->getTypeName() == "Windows Audio")
            wasapi = t;
    if (wasapi == nullptr)
        return std::cout << "no WASAPI\n", 1;
    wasapi->scanForDevices();
    auto names = wasapi->getDeviceNames (true);
    auto find = [&] (const String& part) {
        for (auto& n : names)
            if (n.containsIgnoreCase (part))
                return n;
        return String();
    };
    const String nameA = find (partA), nameB = find (partB);
    std::cout << "inputs found:\n";
    for (auto& n : names)
        std::cout << "  " << n << "\n";
    if (nameA.isEmpty() || nameB.isEmpty())
        return std::cout << "device not found\n", 2;

    std::unique_ptr<AudioIODevice> devA (wasapi->createDevice ({}, nameA));
    std::unique_ptr<AudioIODevice> devB (wasapi->createDevice ({}, nameB));
    BigInteger chans;
    chans.setRange (0, 2, true);
    auto errA = devA->open (chans, {}, 48000.0, 480);
    auto errB = devB->open (chans, {}, 48000.0, 480);
    std::cout << "A: " << nameA << " -> " << (errA.isEmpty() ? "open" : errA) << ", " << devA->getCurrentSampleRate() << " Hz, buffer "
              << devA->getCurrentBufferSizeSamples() << ", " << devA->getCurrentBitDepth() << "-bit, ch " << devA->getActiveInputChannels().countNumberOfSetBits() << "\n";
    std::cout << "B: " << nameB << " -> " << (errB.isEmpty() ? "open" : errB) << ", " << devB->getCurrentSampleRate() << " Hz, buffer "
              << devB->getCurrentBufferSizeSamples() << ", " << devB->getCurrentBitDepth() << "-bit, ch " << devB->getActiveInputChannels().countNumberOfSetBits() << "\n";
    if (errA.isNotEmpty() || errB.isNotEmpty())
        return 3;

    Counter a, b;
    devA->start (&a);
    devB->start (&b);
    Thread::sleep (2000); // let both streams settle
    const int64 a0 = a.frames, b0 = b.frames;
    const double t0 = Time::getMillisecondCounterHiRes();
    std::cout << "\n  t(s)   A rate(Hz)    B rate(Hz)    A-B drift(ms)\n";
    for (int s = 10; s <= seconds; s += 10)
    {
        Thread::sleep (10000);
        const double el = (Time::getMillisecondCounterHiRes() - t0) / 1000.0;
        const double ra = (a.frames - a0) / el, rb = (b.frames - b0) / el;
        const double driftMs = ((a.frames - a0) / devA->getCurrentSampleRate() - (b.frames - b0) / devB->getCurrentSampleRate()) * 1000.0;
        std::printf ("%6.0f  %12.2f  %12.2f  %+10.2f\n", el, ra, rb, driftMs);
    }
    const double el = (Time::getMillisecondCounterHiRes() - t0) / 1000.0;
    const double ra = (a.frames - a0) / el, rb = (b.frames - b0) / el;
    std::printf ("\nA: %.3f Hz (%+.1f ppm vs nominal), max gap %d ms, peak %.3f\n", ra, (ra / devA->getCurrentSampleRate() - 1) * 1e6, a.maxGapMs.load(), a.peak.load());
    std::printf ("B: %.3f Hz (%+.1f ppm vs nominal), max gap %d ms, peak %.3f\n", rb, (rb / devB->getCurrentSampleRate() - 1) * 1e6, b.maxGapMs.load(), b.peak.load());
    std::printf ("A vs B: %+.1f ppm  ->  %.1f ms apart after a 5-minute song if not corrected\n", (ra / rb - 1) * 1e6, (ra / rb - 1) * 300000.0);
    devA->stop();
    devB->stop();
    return 0;
}
