#pragma once

#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

/**
 * Runs the Python analysis sidecar as a separate process, one process per job.
 * Every JSON line it prints is delivered on the message thread. Cancel = kill the process.
 * Heavy AI work therefore never runs inside the audio app.
 */
class Jobs : private juce::Timer
{
public:
    using LineFn = std::function<void (int jobId, const juce::var& message)>;

    explicit Jobs (LineFn onMessage);
    ~Jobs();

    /** Locates analysis/.venv/Scripts/python.exe. Empty if the sidecar is not installed. */
    static juce::File findPython();
    static juce::File findSidecarScript();

    /** Starts `python run_wsa.py <args>`. Returns a job id, or -1 with error set. */
    int start (const juce::StringArray& args, juce::String& error);
    void cancel (int jobId);
    /** Frees a finished job's process and thread. */
    void release (int jobId);
    void cancelAll();

private:
    void timerCallback() override; // watchdog: stops a job that printed nothing for 20 minutes
    class Runner;
    LineFn onMessage;
    std::map<int, std::unique_ptr<Runner>> runners;
    int nextId = 1;
};
