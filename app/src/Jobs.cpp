#include "Jobs.h"

using namespace juce;

namespace
{
File repoRoot()
{
    // Dev builds: the source tree is known at compile time. Installed builds: look next to the exe.
    File compiled (String (WSA_REPO_ROOT));
    if (compiled.getChildFile ("analysis/wsa").isDirectory())
        return compiled;
    for (auto dir = File::getSpecialLocation (File::currentExecutableFile).getParentDirectory(); dir.exists(); dir = dir.getParentDirectory())
    {
        if (dir.getChildFile ("analysis/wsa").isDirectory())
            return dir;
        if (dir.isRoot())
            break;
    }
    return {};
}
} // namespace

class Jobs::Runner : private Thread
{
public:
    Runner (int idIn, StringArray cmdIn, LineFn fnIn)
        : Thread ("wsa-job"), id (idIn), cmd (std::move (cmdIn)), fn (std::move (fnIn)) {}

    ~Runner() override
    {
        cancel();
        stopThread (4000);
    }

    bool launch()
    {
        // Capture stderr too: tools such as tqdm write there, and an unread pipe could block the child.
        if (! process.start (cmd, ChildProcess::wantStdOut | ChildProcess::wantStdErr))
            return false;
        startThread();
        return true;
    }

    void cancel()
    {
        cancelled = true;
        killTree();
        if (process.isRunning())
            process.kill();
    }

    /** Called about every 10 s on the message thread. */
    void checkWatchdog()
    {
        if (! cancelled && isThreadRunning() && Time::getMillisecondCounter() - lastOutput.load() > 20u * 60u * 1000u)
        {
            timedOut = true;
            cancel();
        }
    }

    /** Kills the sidecar's whole process tree: it can start helper processes (e.g. Windows speech), and a
        killed parent would leave them holding the GPU or the work folder. */
    void killTree()
    {
        if (const auto p = pid.load(); p > 0)
        {
            ChildProcess killer;
            if (killer.start (StringArray { "taskkill", "/PID", String (p), "/T", "/F" }, 0))
                killer.waitForProcessToFinish (5000);
        }
    }

private:
    void run() override
    {
        // On Windows, ChildProcess::readProcessOutput blocks until the whole buffer is filled.
        // Reading one byte at a time delivers every progress line immediately (output is small).
        String pending;
        std::string bytes;
        char c = 0;
        lastOutput = Time::getMillisecondCounter();
        while (! threadShouldExit())
        {
            // On Windows this read blocks until a byte arrives or the process ends, so the watchdog
            // runs elsewhere (Jobs::timerCallback) and works from lastOutput.
            const int n = process.readProcessOutput (&c, 1);
            if (n <= 0)
            {
                if (! process.isRunning())
                    break;
                Thread::sleep (20);
                continue;
            }
            lastOutput = Time::getMillisecondCounter();
            if (c != '\n' && c != '\r')
            {
                bytes.push_back (c);
                continue;
            }
            pending += String::fromUTF8 (bytes.data(), (int) bytes.size()) + "\n";
            bytes.clear();
            // tqdm uses carriage returns; split on both line endings.
            for (int nl; (nl = pending.indexOfAnyOf ("\r\n")) >= 0;)
            {
                auto line = pending.substring (0, nl);
                pending = pending.substring (nl + 1);
                const int brace = line.indexOf ("{\"type\"");
                if (brace < 0)
                    continue;
                auto msg = JSON::parse (line.substring (brace));
                if (msg["type"].toString() == "pid")
                {
                    pid = (int) msg["pid"];
                    // Cancel came before the pid (the venv launcher starts the real Python as a child):
                    // only the launcher was killed then, so kill the real process tree now.
                    if (cancelled)
                        killTree();
                }
                else if (msg.isObject())
                    deliver (msg);
            }
        }
        DynamicObject::Ptr end = new DynamicObject();
        end->setProperty ("type", "exit");
        end->setProperty ("code", (int) process.getExitCode());
        end->setProperty ("cancelled", cancelled.load() && ! timedOut.load());
        if (timedOut)
            end->setProperty ("timedOut", true);
        deliver (var (end.get()));
    }

    void deliver (var msg)
    {
        MessageManager::callAsync ([f = fn, i = id, m = std::move (msg)] { f (i, m); });
    }

    int id;
    StringArray cmd;
    LineFn fn;
    ChildProcess process;
    std::atomic<bool> cancelled { false }, timedOut { false };
    std::atomic<int> pid { 0 };
    std::atomic<uint32> lastOutput { 0 };
};

Jobs::Jobs (LineFn fn) : onMessage (std::move (fn))
{
    startTimer (10000);
}

void Jobs::timerCallback()
{
    for (auto& [id, r] : runners)
        r->checkWatchdog();
}
Jobs::~Jobs() { cancelAll(); }

File Jobs::findPython()
{
    auto py = repoRoot().getChildFile ("analysis/.venv/Scripts/python.exe");
    return py.existsAsFile() ? py : File();
}

File Jobs::findSidecarScript()
{
    auto s = repoRoot().getChildFile ("analysis/run_wsa.py");
    return s.existsAsFile() ? s : File();
}

int Jobs::start (const StringArray& args, String& error)
{
    auto py = findPython();
    auto script = findSidecarScript();
    if (py == File() || script == File())
    {
        error = "The analysis tools are not installed. See docs/SETUP.md (step: Python analysis tools).";
        return -1;
    }
    StringArray cmd { py.getFullPathName(), "-u", script.getFullPathName() };
    cmd.addArray (args);
    const int id = nextId++;
    auto runner = std::make_unique<Runner> (id, cmd, onMessage);
    if (! runner->launch())
    {
        error = "Could not start the analysis process.";
        return -1;
    }
    runners[id] = std::move (runner);
    return id;
}

void Jobs::cancel (int jobId)
{
    if (auto it = runners.find (jobId); it != runners.end())
        it->second->cancel();
}

void Jobs::release (int jobId)
{
    runners.erase (jobId); // called after the job's exit message; the thread has finished
}

void Jobs::cancelAll()
{
    for (auto& [id, r] : runners)
        r->cancel();
    runners.clear();
}
