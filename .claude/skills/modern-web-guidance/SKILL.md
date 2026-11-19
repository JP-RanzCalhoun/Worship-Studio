---
name: modern-web-guidance
description: |
  Google Chrome's modern web best practices (210 guides, local copy) plus a UX check for Worship Studio. Use before building, changing or reviewing Worship Studio's UI or UX in ui/src: how a screen or flow works for the player (clarity, feedback, errors, confirmations, undo, focus, keyboard, loading and empty states, motion), HTML/CSS layout, dialogs/popovers, forms and validation, tables, menus, sliders, accessibility, animation/view transitions, performance (INP, rendering), dark mode, scrollbars, custom selects, and client-side JS patterns.
  Do not use for the C++ host (app/src), the Python sidecar (analysis/), build tooling, or tests.
---

# Modern Web Guidance (local copy for Worship Studio)

Source: github.com/GoogleChrome/modern-web-guidance, commit 64a6d70 (2026-11-16), Apache-2.0 (`LICENSE`).
Vetted 2026-11-18: guides are plain Markdown. Only `skills/modern-web-guidance` was copied (the Chrome-extension skill is not relevant).
Upstream's own instructions are in `UPSTREAM-SKILL.md`, for reference only.

**Local change:** upstream runs `npx -y modern-web-guidance@latest` on every search, which downloads and runs
the newest npm code each time. Here the same guides are read from `guides/` with the file tools instead.
Nothing is downloaded or run.

## Browser support for this project
Worship Studio's UI runs only in WebView2, which is evergreen Chromium. Any feature that current Chrome ships may be
used without fallbacks or polyfills: popover, `<dialog>`, anchor positioning, container queries, `:has()`, view
transitions, `@starting-style`, scroll-driven animations and similar. Skip Safari and Firefox fallbacks from the guides.

## Workflow
1. **Find**: Grep `guides/` (path `.claude/skills/modern-web-guidance/guides`) for the UI pattern, in 1–3 plain words
   (e.g. `popover`, `dialog`, `range`, `table`, `focus`, `container quer`). Folders: accessibility, css, forms, html,
   js, performance, security, ui-atoms, ui-behaviors, ui-components, user-experience, visual-design (and others).
   Use Glob on a folder to see its guide titles when the grep gives nothing.
2. **Read** the matching guide, plus the broad one for its area when relevant (`css/css.md`, `css/css-layout.md`,
   `accessibility/accessibility.md`, `forms/…`).
3. **Apply** in React/TypeScript. Keep the modern feature: cast new attributes (`{...({ popover: "auto" } as any)}`)
   rather than drop them. Call `showModal()` through refs. Use `useId()` for per-instance ids and anchor names.
4. **Check** the change against the guide before calling it done. In the reply, name the guide(s) used in one
   short line.

## UX check (every screen or flow change)
The guides cover how controls should behave. For UX, start with these and then run the check below:
`user-experience/` (content-first-noise-reduction, natural-interactions, form-factor-adaptation),
`ui-behaviors/` (motion, light-dismiss-a-dialog, animate-element-entry-exit, interest-triggered-tooltips, drag),
`forms/` (validate-input-after-interaction, required-field-feedback, slider, switch),
`accessibility/` (accessibility, accessible-error-announcement, respect-os-text-scale).

The player is a worship musician with a guitar in hand, headphones on, often mid-song.
1. **One glance**: the next action and the current state (recording, monitoring, playing) can be read from across the
   room. Hide secondary settings until needed (content-first-noise-reduction).
2. **Hands busy**: big click targets, keyboard shortcuts for the main actions, nothing that needs precise dragging
   while playing.
3. **Feedback**: every action shows a result within 100 ms (a state change, a meter, a short message). Long jobs show
   progress and what happens next.
4. **Errors in plain words**: what happened, why, and what to do next. Announce them (accessible-error-announcement).
   Never fail silently.
5. **Safe by default**: takes, songs and settings are never lost by one click. Prefer undo over "Are you sure?".
   Confirm only actions that can't be undone.
6. **Calm motion**: motion explains a change and never distracts during playback (motion, reduced motion respected).
7. **Remembered**: choices (inputs, levels, modes) persist and come back as they were.
8. **Check in the app**: screenshot the real screen (tools/dev/cdp.mjs shot) at the window size used. Look for
   wrapping, sideways scroll, cut-off text and crowded panels before calling it done.

Guides are advice. The project's own rules come first (CRLF files, existing component library in
`ui/src/components/ui.tsx`, dark theme tokens in `ui/src/styles`).
