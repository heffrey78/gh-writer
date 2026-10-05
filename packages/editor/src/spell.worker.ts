import { SpellEngine, type SpellDictionary } from "./spell-engine.ts";

/*
 * Runs the spell engine off the main thread: loading a dictionary takes ~150 ms and
 * suggestions a few milliseconds each, which would otherwise stall typing.
 */

export type SpellRequest =
  | { id: number; type: "init"; dictionary: SpellDictionary; known: string[] }
  | { id: number; type: "known"; known: string[] }
  | { id: number; type: "add"; words: string[] }
  | { id: number; type: "check"; texts: string[] }
  | { id: number; type: "suggest"; word: string };

let engine: SpellEngine | undefined;

// The worker's global scope, typed locally: this project's DOM types and the webworker lib clash.
const scope = self as unknown as { onmessage: ((event: MessageEvent<SpellRequest>) => void) | null; postMessage(message: unknown): void };

scope.onmessage = (event) => {
  const request = event.data;
  let result: unknown = null;
  try {
    switch (request.type) {
      case "init":
        engine = new SpellEngine(request.dictionary, request.known);
        break;
      case "known":
        engine?.setKnown(request.known);
        break;
      case "add":
        engine?.add(request.words);
        break;
      case "check":
        result = request.texts.map((text) => engine?.misspellings(text) ?? []);
        break;
      case "suggest":
        result = engine?.suggest(request.word) ?? [];
        break;
    }
    scope.postMessage({ id: request.id, result });
  } catch (e) {
    scope.postMessage({ id: request.id, error: String(e) });
  }
};
