#include "RecordSession.h"

using namespace juce;

var RecordSession::listInputs()
{
    Array<var> out;
    for (auto& [name, id] : InputTrack::listInputsWithIds())
    {
        DynamicObject::Ptr o = new DynamicObject();
        o->setProperty ("name", name);
        o->setProperty ("id", id); // what takes and monitors open (the name is for display)
        // Software devices that look like microphones but carry other sound (or none).
        static const char* virtualParts[] = { "Virtual", "CABLE", "Stereo Mix", "Steam Streaming", "Maono AI", "VoiceMeeter", "Voicemod" };
        for (auto* part : virtualParts)
            if (name.containsIgnoreCase (part))
                o->setProperty ("warning", "Virtual device: it is not a real microphone or instrument input.");
        if (name.containsIgnoreCase ("Iriun"))
            o->setProperty ("warning", "Phone over Wi-Fi: it can drop out. Use it as a spare only.");
        if (name.containsIgnoreCase ("SmartCam") || name.containsIgnoreCase ("Webcam") || name.containsIgnoreCase ("User Facing"))
            o->setProperty ("warning", "Webcam microphone: fine for a test, not for a take.");
        out.add (var (o.get()));
    }
    return out;
}

String RecordSession::start (const File& songDir, const Array<Track>& tracks, double takeStartSec)
{
    if (isRecording())
        return "Already recording.";
    if (tracks.isEmpty())
        return "Arm at least one input.";

    // About 1 MB per track per 10 s at 24-bit/48 kHz stereo: insist on a margin for a long take.
    // Checked before anything is created, so a refusal leaves no empty take folder behind.
    if (songDir.getBytesFreeOnVolume() < 500LL * 1024 * 1024)
        return "Less than 500 MB of free disk space. Free some space before recording.";

    // Next free take folder.
    auto takes = songDir.getChildFile ("takes");
    int n = 1;
    while (takes.getChildFile (String::formatted ("take-%03d", n)).exists())
        ++n;
    takeDir = takes.getChildFile (String::formatted ("take-%03d", n));
    if (! takeDir.getChildFile ("raw").createDirectory())
        return "Could not create the take folder.";

    Array<InputRecorder::Source> sources;
    for (auto& t : tracks)
        sources.add ({ t.device, takeDir.getChildFile ("raw").getChildFile (File::createLegalFileName (t.label) + ".wav") });
    armed = tracks;
    startSec = takeStartSec;
    clockQpc0 = -1;
    cn = csx = csy = csxx = csxy = lastX = lastY = firstX = 0;
    jumped = false;

    auto error = recorder.start (sources);
    if (error.isNotEmpty())
        takeDir.deleteRecursively();
    return error;
}

void RecordSession::addClockSample (int64 qpc100ns, double songSec, double tempo)
{
    if (clockQpc0 < 0)
        clockQpc0 = qpc100ns;
    const double x = (qpc100ns - clockQpc0) / 1.0e7;
    if (jumped || (cn > 0 && x <= lastX))
        return; // same engine block as last time, or after a jump
    // Jump = the song moved much more or less than the clock (scaled by the playback speed, with a margin
    // that grows with the gap between two readings).
    const double dx = x - lastX;
    if (cn > 0 && std::abs ((songSec - lastY) - dx * tempo) > 0.05 + 0.02 * dx)
    {
        // A jump right at the start is the song starting (Record pressed while playing, or a pair read just
        // before the first new block): start the fit again from here. A later jump ends the usable part.
        if (cn < 20 || lastX - firstX < 2.0)
        {
            cn = csx = csy = csxx = csxy = 0;
            firstX = x;
        }
        else
        {
            jumped = true;
            return;
        }
    }
    if (cn == 0)
        firstX = x;
    cn += 1;
    csx += x;
    csy += songSec;
    csxx += x * x;
    csxy += x * songSec;
    lastX = x;
    lastY = songSec;
}

double RecordSession::getSeconds() const
{
    auto* r = const_cast<InputRecorder&> (recorder).get (0);
    return r != nullptr && r->getSampleRate() > 0 ? r->getFrames() / (double) r->getSampleRate() : 0.0;
}

var RecordSession::takeMeters()
{
    Array<var> out;
    for (int i = 0; i < recorder.size(); ++i)
    {
        DynamicObject::Ptr o = new DynamicObject();
        o->setProperty ("label", armed[i].label);
        o->setProperty ("peak", recorder.get (i)->takePeak());
        out.add (var (o.get()));
    }
    return out;
}

void RecordSession::cancel()
{
    recorder.stop();
    if (takeDir != File())
        takeDir.deleteRecursively();
    takeDir = File();
}

var RecordSession::stopSolo (const var& calibration, double rate)
{
    auto stats = recorder.stop();
    DynamicObject::Ptr take = new DynamicObject();
    take->setProperty ("id", takeDir.getFileName());
    take->setProperty ("startSec", 0.0);
    take->setProperty ("solo", true);
    take->setProperty ("recordedAt", Time::getCurrentTime().toISO8601 (true));
    // Common start: when the last input began (every file has sound from there on). The QPC timestamps of each
    // input put them on one clock, so guitar and vocal line up without a song.
    int64 start = 0;
    for (auto& st : stats)
        start = jmax (start, st.firstQpc100ns);
    if (start == 0)
    {
        take->setProperty ("error", "Nothing was recorded.");
        takeDir.getChildFile ("take.json").replaceWithText (JSON::toString (var (take.get())));
        return var (take.get());
    }
    Array<var> tracks;
    int glitches = 0;
    for (int i = 0; i < stats.size(); ++i)
    {
        const auto& st = stats.getReference (i);
        const double cal = calibrationFor (calibration, st.device.isNotEmpty() ? st.device : armed[i].device);
        const auto label = File::createLegalFileName (armed[i].label);
        auto raw = takeDir.getChildFile ("raw").getChildFile (label + ".wav");
        auto aligned = takeDir.getChildFile (label + ".wav");
        auto cl = cleanupFor (armed[i].label);
        auto error = InputRecorder::alignTake (raw, st, start + (int64) std::llround (cal * 1.0e7), rate, rate, aligned, cl);
        DynamicObject::Ptr t = new DynamicObject();
        t->setProperty ("label", armed[i].label);
        t->setProperty ("device", st.device);
        t->setProperty ("file", aligned.getFileName());
        t->setProperty ("seconds", st.frames / (double) jmax (1, st.sampleRate));
        t->setProperty ("glitches", st.glitches);
        t->setProperty ("rawMode", st.rawMode);
        if (cl != nullptr && (cl->hum.load() || cl->gate.load()))
            t->setProperty ("cleanup", var (String (cl->hum.load() ? "hum filter " : "") + (cl->gate.load() ? "gate " + String (cl->thresholdDb.load(), 0) + " dB" : "")));
        if (error.isNotEmpty())
            t->setProperty ("error", error);
        glitches += st.glitches;
        tracks.add (var (t.get()));
    }
    take->setProperty ("tracks", tracks);
    if (glitches > 0)
        take->setProperty ("warning", "Some sound was lost during the take (the PC was busy). Gaps were filled with silence; listen before you keep it.");
    takeDir.getChildFile ("take.json").replaceWithText (JSON::toString (var (take.get())));
    return var (take.get());
}

std::shared_ptr<InputCleanup::Settings> RecordSession::cleanupFor (const String& label) const
{
    auto it = cleanup.find (label);
    return it != cleanup.end() ? it->second : nullptr;
}

double RecordSession::calibrationFor (const var& calibration, const String& device)
{
    if (calibration.isDouble() || calibration.isInt() || calibration.isInt64())
        return (double) calibration;
    if (auto* o = calibration.getDynamicObject())
        for (auto& p : o->getProperties())
            if (p.name.toString().isNotEmpty() && device.containsIgnoreCase (p.name.toString()))
                return (double) p.value;
    return 0.0;
}

var RecordSession::stop (double outputLatencySec, const var& calibration, double songRate)
{
    auto stats = recorder.stop();
    DynamicObject::Ptr take = new DynamicObject();
    take->setProperty ("id", takeDir.getFileName());
    take->setProperty ("startSec", startSec);
    take->setProperty ("recordedAt", Time::getCurrentTime().toISO8601 (true));

    // Song clock: QPC time at which song time T was heard = q0 + (T - b) / s (+ output latency).
    // Short spans: the slope is mostly jitter (a 6 s take fitted 90 ppm), so keep speed 1 and fit the offset only.
    double s = 1.0, b = cn > 0 ? (csy - csx) / cn : lastY - lastX;
    const double den = cn * csxx - csx * csx;
    if (cn >= 10 && den > 0 && lastX - firstX >= 20.0)
    {
        s = (cn * csxy - csx * csy) / den;
        b = (csy - s * csx) / cn;
    }
    if (cn == 0 || s <= 0.5 || s > 2.0)
    {
        take->setProperty ("error", "The song did not play during the take, so it cannot be lined up. The raw recording is kept.");
        takeDir.getChildFile ("take.json").replaceWithText (JSON::toString (var (take.get())));
        return var (take.get());
    }
    const double heardQpcSec = (startSec - b) / s + outputLatencySec;

    Array<var> tracks;
    int glitches = 0;
    for (int i = 0; i < stats.size(); ++i)
    {
        const auto& st = stats.getReference (i);
        // Each input has its own measured delay (USB and driver buffering the timestamps do not show).
        const double cal = calibrationFor (calibration, st.device.isNotEmpty() ? st.device : armed[i].device);
        const int64 startQpc = clockQpc0 + (int64) std::llround ((heardQpcSec + cal) * 1.0e7);
        const auto label = File::createLegalFileName (armed[i].label);
        auto raw = takeDir.getChildFile ("raw").getChildFile (label + ".wav");
        auto aligned = takeDir.getChildFile (label + ".wav");
        // Output sample k = song time startSec + k / rate; the song clock runs at s song-seconds per QPC second.
        // Written at the song's rate, so the take plays like a stem.
        const double rate = songRate > 0 ? songRate : (double) st.sampleRate;
        auto cl = cleanupFor (armed[i].label);
        auto error = InputRecorder::alignTake (raw, st, startQpc, rate * s, rate, aligned, cl);
        DynamicObject::Ptr t = new DynamicObject();
        t->setProperty ("label", armed[i].label);
        t->setProperty ("device", st.device);
        t->setProperty ("file", aligned.getFileName());
        t->setProperty ("seconds", st.frames / (double) jmax (1, st.sampleRate));
        t->setProperty ("glitches", st.glitches);
        t->setProperty ("gapMs", 1000.0 * st.gapFrames / jmax (1, st.sampleRate));
        t->setProperty ("ppm", (st.measuredRate() / jmax (1, st.sampleRate) - 1.0) * 1.0e6);
        t->setProperty ("rawMode", st.rawMode);
        if (cl != nullptr && (cl->hum.load() || cl->gate.load()))
            t->setProperty ("cleanup", var (String (cl->hum.load() ? "hum filter " : "") + (cl->gate.load() ? "gate " + String (cl->thresholdDb.load(), 0) + " dB" : "")));
        t->setProperty ("calibrationMs", cal * 1000.0);
        if (error.isNotEmpty())
            t->setProperty ("error", error);
        glitches += st.glitches;
        tracks.add (var (t.get()));
    }
    take->setProperty ("tracks", tracks);
    take->setProperty ("songClockPpm", (s - 1.0) * 1.0e6);
    take->setProperty ("outputLatencyMs", outputLatencySec * 1000.0);
    take->setProperty ("calibrated", ! calibration.isVoid() && ! calibration.isUndefined());
    if (jumped)
        take->setProperty ("warning", "The play position jumped during the take. It is lined up with the part before the jump.");
    if (glitches > 0)
        take->setProperty ("warning", "Some sound was lost during the take (the PC was busy). Gaps were filled with silence; listen before you keep it.");
    takeDir.getChildFile ("take.json").replaceWithText (JSON::toString (var (take.get())));
    return var (take.get());
}

var RecordSession::listTakes (const File& songDir, const File& currentTake)
{
    Array<var> out;
    auto dirs = songDir.getChildFile ("takes").findChildFiles (File::findDirectories, false, "take-*");
    dirs.sort();
    for (int i = dirs.size(); --i >= 0;)
    {
        auto info = JSON::parse (dirs[i].getChildFile ("take.json"));
        if (auto* o = info.getDynamicObject())
        {
            if (dirs[i].getChildFile ("video.mp4").getSize() > 0 || dirs[i].getChildFile ("video.webm").getSize() > 0)
                o->setProperty ("hasVideo", true); // the camera picture was recorded with this take
            out.add (info);
        }
        else if (dirs[i] != currentTake && dirs[i].getChildFile ("raw").findChildFiles (File::findFiles, false, "*.wav").size() > 0)
        {
            // No (readable) take.json: the app closed or crashed during the take. Show it, so it is not lost.
            DynamicObject::Ptr o = new DynamicObject();
            o->setProperty ("id", dirs[i].getFileName());
            o->setProperty ("startSec", 0.0);
            o->setProperty ("recordedAt", dirs[i].getCreationTime().toISO8601 (true));
            o->setProperty ("error", "This take was not finished (the app closed while recording). Its raw recordings are kept in the take folder.");
            out.add (var (o.get()));
        }
    }
    return out;
}
