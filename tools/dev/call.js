window.__t = window.__t || 900000;
window.__call = (n, ...p) => new Promise((r) => {
  const id = ++window.__t;
  const h = window.__JUCE__.backend.addEventListener('__juce__complete', (x) => {
    if (x.promiseId === id) { window.__JUCE__.backend.removeEventListener(h); r(x.result); }
  });
  window.__JUCE__.backend.emitEvent('__juce__invoke', { name: n, params: p, resultId: id });
});
'ok'
