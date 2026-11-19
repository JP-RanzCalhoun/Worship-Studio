#include "NativeWindows.h"

#include <windows.h>
#include <vector>

void NativeWindows::raiseInsetChildren (juce::Component& component)
{
    auto* peer = component.getPeer();
    if (peer == nullptr)
        return;
    auto parent = static_cast<HWND> (peer->getNativeHandle());
    RECT client {};
    if (parent == nullptr || ! GetClientRect (parent, &client))
        return;
    const long long full = (long long) (client.right - client.left) * (client.bottom - client.top);
    if (full <= 0)
        return;

    // Collect first: raising a window changes the sibling order being walked.
    std::vector<HWND> inset;
    for (HWND child = GetWindow (parent, GW_CHILD); child != nullptr; child = GetWindow (child, GW_HWNDNEXT))
    {
        RECT r {};
        if (! IsWindowVisible (child) || ! GetWindowRect (child, &r))
            continue;
        const long long area = (long long) (r.right - r.left) * (r.bottom - r.top);
        if (area > 0 && area < full * 95 / 100)
            inset.push_back (child);
    }
    for (auto* w : inset)
        if (GetWindow (parent, GW_CHILD) != w) // already on top: nothing to do (no repaint)
            SetWindowPos (w, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
}
