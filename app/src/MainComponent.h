#pragma once

#include <juce_gui_extra/juce_gui_extra.h>
#include "Engine.h"
#include "Jobs.h"
#include "Library.h"
#include "BrowserCapture.h"
#include "RecordSession.h"

/** The built-in web browser (YouTube etc.). Reports navigation so the UI can show the address and title. */
class SiteBrowser : public juce::WebBrowserComponent
{
public:
    using juce::WebBrowserComponent::WebBrowserComponent;
    std::function<void (const juce::String&)> onPageLoaded;
    void pageFinishedLoading (const juce::String& url) override
    {
        if (onPageLoaded)
            onPageLoaded (url);
    }
    // Pop-up windows open in the same view instead of a separate window.
    void newWindowAttemptingToLoad (const juce::String& url) override { goToURL (url); }
};

/** A borderless full-screen window on another display (like an OBS projector), showing one Session scene. */
class ProjectorWindow : public juce::DocumentWindow
{
public:
    /** Full screen on a display, or `windowed`: a normal window you can move and resize (OBS "Windowed Projector"),
        kept on top so the camera stays visible over the app. */
    ProjectorWindow (std::unique_ptr<juce::WebBrowserComponent> view, juce::Rectangle<int> area, bool windowed = false)
        : juce::DocumentWindow (windowed ? "Camera" : "Worship Studio – Projector", juce::Colours::black,
                                windowed ? juce::DocumentWindow::closeButton : 0)
    {
        if (windowed)
        {
            setUsingNativeTitleBar (true);
            setResizable (true, false);
            setResizeLimits (240, 135, 10000, 10000);
            setAlwaysOnTop (true);
        }
        else
        {
            setUsingNativeTitleBar (false);
            setTitleBarHeight (0);
        }
        setContentOwned (view.release(), false);
        setBounds (area);
        setVisible (true);
    }
    juce::WebBrowserComponent* getView() { return dynamic_cast<juce::WebBrowserComponent*> (getContentComponent()); }
    std::function<void()> onClose;
    void closeButtonPressed() override
    {
        if (onClose)
            onClose();
    }
};

class MainComponent : public juce::Component, private juce::Timer
{
public:
    MainComponent();
    ~MainComponent() override;
    void resized() override;
    /** Asks the page to save pending edits, then calls done (with a short timeout). */
    void flushThen (std::function<void()> done);
    /** Close the window: asks first while a browser recording runs (the take is kept and offered next time). */
    void requestClose (std::function<void()> quit);

private:
    using Args = juce::Array<juce::var>;
    using Done = juce::WebBrowserComponent::NativeFunctionCompletion;

    juce::WebBrowserComponent::Options buildOptions();
    std::optional<juce::WebBrowserComponent::Resource> serve (const juce::String& url);
    void timerCallback() override;
    void emit (const juce::Identifier& event, const juce::var& payload);
    void onJobMessage (int jobId, const juce::var& msg);

    // native functions that need more than one line
    void importSong (Done done);
    void importFile (const juce::File& file, Done done);
    void loadSong (const juce::String& id, Done done);
    void setCues (juce::var events, bool enabled, float gain, Done done); // by value: callers may pass lastCueEvents
    void exportMix (const juce::String& id, const juce::var& opts, Done done);
    int runJob (const juce::StringArray& args, Done done, bool waitForResult);

    Library library;
    Engine engine;
    Jobs jobs;
    std::map<int, juce::File> analyzeJobDirs; // song folder of each running analysis job
    std::map<int, Done> waitingJobs;     // jobs whose final "result" answers a native call
    std::map<int, juce::var> jobResults;
    std::unique_ptr<juce::FileChooser> chooser;
    juce::ThreadPool background { 1 };
    juce::String loadedSong;
    int tick = 0;
    juce::var lastCueEvents;
    bool lastCuesEnabled = true;
    float lastCueGain = 0.9f;
    bool tunerOn = false;

    juce::File uiRoot;
    std::unique_ptr<juce::WebBrowserComponent> browser;
    std::unique_ptr<SiteBrowser> site;        // created on first use
    juce::Rectangle<int> siteBounds;
    BrowserCapture capture;
    juce::File captureFile;
    juce::String siteTitle, siteUrl;
    void ensureSite();
    /** Runs one whitelisted action on the video in the built-in browser and returns its state as JSON. */
    void siteVideo (const juce::String& action, const juce::var& arg, Done done);
    std::unique_ptr<ProjectorWindow> projector;
    /** Chord-sheet window: an ordinary browser window (web search for the song's chords). No app functions in it. */
    std::unique_ptr<juce::DocumentWindow> chartWindow;
    // Camera video of a take: chunks from the page's MediaRecorder, appended to <take>/video.webm.
    std::unique_ptr<juce::FileOutputStream> videoOut;
    juce::File videoFile;
    RecordSession recSession;          // a take in progress
    InputRecorder recMonitor;          // dry streams for the input meters while the Record page is open
    juce::StringArray recMonitorLabels;
    bool recStopping = false;
    bool recSolo = false;   // the take in progress is a solo take (no song): it becomes a new song when it stops
    juce::File soloDir;     // its temporary folder in the library (.solo-<time>)
    /** Background: lines up a solo take, mixes it and imports it as a new song (returns the take + songId). */
    juce::var finishSolo (const juce::File& dir);
    /** Point a take's Vocal track at Vocal.clean.wav (true) or back at the original (false). */
    bool useCleanVocal (const juce::File& takeDir, bool clean);
    /** Mixes a lined-up solo take, imports it as a new song and moves the take into it (returns the take + songId). */
    juce::var importSolo (const juce::File& dir, const juce::File& takeDir, juce::var take, const juce::String& title);
    /** Turns solo takes left by a killed app (".solo-*" folders) into songs. */
    juce::var recoverSoloTakes();
    // Live monitoring: inputs (E2 guitar, PD200X vocal) played through the output device (e.g. the PD200X headphones).
    struct MonitorInput
    {
        std::unique_ptr<InputTrack> track; // dry low-latency stream that only feeds the tap
        std::shared_ptr<MonitorTap> tap;
        juce::String device;
    };
    std::map<juce::String, MonitorInput> monitorInputs; // by label ("Guitar", "Vocal")
    // YouTube through the app: the built-in browser's sound (sent by Windows to a silent device such as VB-Cable)
    // is captured and played by the engine, so it is heard even in exclusive mode, with its own level.
    BrowserCapture pageListen;
    std::shared_ptr<MonitorTap> pageTap;
    void stopPageListen();
    // Hum filter / noise gate per input label ("Guitar", "Vocal"): live on the monitor, and on lined-up takes.
    std::map<juce::String, std::shared_ptr<InputCleanup::Settings>> cleanupByLabel;
    std::shared_ptr<InputCleanup::Settings> cleanupFor (const juce::String& label);
    void pushMonitors();
    void stopMonitor (const juce::String& label = {}); // empty = all
    /** Reads the page's current address and title (YouTube changes pages without a reload), then calls `then`. */
    void refreshSiteInfo (std::function<void()> then);
    bool siteInfoBusy = false;
    bool siteVideoOnly = true; // YouTube watch pages show only the player, letterboxed
    /** Remembers the take's title and address next to the file (survives a restart before Save). */
    void saveCaptureInfo();
    juce::File captureInfoFile() const { return captureFile.withFileExtension ("json"); }

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainComponent)
};
