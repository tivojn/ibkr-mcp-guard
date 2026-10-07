// AbortSignal.any() with a fallback for Node 20.0–20.2.
export function anySignal(signals) {
  const list = signals.filter(Boolean);
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const c = new AbortController();
  for (const s of list) {
    if (s.aborted) { c.abort(s.reason); break; }
    s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}
