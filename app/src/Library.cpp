#include "Library.h"

using namespace juce;

namespace
{
String slug (const String& s)
{
    String out;
    for (auto c : s.toLowerCase())
        out << (CharacterFunctions::isLetterOrDigit (c) ? String::charToString (c) : String ("-"));
    while (out.contains ("--"))
        out = out.replace ("--", "-");
    return out.trimCharactersAtStart ("-").trimCharactersAtEnd ("-").substring (0, 48);
}

bool replaceFileText (const File& f, const String& text)
{
    // Write to a temp file first so a crash never leaves a half-written project file.
    TemporaryFile tmp (f);
    if (! tmp.getFile().replaceWithText (text, false, false, "\n"))
        return false;
    return tmp.overwriteTargetFileWithTemporary();
}
} // namespace

Library::Library()
{
    formats.registerBasicFormats();
    root = File::getSpecialLocation (File::userDocumentsDirectory).getChildFile ("WorshipStudio").getChildFile ("Songs");
    root.createDirectory();
}

File Library::songDir (const String& id) const
{
    // ids are our own slugs; refuse anything that could escape the library folder
    if (id.isEmpty() || id.containsAnyOf ("/\\:.") )
        return {};
    return root.getChildFile (id);
}

var Library::listSongs() const
{
    Array<var> songs;
    for (auto& dir : root.findChildFiles (File::findDirectories, false))
    {
        auto json = JSON::parse (dir.getChildFile ("song.json"));
        if (! json.isObject())
            continue;
        DynamicObject::Ptr o = new DynamicObject();
        o->setProperty ("id", dir.getFileName());
        o->setProperty ("title", json["title"]);
        o->setProperty ("artist", json["artist"]);
        auto key = json["key"];
        if (key.isVoid() || key.toString().isEmpty())
            key = JSON::parse (dir.getChildFile ("analysis.json"))["key"]["name"];
        o->setProperty ("key", key);
        o->setProperty ("analyzed", dir.getChildFile ("analysis.json").existsAsFile());
        if (json["referenceUrl"].toString().isNotEmpty())
            o->setProperty ("referenceUrl", json["referenceUrl"]); // a video this song was learned from
        o->setProperty ("modified", dir.getChildFile ("song.json").getLastModificationTime().toMilliseconds());
        songs.add (var (o.get()));
    }
    return songs;
}

bool Library::writeWav (const File& f, const AudioBuffer<float>& buf, double rate, int bits)
{
    TemporaryFile tmp (f);
    if (! writeWavTo (tmp.getFile(), buf, rate, bits))
        return false;
    return tmp.overwriteTargetFileWithTemporary();
}

bool Library::writeWavTo (const File& f, const AudioBuffer<float>& buf, double rate, int bits)
{
    std::unique_ptr<OutputStream> stream = std::make_unique<FileOutputStream> (f);
    if (static_cast<FileOutputStream*> (stream.get())->failedToOpen())
        return false;
    WavAudioFormat wav;
    auto opts = AudioFormatWriterOptions{}
                    .withSampleRate (rate)
                    .withNumChannels (buf.getNumChannels())
                    .withBitsPerSample (bits)
                    .withSampleFormat (bits == 32 ? AudioFormatWriterOptions::SampleFormat::floatingPoint
                                                  : AudioFormatWriterOptions::SampleFormat::integral);
    auto writer = wav.createWriterFor (stream, opts);
    return writer != nullptr && writer->writeFromAudioSampleBuffer (buf, 0, buf.getNumSamples());
}

String Library::importSong (const File& source, std::function<void (double)> onProgress)
{
    std::unique_ptr<AudioFormatReader> reader (formats.createReaderFor (source));
    if (reader == nullptr)
        throw String ("This file type cannot be read: " + source.getFileName());

    const String title = source.getFileNameWithoutExtension();
    String id = slug (title);
    if (id.isEmpty())
        id = "song";
    for (int i = 2; root.getChildFile (id).exists(); ++i)
        id = slug (title) + "-" + String (i);
    auto dir = root.getChildFile (id);
    dir.getChildFile ("source").createDirectory();
    // Remove the half-made folder if anything below fails.
    struct Cleanup { File d; bool keep = false; ~Cleanup() { if (! keep) d.deleteRecursively(); } } cleanup { dir };

    // Keep the original file untouched.
    if (! source.copyFileTo (dir.getChildFile ("source").getChildFile (source.getFileName())))
        throw String ("Could not copy the song into " + dir.getFullPathName() + ". Is the disk full?");

    // Decode to a float WAV at the original sample rate (no resampling, no quality claims).
    const int channels = (int) jlimit<unsigned> (1, 2, reader->numChannels);
    const auto length = reader->lengthInSamples;
    auto mixFile = dir.getChildFile ("mix.wav");
    {
        std::unique_ptr<OutputStream> stream = std::make_unique<FileOutputStream> (mixFile);
        WavAudioFormat wav;
        auto writer = wav.createWriterFor (stream, AudioFormatWriterOptions{}
                                                       .withSampleRate (reader->sampleRate)
                                                       .withNumChannels (channels)
                                                       .withBitsPerSample (32)
                                                       .withSampleFormat (AudioFormatWriterOptions::SampleFormat::floatingPoint));
        if (writer == nullptr)
            throw String ("Could not create mix.wav");
        AudioBuffer<float> block (channels, 65536);
        for (int64 pos = 0; pos < length; pos += block.getNumSamples())
        {
            const int n = (int) std::min<int64> (block.getNumSamples(), length - pos);
            if (! reader->read (block.getArrayOfWritePointers(), channels, pos, n))
                throw String ("Could not decode " + source.getFileName() + " (file damaged?)");
            if (! writer->writeFromAudioSampleBuffer (block, 0, n))
                throw String ("Could not write mix.wav. Is the disk full?");
            if (onProgress)
                onProgress ((double) pos / (double) length);
        }
    }

    DynamicObject::Ptr song = new DynamicObject();
    song->setProperty ("version", 1);
    song->setProperty ("title", title);
    song->setProperty ("artist", "");
    song->setProperty ("source", "source/" + source.getFileName());
    song->setProperty ("importedFrom", source.getFullPathName());
    song->setProperty ("sampleRate", reader->sampleRate);
    // Lossy formats have no real bit depth; do not report the decoder's float output as "32-bit".
    const bool lossy = reader->getFormatName().containsIgnoreCase ("MP3") || source.hasFileExtension ("mp3;m4a;aac;ogg");
    song->setProperty ("sourceBits", lossy ? var ("lossy") : var ((int) reader->bitsPerSample));
    song->setProperty ("sourceFormat", reader->getFormatName());
    song->setProperty ("duration", (double) length / reader->sampleRate);
    song->setProperty ("created", Time::getCurrentTime().toISO8601 (true));
    if (! replaceFileText (dir.getChildFile ("song.json"), JSON::toString (var (song.get()))))
        throw String ("Could not write song.json");
    cleanup.keep = true;
    return id;
}

var Library::readProject (const String& id) const
{
    auto dir = songDir (id);
    if (! dir.isDirectory())
        return {};
    DynamicObject::Ptr o = new DynamicObject();
    o->setProperty ("id", id);
    o->setProperty ("dir", dir.getFullPathName());
    o->setProperty ("song", JSON::parse (dir.getChildFile ("song.json")));
    auto analysis = dir.getChildFile ("analysis.json");
    o->setProperty ("analysis", analysis.existsAsFile() ? JSON::parse (analysis) : var());
    return var (o.get());
}

String Library::writeSong (const String& id, const String& json)
{
    auto dir = songDir (id);
    if (! dir.isDirectory())
        return "Unknown song";
    if (! JSON::parse (json).isObject())
        return "Song data is not valid JSON";
    return replaceFileText (dir.getChildFile ("song.json"), json) ? String() : String ("Could not save song.json");
}

String Library::deleteSong (const String& id)
{
    auto dir = songDir (id);
    if (! dir.isDirectory())
        return "Unknown song";
    // Recycle bin, not a permanent delete.
    return dir.moveToTrash() ? String() : String ("Could not move the song folder to the Recycle Bin");
}

File Library::resolveStem (const File& dir, const String& stored) const
{
    // New format: relative to the song folder ("stems-123/vocals.wav").
    if (! File::isAbsolutePath (stored))
        return dir.getChildFile (stored);
    // Old format: absolute path. If the library moved, look for the same folder/file name here.
    File abs (stored);
    if (abs.existsAsFile())
        return abs;
    auto moved = dir.getChildFile (abs.getParentDirectory().getFileName()).getChildFile (abs.getFileName());
    return moved;
}

void Library::cleanupStems (const String& id)
{
    // Very conservative: only delete when analysis.json parses, the stems in use exist
    // inside this song folder, and the folder to delete is a different stems folder.
    auto dir = songDir (id);
    auto analysis = JSON::parse (dir.getChildFile ("analysis.json"));
    auto* stems = analysis["stems"].getArray();
    if (stems == nullptr || stems->isEmpty())
        return;
    auto first = resolveStem (dir, stems->getFirst()["path"].toString());
    if (! first.existsAsFile() || ! first.isAChildOf (dir))
        return;
    const auto inUse = first.getParentDirectory();
    for (auto& d : dir.findChildFiles (File::findDirectories, false, "stems*"))
        if (d != inUse && d.getParentDirectory() == dir
            && Time::getCurrentTime() - d.getLastModificationTime() > RelativeTime::minutes (10))
            d.moveToTrash(); // Recycle Bin, never a permanent delete; recent folders may belong to a running analysis
}

std::vector<std::tuple<String, String, File>> Library::tracksFor (const String& id) const
{
    std::vector<std::tuple<String, String, File>> out;
    auto dir = songDir (id);
    auto analysis = JSON::parse (dir.getChildFile ("analysis.json"));
    if (auto* stems = analysis["stems"].getArray())
        for (auto& s : *stems)
        {
            auto f = resolveStem (dir, s["path"].toString());
            if (f.existsAsFile())
                out.emplace_back (s["id"].toString(), s["name"].toString(), f);
        }
    if (out.empty())
        out.emplace_back ("mix", "Full mix", dir.getChildFile ("mix.wav"));

    // The take chosen to play with the song (Record page): one track per recorded input.
    const auto take = JSON::parse (dir.getChildFile ("song.json"))["activeTake"].toString();
    if (take.isNotEmpty())
    {
        auto takeDir = dir.getChildFile ("takes").getChildFile (File::createLegalFileName (take));
        auto info = JSON::parse (takeDir.getChildFile ("take.json"));
        const auto number = take.fromFirstOccurrenceOf ("take-", false, false).getIntValue();
        const auto before = out.size();
        if (auto* tracks = info["tracks"].getArray())
            for (auto& t : *tracks)
            {
                auto f = takeDir.getChildFile (t["file"].toString());
                if (t["file"].toString().isNotEmpty() && f.existsAsFile() && ! t.hasProperty ("error"))
                    out.emplace_back ("take:" + t["label"].toString(), t["label"].toString() + " (take " + String (number) + ")", f);
            }
        // A solo recording: its take IS the song (the mix is only a mixdown of it). Play the take's tracks alone, so a
        // cleaned vocal (or any later change to the take) is what you hear and export.
        if ((bool) info["solo"] && out.size() > before)
            out.erase (out.begin(), out.begin() + (std::ptrdiff_t) before);
    }
    return out;
}

double Library::activeTakeStart (const String& id) const
{
    auto dir = songDir (id);
    const auto take = JSON::parse (dir.getChildFile ("song.json"))["activeTake"].toString();
    if (take.isEmpty())
        return 0.0;
    return (double) JSON::parse (dir.getChildFile ("takes").getChildFile (File::createLegalFileName (take)).getChildFile ("take.json"))
        .getProperty ("startSec", 0.0);
}

var Library::peaks (const String& id, int bins) const
{
    WavAudioFormat wav;
    std::unique_ptr<AudioFormatReader> reader (formats.createReaderFor (songDir (id).getChildFile ("mix.wav")));
    if (reader == nullptr || bins <= 0)
        return Array<var>();
    Array<var> out;
    const int64 len = reader->lengthInSamples;
    for (int i = 0; i < bins; ++i)
    {
        const int64 a = len * i / bins, b = len * (i + 1) / bins;
        Range<float> ranges[2];
        reader->readMaxLevels (a, b - a, ranges, (int) jmin (2u, reader->numChannels));
        float pk = 0;
        for (auto& r : ranges)
            pk = jmax (pk, std::abs (r.getStart()), std::abs (r.getEnd()));
        out.add (std::round (pk * 1000.0f) / 1000.0f);
    }
    return out;
}
