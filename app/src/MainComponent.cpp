#include "MainComponent.h"
#include "NativeWindows.h"
#include "Exporter.h"

using namespace juce;

namespace
{
var ok() { DynamicObject::Ptr o = new DynamicObject(); o->setProperty ("ok", true); return var (o.get()); }
var err (const String& m) { DynamicObject::Ptr o = new DynamicObject(); o->setProperty ("error", m); return var (o.get()); }
var errOrOk (const String& m) { return m.isEmpty() ? ok() : err (m); }

const char* mimeFor (const String& ext)
{
    if (ext == "html") return "text/html";
    if (ext == "js" || ext == "mjs") return "text/javascript";
    if (ext == "css") return "text/css";
    if (ext == "svg") return "image/svg+xml";
    if (ext == "png") return "image/png";
    if (ext == "json") return "application/json";
    if (ext == "woff2") return "font/woff2";
    if (ext == "wav") return "audio/wav";
    return "application/octet-stream";
}

File findUiRoot()
{
    File compiled (String (WSA_REPO_ROOT));
    if (compiled.getChildFile ("ui/dist/index.html").existsAsFile())
        return compiled.getChildFile ("ui/dist");
    return File::getSpecialLocation (File::currentExecutableFile).getParentDirectory().getChildFile ("ui");
}

/** Linear-interpolated mono copy at a new rate (for short cue clips only). */
AudioBuffer<float> toMonoAtRate (const AudioBuffer<float>& in, double inRate, double outRate)
{
    const int outLen = (int) std::ceil (in.getNumSamples() * outRate / inRate);
    AudioBuffer<float> out (1, outLen);
    for (int i = 0; i < outLen; ++i)
    {
        const double p = i * inRate / outRate;
        const int a = (int) p;
        const float f = (float) (p - a);
        float s = 0;
        for (int c = 0; c < in.getNumChannels(); ++c)
        {
            const float x0 = a < in.getNumSamples() ? in.getSample (c, a) : 0.0f;
            const float x1 = a + 1 < in.getNumSamples() ? in.getSample (c, a + 1) : 0.0f;
            s += x0 + f * (x1 - x0);
        }
        out.setSample (0, i, s / (float) in.getNumChannels());
    }
    return out;
}
/** Script for the browser page: while a take records, keep every video/audio element at full volume. */
const char* const recordVolumeScript =
    "window.__wsaRec = true;"
    // Remember each element's own volume and mute once, so they can be put back after the recording.
    "window.__wsaFull = function(v){ if (!v.__wsaPrev) v.__wsaPrev = { volume: v.volume, muted: v.muted };"
    "  if (v.volume < 1 || v.muted) { v.volume = 1; v.muted = false; } };"
    "document.querySelectorAll('video,audio').forEach(window.__wsaFull);"
    "if (!window.__wsaVol) { window.__wsaVol = function(e){ var v = e.target;"
    "  if (window.__wsaRec && v && (v.tagName === 'VIDEO' || v.tagName === 'AUDIO')) window.__wsaFull(v); };"
    "  ['volumechange','play','loadeddata'].forEach(function(n){ document.addEventListener(n, window.__wsaVol, true); }); }";
/**
 * "Video only" on YouTube watch pages: the player fills the browser view, letterboxed (object-fit: contain), instead
 * of the page around it being cut off by the small Session box. Other pages (search, home) stay as they are.
 * YouTube changes pages without reloading, so a small timer switches the class when the address changes.
 * Call with "__ON__" replaced by true or false.
 */
const char* const videoOnlyScript = R"JS((function(on){
  window.__wsaVO = on;
  if (!document.getElementById('wsa-vo-style')) {
    var s = document.createElement('style'); s.id = 'wsa-vo-style';
    s.textContent =
      'html.wsa-vo, html.wsa-vo body { overflow: hidden !important; }' +
      'html.wsa-vo #movie_player { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;' +
      '  z-index: 2147483646 !important; background: #000 !important; }' +
      'html.wsa-vo #movie_player .html5-video-container { position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important; }' +
      'html.wsa-vo #movie_player video.html5-main-video { position: absolute !important; left: 0 !important; top: 0 !important;' +
      '  width: 100% !important; height: 100% !important; object-fit: contain !important; }';
    (document.head || document.documentElement).appendChild(s);
  }
  var apply = function(){
    var want = !!window.__wsaVO && location.pathname === '/watch';
    if (want !== document.documentElement.classList.contains('wsa-vo')) {
      document.documentElement.classList.toggle('wsa-vo', want);
      window.dispatchEvent(new Event('resize')); // YouTube lays its controls out again
    }
  };
  if (!window.__wsaVOTimer) window.__wsaVOTimer = setInterval(apply, 400);
  apply();
})(__ON__))JS";

const char* const recordEndScript =
    "window.__wsaRec = false; document.querySelectorAll('video,audio').forEach(function(v){ v.pause();"
    "  if (v.__wsaPrev) { v.volume = v.__wsaPrev.volume; v.muted = v.__wsaPrev.muted; delete v.__wsaPrev; } })";

/**
 * If the app was killed while recording, the WAV header still says 0 samples (it is written when the file
 * closes). Rewrite the RIFF and data sizes from the file size. Returns the number of audio bytes (0 = none).
 */
int64 repairWavSizes (const File& f)
{
    const int64 size = f.getSize();
    MemoryBlock head;
    {
        FileInputStream in (f);
        if (! in.openedOk() || in.readIntoMemoryBlock (head, 4096) < 12 || std::memcmp (head.getData(), "RIFF", 4) != 0)
            return 0;
    }
    const auto* b = static_cast<const uint8*> (head.getData());
    for (size_t pos = 12; pos + 8 <= head.getSize();)
    {
        const uint32 len = ByteOrder::littleEndianInt (b + pos + 4);
        if (std::memcmp (b + pos, "data", 4) == 0)
        {
            const int64 dataStart = (int64) pos + 8, actual = size - dataStart;
            if (len != 0 || actual <= 0 || actual > 0xffffffffLL - 64)
                return len != 0 ? (int64) len : 0; // header already right (or too big for a plain WAV)
            FileOutputStream out (f);
            if (! out.openedOk())
                return 0;
            out.setPosition (4);
            out.writeInt ((int) (size - 8));
            out.setPosition ((int64) pos + 4);
            out.writeInt ((int) (actual & ~3LL)); // whole 16-bit stereo frames
            out.flush();
            return actual & ~3LL;
        }
        pos += 8 + len + (len & 1);
    }
    return 0;
}
} // namespace

MainComponent::MainComponent()
    : jobs ([safe = Component::SafePointer<MainComponent> (this)] (int id, const var& m) {
          if (safe != nullptr)
              safe->onJobMessage (id, m);
      })
{
    uiRoot = findUiRoot();
    browser = std::make_unique<WebBrowserComponent> (buildOptions());
    addAndMakeVisible (*browser);

    const auto devUrl = SystemStats::getEnvironmentVariable ("WSA_UI_URL", {});
    browser->goToURL (devUrl.isNotEmpty() ? devUrl : WebBrowserComponent::getResourceProviderRoot());

    // A browser recording left from last time (closed before Save) is offered again on the Browser page.
    captureFile = File::getSpecialLocation (File::tempDirectory).getChildFile ("WorshipStudio-capture.wav");

    setSize (1360, 860);
    startTimerHz (30);
}

void MainComponent::requestClose (std::function<void()> quit)
{
    if (recSession.isRecording())
    {
        auto opts = MessageBoxOptions::makeOptionsOkCancel (MessageBoxIconType::QuestionIcon, "Take in progress",
                                                           "A take is still recording. Stop it, save it and close?",
                                                           "Save take and close", "Keep recording", this);
        AlertWindow::showAsync (opts, [this, quit, safe = SafePointer<MainComponent> (this)] (int result) {
            if (safe == nullptr || result != 1)
                return;
            engine.pause();
            recSession.stop (engine.getOutputLatencySeconds(), var(), engine.getSourceRate());
            requestClose (quit);
        });
        return;
    }
    if (! capture.isRecording())
        return flushThen (quit);
    auto opts = MessageBoxOptions::makeOptionsOkCancel (MessageBoxIconType::QuestionIcon, "Recording in progress",
                                                       "The Browser page is still recording. Stop the recording and close?\n\n"
                                                       "The recording is kept. The Browser page offers it again the next time you open the app.",
                                                       "Stop and close", "Keep recording", this);
    AlertWindow::showAsync (opts, [this, quit, safe = SafePointer<MainComponent> (this)] (int result) {
        if (safe == nullptr || result != 1)
            return;
        capture.stop();
        saveCaptureInfo();
        flushThen (quit);
    });
}

MainComponent::~MainComponent()
{
    stopTimer();
    projector.reset();
    chartWindow.reset();
    videoOut.reset();
    if (capture.isRecording())
    {
        capture.stop();
        saveCaptureInfo();
    }
    capture.stop();
    recMonitor.stop();
    stopMonitor();
    stopPageListen();
    if (recSession.isRecording())
        recSession.stop (engine.getOutputLatencySeconds(), var(), engine.getSourceRate());
    jobs.cancelAll();
    background.removeAllJobs (true, 5000);
}

void MainComponent::stopPageListen()
{
    pageTap.reset();
    pushMonitors(); // the audio thread lets go first
    pageListen.stop();
    pageListen.setTap (nullptr);
}

std::shared_ptr<InputCleanup::Settings> MainComponent::cleanupFor (const String& label)
{
    auto& s = cleanupByLabel[label];
    if (s == nullptr)
        s = std::make_shared<InputCleanup::Settings>();
    return s;
}

void MainComponent::pushMonitors()
{
    std::vector<std::shared_ptr<MonitorTap>> taps;
    for (auto& [label, m] : monitorInputs)
        taps.push_back (m.tap);
    if (pageTap != nullptr)
        taps.push_back (pageTap);
    engine.setMonitors (std::move (taps));
}

var MainComponent::finishSolo (const File& dir)
{
    // 1. Line the inputs up with each other (48 kHz files).
    auto take = recSession.stopSolo (var(), 48000.0);
    const auto takeDir = recSession.getTakeDir();
    if (take["error"].toString().isNotEmpty())
        return take;
    return importSolo (dir, takeDir, take, "Solo " + Time::getCurrentTime().formatted ("%Y-%m-%d %H.%M"));
}

var MainComponent::importSolo (const File& dir, const File& takeDir, var take, const String& title)
{
    // 2. Mix them down (mono inputs to both sides), peak at -1 dBFS: the new song's mix.
    AudioFormatManager fm;
    fm.registerBasicFormats();
    AudioBuffer<float> mix;
    if (auto* arr = take["tracks"].getArray())
        for (auto& t : *arr)
        {
            std::unique_ptr<AudioFormatReader> r (fm.createReaderFor (takeDir.getChildFile (t["file"].toString())));
            if (r == nullptr)
                continue;
            const int len = (int) r->lengthInSamples;
            AudioBuffer<float> b ((int) r->numChannels, len);
            r->read (&b, 0, len, 0, true, true);
            if (mix.getNumSamples() < len)
                mix.setSize (2, len, true, true);
            for (int c = 0; c < 2; ++c)
                mix.addFrom (c, 0, b, jmin (c, b.getNumChannels() - 1), 0, len);
        }
    if (mix.getNumSamples() == 0)
    {
        take.getDynamicObject()->setProperty ("error", "The take is empty.");
        return take;
    }
    const float peak = mix.getMagnitude (0, mix.getNumSamples());
    if (peak > 0)
        mix.applyGain (0.891f / peak);
    auto mixFile = dir.getChildFile (title + ".wav");
    if (! Library::writeWav (mixFile, mix, 48000.0, 24))
    {
        take.getDynamicObject()->setProperty ("error", "Could not write the solo mix. The take is kept in " + dir.getFullPathName());
        return take;
    }
    // 3. Import it as a new song and move the take (dry guitar, vocal, camera video) into it.
    try
    {
        const auto id = library.importSong (mixFile, [] (double) {});
        auto takes = library.songDir (id).getChildFile ("takes");
        takes.createDirectory();
        if (! takeDir.moveFileTo (takes.getChildFile (takeDir.getFileName())))
            take.getDynamicObject()->setProperty ("warning", "The song was made, but the separate tracks stayed in " + dir.getFullPathName());
        else
        {
            mixFile.deleteFile();                    // the import copied it into the song's source folder
            dir.getChildFile ("takes").deleteFile(); // now empty (deleteFile only removes an empty folder)
            dir.deleteFile();
        }
        take.getDynamicObject()->setProperty ("songId", id);
        take.getDynamicObject()->setProperty ("title", title);
    }
    catch (const String& e)
    {
        take.getDynamicObject()->setProperty ("error", e + " The take is kept in " + dir.getFullPathName());
    }
    return take;
}

var MainComponent::recoverSoloTakes()
{
    // A solo take lives in a hidden ".solo-<time>" folder until it stops cleanly. If the app was killed mid-take
    // (crash, power loss), that folder stays behind: turn it into a song here (audit P3, 2026-11-17). Without the
    // timing file the inputs can only be lined up by their start, which is close but not exact: said in the take.
    Array<var> recovered;
    for (auto& dir : library.getRoot().findChildFiles (File::findDirectories, false, ".solo-*"))
    {
        if (recSession.isRecording() && dir == soloDir)
            continue; // the take recording now
        auto takeDirs = dir.getChildFile ("takes").findChildFiles (File::findDirectories, false, "take-*");
        if (takeDirs.isEmpty())
            continue;
        const auto takeDir = takeDirs.getFirst();
        Array<var> tracks;
        for (auto& raw : takeDir.getChildFile ("raw").findChildFiles (File::findFiles, false, "*.wav"))
        {
            if (repairWavSizes (raw) <= 0)
                continue; // empty: nothing was recorded on this input
            auto out = takeDir.getChildFile (raw.getFileName());
            if (! out.existsAsFile() && ! raw.copyFileTo (out))
                continue;
            DynamicObject::Ptr t = new DynamicObject();
            t->setProperty ("label", raw.getFileNameWithoutExtension());
            t->setProperty ("file", out.getFileName());
            tracks.add (var (t.get()));
        }
        if (tracks.isEmpty())
            continue;
        DynamicObject::Ptr take = new DynamicObject();
        take->setProperty ("id", takeDir.getFileName());
        take->setProperty ("startSec", 0.0);
        take->setProperty ("solo", true);
        take->setProperty ("recovered", true);
        take->setProperty ("tracks", tracks);
        take->setProperty ("warning", "Recovered after the app closed during the take. The inputs are lined up by their start only, "
                                      "so guitar and vocal can be a few ms apart.");
        takeDir.getChildFile ("take.json").replaceWithText (JSON::toString (var (take.get())));
        // ".solo-20261117-174512" -> "Solo (recovered) 2026-11-17 17.45"
        const auto stamp = dir.getFileName().fromFirstOccurrenceOf (".solo-", false, false);
        const auto title = "Solo (recovered) " + stamp.substring (0, 4) + "-" + stamp.substring (4, 6) + "-" + stamp.substring (6, 8) + " "
                           + stamp.substring (9, 11) + "." + stamp.substring (11, 13);
        auto r = importSolo (dir, takeDir, var (take.get()), title);
        if (r["songId"].toString().isNotEmpty())
            recovered.add (r);
    }
    return var (recovered);
}

void MainComponent::stopMonitor (const String& label)
{
    if (label.isEmpty())
    {
        engine.setMonitors ({}); // the audio thread lets go first
        for (auto& [l, m] : monitorInputs)
            m.track->stop();
        monitorInputs.clear();
        return;
    }
    auto it = monitorInputs.find (label);
    if (it == monitorInputs.end())
        return;
    auto m = std::move (it->second);
    monitorInputs.erase (it);
    pushMonitors();
    m.track->stop();
}

void MainComponent::flushThen (std::function<void()> done)
{
    // The UI debounces saves; give it a chance to write song.json before the window closes.
    auto finished = std::make_shared<bool> (false);
    auto finish = [finished, done] {
        if (! *finished)
        {
            *finished = true;
            done();
        }
    };
    browser->evaluateJavascript ("window.__wsaFlush ? window.__wsaFlush() : 0",
                                 [finish] (WebBrowserComponent::EvaluationResult) { Timer::callAfterDelay (300, finish); });
    Timer::callAfterDelay (1500, finish);
}

void MainComponent::resized()
{
    browser->setBounds (getLocalBounds());
    if (site != nullptr)
        site->setBounds (siteBounds);
}

void MainComponent::ensureSite()
{
    if (site != nullptr)
        return;
    // Same WebView2 profile as the app screens, so there is one browser process tree (the one we capture).
    auto dataDir = File::getSpecialLocation (File::userApplicationDataDirectory).getChildFile ("WorshipStudio").getChildFile ("WebView2");
    site = std::make_unique<SiteBrowser> (WebBrowserComponent::Options{}
                                              .withBackend (WebBrowserComponent::Options::Backend::webview2)
                                              .withKeepPageLoadedWhenBrowserIsHidden() // hiding (dialogs, other pages) must not stop the video
                                              .withWinWebView2Options (WebBrowserComponent::Options::WinWebView2{}.withUserDataFolder (dataDir)));
    site->onPageLoaded = [this, safe = SafePointer<MainComponent> (this)] (const String& url) {
        if (safe == nullptr)
            return;
        if (capture.isRecording())
            site->evaluateJavascript (recordVolumeScript); // a new page has no listeners yet
        site->evaluateJavascript (String (videoOnlyScript).replace ("__ON__", siteVideoOnly ? "true" : "false"));
        siteUrl = url;
        site->evaluateJavascript ("document.title", [this, safe, url] (WebBrowserComponent::EvaluationResult r) {
            if (safe == nullptr)
                return;
            siteTitle = r.getResult() != nullptr ? r.getResult()->toString() : String();
            DynamicObject::Ptr o = new DynamicObject();
            o->setProperty ("url", url);
            o->setProperty ("title", siteTitle);
            emit ("siteNav", var (o.get()));
        });
    };
    addChildComponent (*site);
    site->goToURL ("https://www.youtube.com");
}

void MainComponent::refreshSiteInfo (std::function<void()> then)
{
    if (site == nullptr || siteInfoBusy)
        return then ? then() : void();
    siteInfoBusy = true;
    site->evaluateJavascript ("JSON.stringify([location.href, document.title])",
                              [this, then, safe = SafePointer<MainComponent> (this)] (WebBrowserComponent::EvaluationResult r) {
                                  if (safe == nullptr)
                                      return;
                                  siteInfoBusy = false;
                                  if (r.getResult() != nullptr)
                                  {
                                      auto info = JSON::parse (r.getResult()->toString());
                                      const auto url = info[0].toString(), title = info[1].toString();
                                      if (url.startsWithIgnoreCase ("http") && (url != siteUrl || title != siteTitle))
                                      {
                                          siteUrl = url;
                                          siteTitle = title;
                                          DynamicObject::Ptr o = new DynamicObject();
                                          o->setProperty ("url", url);
                                          o->setProperty ("title", title);
                                          emit ("siteNav", var (o.get()));
                                      }
                                  }
                                  if (then)
                                      then();
                              });
}

void MainComponent::saveCaptureInfo()
{
    DynamicObject::Ptr o = new DynamicObject();
    o->setProperty ("title", siteTitle.upToLastOccurrenceOf (" - YouTube", false, false));
    o->setProperty ("url", siteUrl);
    captureInfoFile().replaceWithText (JSON::toString (var (o.get())));
}

void MainComponent::siteVideo (const String& action, const var& arg, Done done)
{
    if (site == nullptr)
        return done (err ("The song video is not open."));
    // The main <video> of the page (YouTube's player, or the first video on other sites).
    String js = "(function(){ var v = document.querySelector('video.html5-main-video') || document.querySelector('video');"
                " var ad = !!document.querySelector('.ad-showing');"
                " var m = /[?&]v=([\\w-]+)/.exec(location.href); var vid = m ? m[1] : location.href;"
                // YouTube's own player API: seeking through it lets YouTube load the right data. A raw
                // video.currentTime seek right after an ad or a page load can leave the video stuck (2026-11-17).
                " var yp = document.querySelector('.html5-video-player'); var api = !!(yp && yp.seekTo && yp.playVideo && yp.pauseVideo);";
    if (action == "prepare") // start of a capture: from the beginning, paused; remember when this video ends
        js << " if (v) { if (api) { yp.pauseVideo(); yp.seekTo(0, true); } else { v.pause(); v.currentTime = 0; }"
              " window.__wsaEnded = false; window.__wsaCapVid = vid;"
              " if (!window.__wsaEndHook) { window.__wsaEndHook = function(e){ if (e.target && e.target.tagName === 'VIDEO'"
              " && !document.querySelector('.ad-showing')) window.__wsaEnded = true; };"
              " document.addEventListener('ended', window.__wsaEndHook, true); } }";
    else if (action == "play")
        js << " if (api) { yp.playVideo(); } else if (v) { v.play(); }";
    else if (action == "pause")
        js << " if (api) { yp.pauseVideo(); } else if (v) { v.pause(); }";
    else if (action == "nudge") // the video stands still while it should play: ask YouTube to load from here again
        // YouTube's own clock: the <video> element can be swapped while it reloads and then reads 0.
        js << " if (v && !ad) { if (api && yp.getCurrentTime) { var ct = yp.getCurrentTime(); if (ct > 0.5) { yp.seekTo(ct, true); yp.playVideo(); } }"
              " else if (!api && v.currentTime > 0.5) { v.currentTime = v.currentTime; v.play(); } }";
    else if (action == "sync")
    {
        // Picture only: muted, same speed as the player, and corrected when it drifts more than 0.25 s.
        const double target = (double) arg["t"], rate = jlimit (0.25, 4.0, (double) arg.getProperty ("rate", 1.0));
        const bool playing = (bool) arg["playing"];
        // Only the song's own video is controlled (the user may have clicked another one).
        const auto want = arg["id"].toString().retainCharacters ("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-");
        js << " if (v && !ad && (" << (want.isEmpty() ? String ("true") : "vid === '" + want + "'") << ")) {"
           << " v.muted = true; if (Math.abs(v.playbackRate - " << rate << ") > 0.001) v.playbackRate = " << rate << ";"
           << " var t = " << jmax (0.0, target) << "; var d = v.duration || 1e9; var now = Date.now();"
           // no new seek while the last one is still loading (that would seek again every tick)
           << " var busy = v.seeking || v.readyState < 3 || (window.__wsaSeekAt && now - window.__wsaSeekAt < 1000);"
           << " if (!busy && Math.abs(v.currentTime - Math.min(t, d - 0.05)) > 0.25) { v.currentTime = Math.min(t, d - 0.05); window.__wsaSeekAt = now; }"
           << (playing ? " if (t < d - 0.1) { if (v.paused) v.play(); } else if (!v.paused) v.pause();" : " if (!v.paused) v.pause();") << " }";
    }
    else if (action != "state")
        return done (err ("Unknown video action."));
    js << " return JSON.stringify(v ? { has: true, t: v.currentTime, d: v.duration || 0, paused: v.paused, ended: v.ended || !!window.__wsaEnded,"
          " muted: v.muted, ad: ad, vid: vid, url: location.href, title: document.title }"
          " : { has: false, ad: ad, vid: vid, url: location.href, title: document.title }); })()";
    site->evaluateJavascript (js, [done, safe = SafePointer<MainComponent> (this)] (WebBrowserComponent::EvaluationResult r) {
        if (safe == nullptr)
            return;
        if (r.getResult() == nullptr)
            return done (err ("The video did not answer."));
        done (JSON::parse (r.getResult()->toString()));
    });
}

void MainComponent::emit (const Identifier& event, const var& payload)
{
    if (browser != nullptr)
        browser->emitEventIfBrowserIsVisible (event, payload);
    if (projector != nullptr)
        if (auto* v = projector->getView())
            v->emitEventIfBrowserIsVisible (event, payload);
}

std::optional<WebBrowserComponent::Resource> MainComponent::serve (const String& url)
{
    auto path = url.upToFirstOccurrenceOf ("?", false, false).trimCharactersAtStart ("/");
    if (path.isEmpty())
        path = "index.html";
    if (path.contains (".."))
        return std::nullopt;
    auto f = uiRoot.getChildFile (path);
    if (! f.existsAsFile())
        f = uiRoot.getChildFile ("index.html"); // single-page app fallback
    MemoryBlock mb;
    if (! f.loadFileAsData (mb))
        return std::nullopt;
    std::vector<std::byte> data ((size_t) mb.getSize());
    std::memcpy (data.data(), mb.getData(), mb.getSize());
    return WebBrowserComponent::Resource { std::move (data), mimeFor (f.getFileExtension().trimCharactersAtStart (".").toLowerCase()) };
}

void MainComponent::timerCallback()
{
    DynamicObject::Ptr t = new DynamicObject();
    t->setProperty ("pos", engine.getPositionSeconds());
    t->setProperty ("playing", engine.isPlaying());
    emit ("transport", var (t.get()));

    if (++tick % 3 == 0)
        emit ("meters", engine.getMeters());

    if (capture.isRecording() && tick % 3 == 0)
    {
        DynamicObject::Ptr c = new DynamicObject();
        c->setProperty ("seconds", capture.getSeconds());
        c->setProperty ("peak", capture.takePeak());
        c->setProperty ("glitches", capture.getGlitches());
        emit ("capture", var (c.get()));
    }
    // A recording that had to stop by itself (browser gone, disk full): tell the page, keep the file.
    if (tick % 15 == 0)
    {
        auto failure = capture.takeFailure();
        if (failure.isEmpty() && capture.isRecording() && captureFile.getBytesFreeOnVolume() < 300LL * 1024 * 1024)
            failure = "The recording stopped because the disk is almost full. What was recorded so far is kept.";
        if (failure.isNotEmpty())
        {
            const double secs = capture.stop();
            saveCaptureInfo();
            if (site != nullptr)
                site->evaluateJavascript (recordEndScript);
            DynamicObject::Ptr c = new DynamicObject();
            c->setProperty ("seconds", secs);
            c->setProperty ("failed", failure);
            c->setProperty ("title", siteTitle.upToLastOccurrenceOf (" - YouTube", false, false));
            c->setProperty ("url", siteUrl);
            emit ("capture", var (c.get()));
        }
    }
    // Recording: feed the song clock to the take, and send meters (also while only monitoring the inputs).
    if (! recStopping && recSession.isRecording() && engine.isPlaying())
    {
        int64 q = 0;
        double songSec = 0;
        if (engine.getClockAnchor (q, songSec))
            recSession.addClockSample (q, songSec, engine.getTempo());
    }
    if (! recStopping && tick % 3 == 0 && (recSession.isRecording() || recMonitor.isRecording()))
    {
        DynamicObject::Ptr o = new DynamicObject();
        o->setProperty ("recording", recSession.isRecording());
        o->setProperty ("seconds", recSession.getSeconds());
        if (recSession.isRecording())
            o->setProperty ("meters", recSession.takeMeters());
        else
        {
            Array<var> m;
            for (int i = 0; i < recMonitor.size(); ++i)
            {
                DynamicObject::Ptr x = new DynamicObject();
                x->setProperty ("label", recMonitorLabels[i]);
                x->setProperty ("peak", recMonitor.get (i)->takePeak());
                m.add (var (x.get()));
            }
            o->setProperty ("meters", m);
        }
        emit ("rec", var (o.get()));
    }

    // Keep the browser view above the app view (a resize or a new WebView2 window can change the order).
    if (site != nullptr && site->isVisible() && tick % 15 == 0)
        NativeWindows::raiseInsetChildren (*this);

    // Keep the address and title current (YouTube changes videos without a page load).
    if (site != nullptr && site->isVisible() && tick % 30 == 0)
        refreshSiteInfo ({});

    // Device restarted at a new rate: re-make the spoken cue sounds for it.
    if (engine.consumeDeviceRateChanged() && ! lastCueEvents.isVoid())
    {
        const var events = lastCueEvents; // copy: setCues assigns lastCueEvents (self-assignment freed it -> crash)
        setCues (events, lastCuesEnabled, lastCueGain, [] (var) {});
    }

    if (tunerOn && tick % 2 == 0)
    {
        auto r = engine.readTuner();
        DynamicObject::Ptr o = new DynamicObject();
        o->setProperty ("hz", r.hz);
        o->setProperty ("clarity", r.clarity);
        o->setProperty ("level", r.level);
        emit ("tuner", var (o.get()));
    }
}

void MainComponent::onJobMessage (int jobId, const var& msg)
{
    const auto type = msg["type"].toString();
    if (type == "result")
        jobResults[jobId] = msg;
    if (type == "exit")
    {
        // A cancelled or failed analysis leaves no temporary files behind ("Nothing was changed" stays true).
        if (auto it = analyzeJobDirs.find (jobId); it != analyzeJobDirs.end())
        {
            if ((int) msg["code"] != 0 || (bool) msg["cancelled"])
                for (auto& w : it->second.findChildFiles (File::findDirectories, false, ".work-*"))
                    w.deleteRecursively();
            analyzeJobDirs.erase (it);
        }
        MessageManager::callAsync ([this, jobId, safe = SafePointer<MainComponent> (this)] {
            if (safe != nullptr)
                jobs.release (jobId);
        });
        if (auto it = waitingJobs.find (jobId); it != waitingJobs.end())
        {
            auto done = it->second;
            waitingJobs.erase (it);
            if (auto r = jobResults.find (jobId); r != jobResults.end())
                done (r->second);
            else
                done (err (msg["timedOut"] ? "The analysis tools stopped responding for 20 minutes and were stopped. Try again, or use the Fast preset."
                           : msg["cancelled"] ? "Cancelled"
                                              : "The analysis process stopped without a result (exit code " + msg["code"].toString() + ")."));
        }
        jobResults.erase (jobId);
    }
    DynamicObject::Ptr o = new DynamicObject();
    o->setProperty ("jobId", jobId);
    o->setProperty ("msg", msg);
    emit ("job", var (o.get()));
}

int MainComponent::runJob (const StringArray& args, Done done, bool waitForResult)
{
    String error;
    const int id = jobs.start (args, error);
    if (id < 0)
    {
        done (err (error));
        return -1;
    }
    if (waitForResult)
    {
        waitingJobs[id] = std::move (done);
        return id;
    }
    DynamicObject::Ptr o = new DynamicObject();
    o->setProperty ("jobId", id);
    done (var (o.get()));
    return id;
}

// ============================================================================ songs

void MainComponent::importSong (Done done)
{
    chooser = std::make_unique<FileChooser> ("Import a song", File::getSpecialLocation (File::userMusicDirectory),
                                             "*.mp3;*.wav;*.flac;*.m4a;*.aac;*.ogg;*.aif;*.aiff");
    chooser->launchAsync (FileBrowserComponent::openMode | FileBrowserComponent::canSelectFiles,
                          [this, done] (const FileChooser& fc) {
                              const auto file = fc.getResult();
                              if (file == File())
                              {
                                  DynamicObject::Ptr o = new DynamicObject();
                                  o->setProperty ("cancelled", true);
                                  return done (var (o.get()));
                              }
                              importFile (file, done);
                          });
}

void MainComponent::importFile (const File& file, Done done)
{
    if (! file.existsAsFile())
        return done (err ("File not found: " + file.getFullPathName()));
    // The song is copied and decoded to a float WAV: a compressed file grows about 20x, a 16-bit WAV about 3x.
    const auto ext = file.getFileExtension().toLowerCase();
    const int64 factor = (ext == ".wav" || ext == ".aif" || ext == ".aiff") ? 4 : ext == ".flac" ? 8 : 25;
    const int64 needed = file.getSize() * factor + 200LL * 1024 * 1024;
    if (library.getRoot().getBytesFreeOnVolume() < needed)
        return done (err ("Not enough free disk space to import this song: about " + File::descriptionOfSizeInBytes (needed)
                          + " is needed. Free some space and try again."));
    background.addJob ([this, file, done, safe = SafePointer<MainComponent> (this)] {
        var result;
        try
        {
            auto id = library.importSong (file, [safe] (double p) {
                MessageManager::callAsync ([safe, p] {
                    if (safe != nullptr)
                        safe->emit ("import", p);
                });
            });
            DynamicObject::Ptr o = new DynamicObject();
            o->setProperty ("id", id);
            result = var (o.get());
        }
        catch (const String& e)
        {
            result = err (e);
        }
        MessageManager::callAsync ([safe, done, result] {
            if (safe != nullptr)
                done (result);
        });
    });
}

void MainComponent::loadSong (const String& id, Done done)
{
    auto list = library.tracksFor (id);
    const auto error = engine.loadTracks (list);
    if (error.isNotEmpty())
        return done (err (error));
    loadedSong = id;
    emit ("songLoaded", id); // the projector follows the open song
    library.cleanupStems (id); // old stem folders are no longer memory-mapped now
    const double takeStart = library.activeTakeStart (id);
    for (auto& [tid, name, file] : list)
        if (tid.startsWith ("take:"))
            engine.setTrackOffset (tid, (int64) std::llround (takeStart * engine.getSourceRate()));
    DynamicObject::Ptr o = new DynamicObject();
    Array<var> tracks;
    for (auto& [tid, name, file] : list)
    {
        DynamicObject::Ptr t = new DynamicObject();
        t->setProperty ("id", tid);
        t->setProperty ("name", name);
        tracks.add (var (t.get()));
    }
    o->setProperty ("tracks", tracks);
    o->setProperty ("duration", engine.getDurationSeconds());
    o->setProperty ("sampleRate", engine.getSourceRate());
    done (var (o.get()));
}

void MainComponent::setCues (var events, bool enabled, float gain, Done done)
{
    lastCueEvents = events;
    lastCuesEnabled = enabled;
    lastCueGain = gain;
    // events: [{t, file, gain}]; each distinct file becomes one sound in the bank.
    // Files are relative to the song folder (new) or absolute (older songs).
    const auto songFolder = library.songDir (loadedSong);
    Array<var> missing;
    auto bank = std::make_shared<SoundBank>();
    std::map<String, int> index;
    std::vector<TimedSound> timed;
    AudioFormatManager fm;
    fm.registerBasicFormats();
    const double devRate = engine.getDeviceRate();
    if (auto* arr = events.getArray())
        for (auto& e : *arr)
        {
            const auto path = e["file"].toString();
            if (index.find (path) == index.end())
            {
                const File f = File::isAbsolutePath (path) ? File (path) : songFolder.getChildFile (path);
                std::unique_ptr<AudioFormatReader> r (fm.createReaderFor (f));
                if (r == nullptr)
                {
                    if (! missing.contains (path))
                        missing.add (path); // the UI re-renders these words
                    continue;
                }
                AudioBuffer<float> b ((int) r->numChannels, (int) r->lengthInSamples);
                r->read (&b, 0, b.getNumSamples(), 0, true, true);
                bank->sounds.push_back (toMonoAtRate (b, r->sampleRate, devRate));
                index[path] = (int) bank->sounds.size() - 1;
            }
            timed.push_back ({ (double) e["t"], index[path], e.hasProperty ("gain") ? (float) e["gain"] : 1.0f });
        }
    engine.setCues (std::move (timed), bank, enabled, gain);
    DynamicObject::Ptr o = new DynamicObject();
    o->setProperty ("ok", true);
    o->setProperty ("missing", missing);
    done (var (o.get()));
}

void MainComponent::exportMix (const String& id, const var& opts, Done done)
{
    const auto title = library.readProject (id)["song"]["title"].toString();
    const auto suggested = opts["name"].toString().isNotEmpty() ? opts["name"].toString() : title + " - rehearsal mix";
    chooser = std::make_unique<FileChooser> ("Export WAV", File::getSpecialLocation (File::userMusicDirectory).getChildFile (File::createLegalFileName (suggested) + ".wav"), "*.wav");
    chooser->launchAsync (FileBrowserComponent::saveMode | FileBrowserComponent::warnAboutOverwriting,
                          [this, id, opts, done] (const FileChooser& fc) {
                              auto out = fc.getResult();
                              if (out == File())
                              {
                                  DynamicObject::Ptr o = new DynamicObject();
                                  o->setProperty ("cancelled", true);
                                  return done (var (o.get()));
                              }
                              ExportRequest req;
                              req.output = out.withFileExtension ("wav");
                              // The dialog only checked the typed name. Never overwrite a different existing .wav.
                              if (req.output != out && req.output.existsAsFile())
                                  req.output = req.output.getNonexistentSibling();
                              req.tempo = opts.getProperty ("tempo", 1.0);
                              req.semitones = opts.getProperty ("semitones", 0.0);
                              req.startSec = opts.getProperty ("start", 0.0);
                              req.endSec = opts.getProperty ("end", -1.0);
                              req.masterGain = opts.getProperty ("masterGain", 1.0);
                              req.limit = opts.getProperty ("limit", true);
                              auto all = library.tracksFor (id);
                              if (auto* tracks = opts["tracks"].getArray())
                                  for (auto& t : *tracks)
                                      for (auto& [tid, name, file] : all)
                                          if (tid == t["id"].toString() && ! tid.startsWith ("take:") && (float) t["gain"] > 0.0f)
                                              req.tracks.push_back ({ file, (float) t["gain"] });
                              if (auto* sounds = opts["sounds"].getArray())
                                  for (auto& s : *sounds)
                                      req.sounds.push_back ({ (double) s["t"], File (s["file"].toString()), (float) s.getProperty ("gain", 1.0) });
                              background.addJob ([req, done, safe = SafePointer<MainComponent> (this)] {
                                  auto e = Exporter::render (req, [safe] (double p) {
                                      MessageManager::callAsync ([safe, p] { if (safe != nullptr) safe->emit ("export", p); });
                                      return true;
                                  });
                                  MessageManager::callAsync ([safe, done, e, path = req.output.getFullPathName()] {
                                      if (safe == nullptr)
                                          return;
                                      DynamicObject::Ptr o = new DynamicObject();
                                      o->setProperty ("path", path);
                                      if (e.startsWith ("WARNING"))
                                          o->setProperty ("warning", e);
                                      else if (e.isNotEmpty())
                                          o->setProperty ("error", e);
                                      done (var (o.get()));
                                  });
                              });
                          });
}

// ============================================================================ native function table

WebBrowserComponent::Options MainComponent::buildOptions()
{
    auto dataDir = File::getSpecialLocation (File::userApplicationDataDirectory).getChildFile ("WorshipStudio").getChildFile ("WebView2");
    auto o = WebBrowserComponent::Options{}
                 .withBackend (WebBrowserComponent::Options::Backend::webview2)
                 // Minimizing the window must not unload the screens: a capture, a take or an analysis keeps running there.
                 .withKeepPageLoadedWhenBrowserIsHidden()
                 .withWinWebView2Options (WebBrowserComponent::Options::WinWebView2{}.withUserDataFolder (dataDir).withStatusBarDisabled())
                 .withNativeIntegrationEnabled()
                 .withResourceProvider ([this] (const String& url) { return serve (url); });

    auto fn = [&o] (const char* name, WebBrowserComponent::NativeFunction f) { o = o.withNativeFunction (name, std::move (f)); };

    fn ("listSongs", [this] (const Args&, Done d) { d (library.listSongs()); });
    fn ("importSong", [this] (const Args&, Done d) { importSong (d); });
    fn ("importPath", [this] (const Args& a, Done d) { importFile (File (a[0].toString()), d); });
    fn ("readProject", [this] (const Args& a, Done d) { d (library.readProject (a[0].toString())); });
    fn ("saveSong", [this] (const Args& a, Done d) { d (errOrOk (library.writeSong (a[0].toString(), a[1].toString()))); });
    fn ("deleteSong", [this] (const Args& a, Done d) {
        if (loadedSong == a[0].toString())
        {
            engine.unload();
            loadedSong = {};
        }
        d (errOrOk (library.deleteSong (a[0].toString())));
    });
    fn ("loadSong", [this] (const Args& a, Done d) { loadSong (a[0].toString(), d); });
    fn ("peaks", [this] (const Args& a, Done d) {
        background.addJob ([this, id = a[0].toString(), bins = (int) a[1], d, safe = SafePointer<MainComponent> (this)] {
            auto p = library.peaks (id, bins);
            MessageManager::callAsync ([safe, d, p] { if (safe != nullptr) d (p); });
        });
    });

    // transport and mixer
    fn ("play", [this] (const Args& a, Done d) {
        if (a.size() >= 1 && ! a[0].isVoid() && ! a[0].isUndefined())
            engine.play ((double) a[0], a.size() >= 2 ? (double) a[1] : 0.0);
        else
            engine.play();
        d (ok());
    });
    fn ("pause", [this] (const Args&, Done d) { engine.pause(); d (ok()); });
    fn ("seek", [this] (const Args& a, Done d) { engine.seek ((double) a[0]); d (ok()); });
    fn ("setLoop", [this] (const Args& a, Done d) { engine.setLoop ((bool) a[0], (double) a[1], (double) a[2]); d (ok()); });
    fn ("setTempo", [this] (const Args& a, Done d) { engine.setTempoRatio ((double) a[0]); d (ok()); });
    fn ("setPitch", [this] (const Args& a, Done d) { engine.setPitchSemitones ((double) a[0]); d (ok()); });
    fn ("setTrack", [this] (const Args& a, Done d) { engine.setTrackParams (a[0].toString(), (float) a[1], (bool) a[2], (bool) a[3]); d (ok()); });
    fn ("setMasterMute", [this] (const Args& a, Done d) { engine.setMasterMuted ((bool) a[0]); d (ok()); });
    fn ("setMaster", [this] (const Args& a, Done d) {
        engine.setMasterGain ((float) a[0]);
        engine.setLimiterOn ((bool) a[1]);
        d (ok());
    });
    fn ("setClick", [this] (const Args& a, Done d) {
        std::vector<TimedSound> ev;
        if (auto* arr = a[0].getArray())
            for (auto& e : *arr)
                ev.push_back ({ (double) e["t"], (int) e["k"], 1.0f });
        engine.setClick (std::move (ev), (bool) a[1], (float) a[2]);
        d (ok());
    });
    fn ("setCues", [this] (const Args& a, Done d) { setCues (a[0], (bool) a[1], (float) a[2], d); });
    fn ("setCueMix", [this] (const Args& a, Done d) {
        // Volume and on/off only: no need to reload the cue sounds.
        lastCuesEnabled = (bool) a[0];
        lastCueGain = (float) a[1];
        engine.setCuesEnabled (lastCuesEnabled);
        engine.setCueGain (lastCueGain);
        d (ok());
    });

    // built-in browser + capture of its sound
    fn ("siteShow", [this] (const Args& a, Done d) {
        ensureSite();
        siteBounds = { (int) a[0], (int) a[1], jmax (0, (int) a[2]), jmax (0, (int) a[3]) };
        site->setBounds (siteBounds);
        site->setVisible ((bool) a[4] && ! siteBounds.isEmpty());
        // Both web views are child windows of this window; Windows keeps the full-size app view on top unless
        // the browser view is raised. WebView2 creates its window asynchronously, so raise again a bit later.
        if (site->isVisible())
        {
            NativeWindows::raiseInsetChildren (*this);
            Timer::callAfterDelay (400, [safe = SafePointer<MainComponent> (this)] {
                if (safe != nullptr && safe->site != nullptr && safe->site->isVisible())
                    NativeWindows::raiseInsetChildren (*safe);
            });
        }
        d (ok());
    });
    fn ("siteGo", [this] (const Args& a, Done d) {
        ensureSite();
        auto t = a[0].toString().trim();
        // An address is "http(s)://..." or "name.domain/..."; anything else (plain words, file paths) is a YouTube search.
        const bool hasScheme = t.startsWithIgnoreCase ("http://") || t.startsWithIgnoreCase ("https://");
        const bool looksLikeHost = ! t.containsAnyOf (" \\") && ! t.contains (":") && t.upToFirstOccurrenceOf ("/", false, false).containsChar ('.');
        if (hasScheme)
            ;
        else if (looksLikeHost)
            t = "https://" + t;
        else
            t = "https://www.youtube.com/results?search_query=" + URL::addEscapeChars (t, true);
        site->goToURL (t);
        d (ok());
    });
    fn ("siteBack", [this] (const Args&, Done d) { if (site) site->goBack(); d (ok()); });
    fn ("siteForward", [this] (const Args&, Done d) { if (site) site->goForward(); d (ok()); });
    fn ("siteReload", [this] (const Args&, Done d) { if (site) site->refresh(); d (ok()); });
    fn ("siteVideoOnly", [this] (const Args& a, Done d) {
        // YouTube watch pages: the player fills the view, letterboxed (see videoOnlyScript)
        siteVideoOnly = (bool) a[0];
        if (site != nullptr)
            site->evaluateJavascript (String (videoOnlyScript).replace ("__ON__", siteVideoOnly ? "true" : "false"));
        d (ok());
    });
    fn ("captureStart", [this] (const Args&, Done d) {
        ensureSite();
        captureFile = File::getSpecialLocation (File::tempDirectory).getChildFile ("WorshipStudio-capture.wav");
        // The capture follows the video's own volume slider (2% volume = a -36 dB recording), so record at 100%.
        // How loud it sounds in the room is set with the Windows volume instead.
        site->evaluateJavascript (recordVolumeScript);
        captureInfoFile().deleteFile(); // a new take
        d (errOrOk (capture.start (captureFile)));
    });
    fn ("captureStop", [this] (const Args&, Done d) {
        const double secs = capture.stop();
        if (site != nullptr)
            site->evaluateJavascript (recordEndScript);
        siteInfoBusy = false; // a lost earlier reply must not block this one
        refreshSiteInfo ([this, d, secs] {
            saveCaptureInfo();
            DynamicObject::Ptr o = new DynamicObject();
            o->setProperty ("seconds", secs);
            o->setProperty ("title", siteTitle.upToLastOccurrenceOf (" - YouTube", false, false));
            o->setProperty ("url", siteUrl);
            d (var (o.get()));
        });
    });
    fn ("captureSave", [this] (const Args& a, Done d) {
        // Import the recording as a song (named by the user), then remove the temporary file.
        auto name = File::createLegalFileName (a[0].toString().trim());
        if (name.isEmpty())
            name = "Browser recording";
        auto named = captureFile.getSiblingFile (name + ".wav");
        if (! captureFile.existsAsFile() || ! captureFile.moveFileTo (named))
            return d (err ("The recording was not found."));
        if (! capture.isRecording() && repairWavSizes (named) <= 0)
        {
            named.moveFileTo (captureFile);
            return d (err ("The recording is empty or damaged, so it cannot be saved."));
        }
        // a[2]: video time minus song time (the video picture is synced to the player with it)
        importFile (named, [this, d, named, url = a[1].toString(), offset = a.size() > 2 ? a[2] : var()] (var r) {
            auto* o = r.getDynamicObject();
            if (o == nullptr || ! o->hasProperty ("id"))
            {
                named.moveFileTo (captureFile); // keep it: the user can free space and press Save again
                return d (r);
            }
            named.deleteFile();
            captureInfoFile().deleteFile();
            if (url.isNotEmpty())
            {
                // Remember where it came from (shown in the song, used as a reference link).
                auto song = library.readProject (o->getProperty ("id").toString())["song"];
                if (auto* so = song.getDynamicObject())
                {
                    so->setProperty ("referenceUrl", url);
                    so->setProperty ("sourceNote", "Recorded from the built-in browser for personal study");
                    if (! offset.isVoid())
                        so->setProperty ("referenceOffset", (double) offset);
                    library.writeSong (o->getProperty ("id").toString(), JSON::toString (song));
                }
            }
            d (r);
        });
    });
    fn ("captureStatus", [this] (const Args&, Done d) {
        DynamicObject::Ptr o = new DynamicObject();
        const bool pending = ! capture.isRecording() && captureFile.existsAsFile(); // stopped, not yet saved
        if (pending)
            repairWavSizes (captureFile); // a take left by a crash
        o->setProperty ("recording", capture.isRecording());
        // A take left from last time has no live counter: its length comes from the file (48 kHz, 16-bit stereo).
        o->setProperty ("seconds", pending && capture.getSeconds() == 0 ? jmax<int64> (0, captureFile.getSize() - 44) / (BrowserCapture::sampleRate * 4.0)
                                                                        : capture.getSeconds());
        o->setProperty ("pending", pending);
        const auto info = pending ? JSON::parse (captureInfoFile()) : var();
        o->setProperty ("title", info.hasProperty ("title") ? info["title"].toString() : siteTitle.upToLastOccurrenceOf (" - YouTube", false, false));
        o->setProperty ("url", info.hasProperty ("url") ? info["url"].toString() : siteUrl);
        d (var (o.get()));
    });
    fn ("captureDiscard", [this] (const Args&, Done d) {
        capture.stop();
        if (site != nullptr)
            site->evaluateJavascript (recordEndScript); // also puts the video volume back
        captureFile.deleteFile();
        captureInfoFile().deleteFile();
        d (ok());
    });

    // recording (M2b): dry takes per input, lined up with the song
    auto parseTracks = [] (const var& v) {
        Array<RecordSession::Track> t;
        if (auto* arr = v.getArray())
            for (auto& x : *arr)
                if (x["device"].toString().isNotEmpty())
                    t.add ({ x["label"].toString(), x["device"].toString() });
        return t;
    };
    fn ("recInputs", [] (const Args&, Done d) { d (RecordSession::listInputs()); });
    fn ("recMonitor", [this, parseTracks] (const Args& a, Done d) {
        recMonitor.stop();
        recMonitorLabels.clear();
        auto tracks = parseTracks (a[0]);
        if (tracks.isEmpty() || recSession.isRecording())
            return d (ok());
        Array<InputRecorder::Source> src;
        for (auto& t : tracks)
        {
            src.add ({ t.device, {} }); // dry: nothing is stored
            recMonitorLabels.add (t.label);
        }
        d (errOrOk (recMonitor.start (src)));
    });
    fn ("recStart", [this, parseTracks] (const Args& a, Done d) {
        const auto id = a[0].toString();
        recMonitor.stop();
        recMonitorLabels.clear();
        if (id.isEmpty())
        {
            // Solo: no song. Recorded into a temporary folder; it becomes a new song in the library when it stops.
            soloDir = library.getRoot().getChildFile (".solo-" + Time::getCurrentTime().formatted ("%Y%m%d-%H%M%S"));
            recSession.setCleanup (cleanupByLabel); // hum filter / gate for the lined-up files
            auto e = recSession.start (soloDir, parseTracks (a[1]), 0.0);
            recSolo = e.isEmpty();
            return d (errOrOk (e));
        }
        if (! library.songDir (id).isDirectory())
            return d (err ("Open a song first."));
        recSolo = false;
        recSession.setCleanup (cleanupByLabel);
        d (errOrOk (recSession.start (library.songDir (id), parseTracks (a[1]), (double) a[2])));
    });
    fn ("recStop", [this] (const Args&, Done d) {
        if (! recSession.isRecording())
            return d (err ("No take is recording."));
        // Lining the files up takes a moment for a long take: do it off the message thread.
        recStopping = true;
        if (recSolo)
        {
            recSolo = false;
            background.addJob ([this, d, dir = soloDir, safe = SafePointer<MainComponent> (this)] {
                auto result = finishSolo (dir);
                MessageManager::callAsync ([safe, d, result] {
                    if (safe == nullptr)
                        return;
                    safe->recStopping = false;
                    d (result);
                });
            });
            return;
        }
        const double latency = engine.getOutputLatencySeconds(), songRate = engine.getSourceRate();
        background.addJob ([this, d, latency, songRate, safe = SafePointer<MainComponent> (this)] {
            auto take = recSession.stop (latency, var(), songRate);
            MessageManager::callAsync ([safe, d, take] {
                if (safe == nullptr)
                    return;
                safe->recStopping = false;
                d (take);
            });
        });
    });
    fn ("soloRecover", [this] (const Args&, Done d) {
        // Solo takes left behind by a killed app become songs (in the background: it mixes and imports).
        if (recStopping)
            return d (var (Array<var>()));
        background.addJob ([this, d, safe = SafePointer<MainComponent> (this)] {
            auto result = recoverSoloTakes();
            MessageManager::callAsync ([safe, d, result] {
                if (safe != nullptr)
                    d (result);
            });
        });
    });
    fn ("recCancel", [this] (const Args&, Done d) {
        recSession.cancel();
        d (ok());
    });
    fn ("recStatus", [this] (const Args&, Done d) {
        DynamicObject::Ptr o = new DynamicObject();
        o->setProperty ("recording", recSession.isRecording());
        o->setProperty ("seconds", recSession.getSeconds());
        d (var (o.get()));
    });
    fn ("recTakes", [this] (const Args& a, Done d) { d (RecordSession::listTakes (library.songDir (a[0].toString()), recSession.getCurrentTakeDir())); });

    // ---- live monitoring: inputs (Guitar, Vocal) played through the output device (software; takes stay dry)
    fn ("monitorSet", [this] (const Args& a, Done d) {
        // (label, device, gain): device "" turns that input's monitor off.
        const auto label = a[0].toString(), device = a[1].toString();
        const float gain = (float) jlimit (0.0, 2.0, a.size() > 2 ? (double) a[2] : 1.0);
        auto it = monitorInputs.find (label);
        if (it != monitorInputs.end() && it->second.device == device && device.isNotEmpty())
        {
            it->second.tap->setGain (gain);
            return d (ok());
        }
        stopMonitor (label);
        if (device.isEmpty())
            return d (ok());
        MonitorInput m;
        m.track = std::make_unique<InputTrack>();
        m.tap = std::make_shared<MonitorTap>();
        m.tap->setGain (gain);
        m.device = device;
        m.track->setTap (m.tap);
        m.track->setCleanup (cleanupFor (label)); // hum filter / gate on what you hear
        m.track->setLowLatency (true);
        if (auto e = m.track->start (device, {}); e.isNotEmpty())
            return d (err (e));
        monitorInputs[label] = std::move (m);
        pushMonitors();
        d (ok());
    });
    fn ("padSet", [this] (const Args& a, Done d) {
        // { on, key (0-11, C = 0), level (0-1), flavor ("warm" | "shimmer") }: the ambient pad made in code
        auto& pad = engine.getPad();
        const auto& o = a[0];
        if (o.hasProperty ("key"))
            pad.setKey ((int) o["key"]);
        if (o.hasProperty ("level"))
            pad.setLevel ((float) (double) o["level"]);
        if (o.hasProperty ("flavor"))
            pad.setFlavor ([] (const String& f) { return f == "shimmer" ? PadSynth::Flavor::shimmer : f == "analog" ? PadSynth::Flavor::analog : f == "organ" ? PadSynth::Flavor::organ : PadSynth::Flavor::warm; } (o["flavor"].toString()));
        if (o.hasProperty ("on"))
            pad.setOn ((bool) o["on"]);
        d (ok());
    });
    fn ("pageListen", [this] (const Args& a, Done d) {
        // (on, gain): play the built-in browser's sound through the app (YouTube in exclusive mode)
        const bool on = (bool) a[0];
        const float gain = (float) jlimit (0.0, 2.0, a.size() > 1 ? (double) a[1] : 1.0);
        if (! on)
        {
            stopPageListen();
            return d (ok());
        }
        if (pageTap != nullptr && pageListen.isRecording())
        {
            pageTap->setGain (gain);
            return d (ok());
        }
        stopPageListen();
        ensureSite();
        auto tap = std::make_shared<MonitorTap>();
        tap->setGain (gain);
        pageListen.setTap (tap);
        if (auto e = pageListen.start ({}); e.isNotEmpty())
        {
            pageListen.setTap (nullptr);
            return d (err (e));
        }
        pageTap = tap;
        pushMonitors();
        d (ok());
    });
    fn ("inputCleanup", [this] (const Args& a, Done d) {
        // (label, { hum, humHz, gate, thresholdDb }): applies live to that input's monitor and to its next takes
        InputCleanup::read (*cleanupFor (a[0].toString()), a[1]);
        d (ok());
    });
    fn ("inputCleanupPeak", [this] (const Args& a, Done d) {
        // loudest level (dB) of that input's monitor stream since the last call; resets it
        const float pk = cleanupFor (a[0].toString())->peak.exchange (0.0f);
        d (var (pk > 0 ? (double) Decibels::gainToDecibels (pk) : -120.0));
    });
    fn ("monitorGain", [this] (const Args& a, Done d) {
        if (auto it = monitorInputs.find (a[0].toString()); it != monitorInputs.end())
            it->second.tap->setGain ((float) jlimit (0.0, 2.0, (double) a[1]));
        d (ok());
    });
    fn ("outputMode", [this] (const Args& a, Done d) {
        // "normal" | "low" | "exclusive"
        const auto m = a[0].toString();
        const auto mode = m == "exclusive" ? Engine::OutputMode::exclusive : m == "low" ? Engine::OutputMode::lowLatency : Engine::OutputMode::normal;
        const auto e = engine.setOutputMode (mode);
        if (e.isNotEmpty())
            return d (err ((mode == Engine::OutputMode::exclusive ? "Exclusive mode" : "Low-latency mode")
                           + String (" is not available on this output (another app may be using it): ") + e));
        d (ok());
    });
    fn ("monitorStatus", [this] (const Args&, Done d) {
        DynamicObject::Ptr o = new DynamicObject();
        const double outMs = engine.getDeviceOutputLatencySeconds() * 1000.0;
        const auto mode = engine.getOutputMode();
        o->setProperty ("outputMode", mode == Engine::OutputMode::exclusive ? "exclusive" : mode == Engine::OutputMode::lowLatency ? "low" : "normal");
        o->setProperty ("outputMs", outMs);
        if (auto* dev = engine.getDeviceManager().getCurrentAudioDevice())
            o->setProperty ("outputBlockMs", 1000.0 * dev->getCurrentBufferSizeSamples() / jmax (1.0, dev->getCurrentSampleRate()));
        Array<var> list;
        for (auto& [label, m] : monitorInputs)
        {
            if (! m.track->isRecording())
                continue;
            // Estimate: one input packet + the ring's fill + the output device. The input device's own converter
            // delay is not reported by Windows (a few ms more).
            const double inMs = m.tap->getPacketSeconds() * 1000.0, bufMs = m.tap->getFillSeconds() * 1000.0;
            DynamicObject::Ptr x = new DynamicObject();
            x->setProperty ("label", label);
            x->setProperty ("device", m.device);
            x->setProperty ("inputMs", inMs);
            x->setProperty ("bufferMs", bufMs);
            x->setProperty ("totalMs", inMs + bufMs + outMs);
            x->setProperty ("lowLatencyInput", m.track->getPeriodFrames() > 0);
            x->setProperty ("underruns", m.tap->getLateUnderruns()); // after start-up (devices stutter while starting)
            x->setProperty ("overflows", m.tap->getOverflows());
            x->setProperty ("peak", m.track->takePeak());
            list.add (var (x.get()));
        }
        o->setProperty ("inputs", list);
        if (pageTap != nullptr && pageListen.isRecording())
        {
            DynamicObject::Ptr pg = new DynamicObject();
            pg->setProperty ("totalMs", (pageTap->getPacketSeconds() + pageTap->getFillSeconds()) * 1000.0 + outMs);
            pg->setProperty ("peak", pageListen.takePeak());
            o->setProperty ("page", var (pg.get()));
        }
        d (var (o.get()));
    });
    fn ("revealTake", [this] (const Args& a, Done d) {
        auto dir = library.songDir (a[0].toString()).getChildFile ("takes").getChildFile (File::createLegalFileName (a[1].toString()));
        if (dir.isDirectory())
            dir.revealToUser();
        d (ok());
    });

    // Session: song video, camera video of a take, projector
    fn ("siteVideo", [this] (const Args& a, Done d) { siteVideo (a[0].toString(), a[1], d); });
    fn ("videoStart", [this] (const Args& a, Done d) {
        auto dir = recSession.getCurrentTakeDir();
        if (dir == File())
            return d (err ("No take is recording."));
        // MP4 (H.264) or WebM, as the page records it
        videoFile = dir.getChildFile (a[0].toString().containsIgnoreCase ("mp4") ? "video.mp4" : "video.webm");
        videoFile.deleteFile();
        videoOut = std::make_unique<FileOutputStream> (videoFile);
        if (! videoOut->openedOk())
        {
            videoOut.reset();
            return d (err ("Could not create the video file."));
        }
        // Clock pairs for lining the picture up with the sound later: the page's clock (ms since 1970) and Windows' QPC.
        DynamicObject::Ptr o = new DynamicObject();
        o->setProperty ("mime", a[0].toString());
        o->setProperty ("pageStartEpochMs", (double) a[1]);
        o->setProperty ("hostEpochMs", (double) Time::currentTimeMillis());
        const int64 ticks = Time::getHighResolutionTicks(), freq = Time::getHighResolutionTicksPerSecond();
        o->setProperty ("hostQpc100ns", (ticks / freq) * 10'000'000 + (ticks % freq) * 10'000'000 / freq);
        dir.getChildFile ("video.json").replaceWithText (JSON::toString (var (o.get())));
        d (ok());
    });
    fn ("videoMark", [this] (const Args& a, Done d) {
        auto info = videoFile.withFileExtension ("json");
        auto j = JSON::parse (info);
        if (auto* o = j.getDynamicObject())
        {
            o->setProperty ("recorderStartEpochMs", (double) a[0]);
            o->setProperty ("hostEpochMsAtMark", (double) Time::currentTimeMillis());
            const int64 ticks = Time::getHighResolutionTicks(), freq = Time::getHighResolutionTicksPerSecond();
            o->setProperty ("hostQpc100nsAtMark", (ticks / freq) * 10'000'000 + (ticks % freq) * 10'000'000 / freq);
            info.replaceWithText (JSON::toString (j));
        }
        d (ok());
    });
    fn ("videoChunk", [this] (const Args& a, Done d) {
        if (videoOut == nullptr)
            return d (err ("No video file is open."));
        if (! Base64::convertFromBase64 (*videoOut, a[0].toString()))
            return d (err ("A piece of the video could not be read."));
        d (ok());
    });
    fn ("videoStop", [this] (const Args&, Done d) {
        if (videoOut != nullptr)
            videoOut->flush();
        videoOut.reset();
        DynamicObject::Ptr o = new DynamicObject();
        o->setProperty ("file", videoFile.getFileName());
        o->setProperty ("bytes", videoFile.getSize());
        d (var (o.get()));
    });
    fn ("displays", [this] (const Args&, Done d) {
        Array<var> out;
        auto& displays = Desktop::getInstance().getDisplays().displays;
        auto* mine = Desktop::getInstance().getDisplays().getDisplayForRect (getScreenBounds());
        for (int i = 0; i < displays.size(); ++i)
        {
            DynamicObject::Ptr o = new DynamicObject();
            const auto r = displays.getReference (i).totalArea;
            o->setProperty ("index", i);
            o->setProperty ("label", "Display " + String (i + 1) + " · " + String (r.getWidth()) + "×" + String (r.getHeight())
                                         + (displays.getReference (i).isMain ? " (main)" : ""));
            o->setProperty ("thisWindow", mine != nullptr && mine->totalArea == r);
            out.add (var (o.get()));
        }
        d (out);
    });
    fn ("projectorOpen", [this] (const Args& a, Done d) {
        auto& displays = Desktop::getInstance().getDisplays().displays;
        const int index = (int) a[1];
        const bool windowed = index < 0; // -1: a movable, resizable window (e.g. the camera beside the video)
        if (! windowed && ! isPositiveAndBelow (index, displays.size()))
            return d (err ("That display is not connected."));
        projector.reset();
        auto view = std::make_unique<WebBrowserComponent> (buildOptions());
        // a[0] = scene ("chords" / "camera"), a[2] = song id
        view->goToURL (WebBrowserComponent::getResourceProviderRoot() + "?projector=" + URL::addEscapeChars (a[0].toString(), true)
                       + "&song=" + URL::addEscapeChars (a[2].toString(), true));
        Rectangle<int> area;
        if (windowed)
        {
            // 16:9, a third of the main display's width, near its top-right corner (the user moves it from there)
            auto user = Desktop::getInstance().getDisplays().getPrimaryDisplay()->userArea;
            const int w = jmax (320, user.getWidth() / 3), h = w * 9 / 16;
            area = { user.getRight() - w - 24, user.getY() + 64, w, h };
        }
        else
            area = displays.getReference (index).totalArea.toNearestInt();
        projector = std::make_unique<ProjectorWindow> (std::move (view), area, windowed);
        projector->toFront (true);
        projector->onClose = [this] { MessageManager::callAsync ([this, safe = SafePointer<MainComponent> (this)] { if (safe != nullptr) projector.reset(); }); };
        d (ok());
    });
    fn ("chartSearch", [this] (const Args& a, Done d) {
        // A web search for the song's chord sheet in its own window, beside the Session scenes (never on top of them).
        // It is a plain browser: the page has no access to the app, and nothing is copied from it automatically.
        const auto query = a[0].toString().trim();
        if (query.isEmpty())
            return d (err ("No song name to search for."));
        const auto url = "https://www.google.com/search?q=" + URL::addEscapeChars (query + " chords", true);
        if (chartWindow == nullptr)
        {
            auto dataDir = File::getSpecialLocation (File::userApplicationDataDirectory).getChildFile ("WorshipStudio").getChildFile ("WebView2");
            auto* view = new SiteBrowser (WebBrowserComponent::Options{}
                                              .withBackend (WebBrowserComponent::Options::Backend::webview2)
                                              .withKeepPageLoadedWhenBrowserIsHidden()
                                              .withWinWebView2Options (WebBrowserComponent::Options::WinWebView2{}.withUserDataFolder (dataDir)));
            struct ChartWindow : public DocumentWindow
            {
                ChartWindow() : DocumentWindow ("Chord sheet – Worship Studio", Colours::white, DocumentWindow::allButtons) {}
                void closeButtonPressed() override { setVisible (false); }
            };
            auto w = std::make_unique<ChartWindow>();
            w->setUsingNativeTitleBar (true);
            w->setResizable (true, true);
            w->setContentOwned (view, false);
            // Right half of the screen: the Session scenes stay visible on the left.
            auto area = Desktop::getInstance().getDisplays().getDisplayForRect (getScreenBounds())->userArea.toNearestInt();
            w->setBounds (area.removeFromRight (jmax (480, area.getWidth() * 2 / 5)));
            chartWindow = std::move (w);
        }
        if (auto* view = dynamic_cast<SiteBrowser*> (chartWindow->getContentComponent()))
            view->goToURL (url);
        chartWindow->setVisible (true);
        chartWindow->toFront (true);
        d (ok());
    });
    fn ("projectorClose", [this] (const Args&, Done d) {
        // Deferred: this call may come from the projector's own page.
        MessageManager::callAsync ([this, safe = SafePointer<MainComponent> (this)] { if (safe != nullptr) projector.reset(); });
        d (ok());
    });

    // devices and tuner
    fn ("devices", [this] (const Args&, Done d) { d (engine.describeDevices()); });
    fn ("setDevices", [this] (const Args& a, Done d) { d (errOrOk (engine.applyDeviceSetup (a[0].toString(), a[1].toString()))); });
    fn ("tuner", [this] (const Args& a, Done d) {
        tunerOn = (bool) a[0];
        engine.setTunerEnabled (tunerOn);
        d (ok());
    });

    // analysis sidecar
    fn ("sidecarInfo", [this] (const Args&, Done d) { runJob ({ "info" }, d, true); });
    fn ("analyze", [this] (const Args& a, Done d) {
        auto dir = library.songDir (a[0].toString());
        // Separation writes several full-length WAV files: refuse early with a clear message when the disk is nearly full.
        const auto mixBytes = dir.getChildFile ("mix.wav").getSize();
        const int64 needed = jmax<int64> ((int64) 2 * 1024 * 1024 * 1024, mixBytes * 12);
        if (dir.getBytesFreeOnVolume() < needed)
            return d (err ("Not enough free disk space for analysis: about " + File::descriptionOfSizeInBytes (needed)
                           + " is needed and only " + File::descriptionOfSizeInBytes (dir.getBytesFreeOnVolume())
                           + " is free on this drive. Free some space (for example, empty the Recycle Bin) and try again."));
        StringArray args { "analyze", "--source", dir.getChildFile ("mix.wav").getFullPathName(), "--project", dir.getFullPathName(),
                           "--quality", a[1].toString(), "--device", a[2].toString() };
        if ((bool) a[3])
            args.add ("--no-stems");
        // Playback continues during analysis: new stems go to a new folder (see analysis/wsa/cli.py).
        if (const int id = runJob (args, d, false); id > 0)
            analyzeJobDirs[id] = dir;
    });
    fn ("cancelJob", [this] (const Args& a, Done d) { jobs.cancel ((int) a[0]); d (ok()); });
    fn ("renderCues", [this] (const Args& a, Done d) {
        StringArray args { "tts", "--out", library.songDir (a[0].toString()).getChildFile ("cues").getFullPathName() };
        if (auto* texts = a[1].getArray())
            for (auto& t : *texts)
                args.addArray ({ "--text", t.toString() });
        runJob (args, d, true);
    });

    // export and files
    fn ("exportMix", [this] (const Args& a, Done d) { exportMix (a[0].toString(), a[1], d); });
    fn ("reveal", [] (const Args& a, Done d) { File (a[0].toString()).revealToUser(); d (ok()); });
    fn ("libraryRoot", [this] (const Args&, Done d) { d (library.getRoot().getFullPathName()); });
    fn ("displayScale", [this] (const Args&, Done d) {
        auto* display = Desktop::getInstance().getDisplays().getDisplayForRect (getScreenBounds());
        d (display != nullptr ? display->scale : 1.0);
    });
    return o;
}
