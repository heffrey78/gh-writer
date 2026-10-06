import type { Api } from "@gh-writer/client";
import type { Novel } from "@gh-writer/core";
import { addToDictionary, knownWords, parseDictionary } from "@gh-writer/core/dictionary";
import { createWorkerSpellService, type SpellService } from "@gh-writer/editor";
import { useEffect, useRef, useState } from "react";
import affUrl from "../../../../node_modules/dictionary-en/index.aff?url";
import dicUrl from "../../../../node_modules/dictionary-en/index.dic?url";

const DICTIONARY = "dictionary.txt";

/**
 * Spell checking for a novel: the English dictionary (fetched on first use, checked in a worker), the
 * story bible's names, and the novel's dictionary.txt, where "Add to dictionary" saves.
 */
export function useSpell(api: Api, novelId: string, novel: Novel | undefined): { service: SpellService; onAddWord: (word: string) => void } | undefined {
  const [service, setService] = useState<SpellService>();
  const dictionary = useRef<{ text: string; hash: string | null }>({ text: "", hash: null });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([fetch(affUrl).then((r) => r.text()), fetch(dicUrl).then((r) => r.text())]).then(([aff, dic]) => {
      if (!cancelled) setService(createWorkerSpellService({ aff, dic }));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!service || !novel) return;
    void api
      .readFile(novelId, DICTIONARY)
      .then(({ content, hash }) => (dictionary.current = { text: content, hash }))
      .catch(() => (dictionary.current = { text: "", hash: null }))
      .then(() => service.setKnown(knownWords(novel, parseDictionary(dictionary.current.text))));
  }, [api, novelId, novel, service]);

  if (!service) return undefined;
  return {
    service,
    onAddWord: (word) => {
      const { text, hash } = dictionary.current;
      const next = addToDictionary(text, word);
      void api.writeFile(novelId, DICTIONARY, next, hash).then((r) => {
        if (r.ok) dictionary.current = { text: next, hash: r.hash };
      });
    },
  };
}
