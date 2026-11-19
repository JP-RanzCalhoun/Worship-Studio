#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

/**
 * Small Windows-only helpers for embedded native views.
 *
 * Both WebBrowserComponents (the app screens and the built-in web browser) host their WebView2 in child
 * windows of the same top-level window. Windows draws sibling child windows in their own z-order, which
 * JUCE does not manage, so the full-size app view can cover the smaller browser view.
 */
namespace NativeWindows
{
/**
 * Brings every visible child window of `component`'s top-level window that is smaller than the whole
 * client area (that is: the browser view, not the full-size app view) to the top of the z-order.
 */
void raiseInsetChildren (juce::Component& component);
} // namespace NativeWindows
