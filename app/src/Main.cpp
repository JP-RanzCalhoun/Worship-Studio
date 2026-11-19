#include "MainComponent.h"

class WorshipStudioApplication : public juce::JUCEApplication
{
public:
    const juce::String getApplicationName() override { return JUCE_APPLICATION_NAME_STRING; }
    const juce::String getApplicationVersion() override { return JUCE_APPLICATION_VERSION_STRING; }
    bool moreThanOneInstanceAllowed() override { return false; }

    void initialise (const juce::String&) override
    {
        juce::SystemStats::setApplicationCrashHandler ([] (void*) {
            auto log = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
                           .getChildFile ("WorshipStudio").getChildFile ("crash.log");
            log.getParentDirectory().createDirectory();
            log.appendText ("\n=== crash " + juce::Time::getCurrentTime().toISO8601 (true) + " ===\n"
                            + juce::SystemStats::getStackBacktrace());
        });
        mainWindow = std::make_unique<MainWindow> (getApplicationName());
    }
    void shutdown() override { mainWindow = nullptr; }
    void systemRequestedQuit() override { quit(); }

    class MainWindow : public juce::DocumentWindow
    {
    public:
        explicit MainWindow (const juce::String& name)
            : DocumentWindow (name, juce::Colour (0xff15171c), DocumentWindow::allButtons)
        {
            setUsingNativeTitleBar (true);
            setContentOwned (new MainComponent(), true);
            setResizable (true, true);

            // Fit the screen's usable area (excludes the taskbar). A fixed 1360x860 window was larger than
            // a laptop screen at 125-150% scaling, which pushed the title bar and transport off-screen.
            auto area = juce::Desktop::getInstance().getDisplays().getPrimaryDisplay()->userBounds.toNearestIntEdges();
            const int minW = juce::jmin (1100, area.getWidth()), minH = juce::jmin (600, area.getHeight());
            setResizeLimits (minW, minH, 10000, 10000);
            const int w = juce::jlimit (minW, area.getWidth(), juce::jmin (1360, area.getWidth() - 40));
            const int h = juce::jlimit (minH, area.getHeight(), juce::jmin (860, area.getHeight() - 90)); // room for the title bar above the client area
            setBounds (juce::Rectangle<int> (w, h).withCentre (area.getCentre()).constrainedWithin (area));
            setVisible (true);
        }

        void closeButtonPressed() override
        {
            if (auto* mc = dynamic_cast<MainComponent*> (getContentComponent()))
                mc->requestClose ([] { JUCEApplication::getInstance()->systemRequestedQuit(); });
            else
                JUCEApplication::getInstance()->systemRequestedQuit();
        }
    };

private:
    std::unique_ptr<MainWindow> mainWindow;
};

START_JUCE_APPLICATION (WorshipStudioApplication)
