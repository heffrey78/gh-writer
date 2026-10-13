/**
 * The desktop app (D9) asks the page to save everything before it quits, by calling
 * `window.ghWriter.flushAll()` and waiting for it. Each open novel's workspace registers its flush
 * here. In a browser nothing calls it; page hide and unload flush as before.
 */
const flushes = new Set<() => Promise<void>>();

declare global {
  interface Window {
    ghWriter?: { flushAll(): Promise<void> };
  }
}

window.ghWriter = {
  async flushAll() {
    await Promise.allSettled([...flushes].map((flush) => flush()));
  },
};

/** Save with `flush` when the desktop app quits. Returns a function that stops it. */
export function flushOnQuit(flush: () => Promise<void>): () => void {
  flushes.add(flush);
  return () => void flushes.delete(flush);
}
