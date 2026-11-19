import { useEffect, type RefObject } from "react";
import { engine } from "../engine";

/**
 * Keeps the native browser view (WebView2 window drawn by the host) exactly over a placeholder element.
 * It is hidden whenever a dialog is open, the placeholder is too small, `visible` is false, or the page is left.
 * Page zoom is allowed: the native view is placed in window pixels = CSS pixels x the page zoom
 * (devicePixelRatio / the display's own scale, read again when devicePixelRatio changes).
 */
export function useSiteView(area: RefObject<HTMLElement | null>, visible: boolean) {
  useEffect(() => {
    let last = "";
    let displayScale = 0;
    let scaleForDpr = 0;
    const readScale = () => {
      scaleForDpr = window.devicePixelRatio;
      engine
        .displayScale()
        .then((s) => {
          displayScale = s > 0 ? s : 0;
          last = "";
        })
        .catch(() => {});
    };
    readScale();
    const sync = () => {
      const el = area.current;
      if (!el) return;
      if (window.devicePixelRatio !== scaleForDpr) readScale();
      const zoom = displayScale > 0 ? window.devicePixelRatio / displayScale : 1;
      const b = el.getBoundingClientRect();
      const r = { left: b.left * zoom, top: b.top * zoom, width: b.width * zoom, height: b.height * zoom };
      const show = visible && !document.querySelector(".dialog-backdrop") && r.width > 40 && r.height > 40;
      const key = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), show].join();
      if (key === last) return;
      last = key;
      engine.siteShow(r.left, r.top, r.width, r.height, show).catch(() => {});
    };
    sync();
    const id = window.setInterval(sync, 200);
    window.addEventListener("resize", sync);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("resize", sync);
      engine.siteShow(0, 0, 0, 0, false).catch(() => {});
    };
  }, [area, visible]);
}
