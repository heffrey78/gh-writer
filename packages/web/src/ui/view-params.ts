import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";

/**
 * A view's state kept in the address (?…), answering at once: the view reads its own copy and the
 * address follows. Waiting on the address instead would make a slider drop key presses and inputs
 * spring back for a moment. Addresses the view wrote itself are ignored when they arrive (late, they
 * would roll it back); any other (a link, a reload) is followed. `set` changes keys; undefined or ""
 * removes one.
 */
export function useViewParams(): [URLSearchParams, (changes: Record<string, string | undefined>) => void] {
  const [address, setAddress] = useSearchParams();
  const [query, setQuery] = useState(address.toString());
  const written = useRef(new Set<string>());
  useEffect(() => {
    const now = address.toString();
    if (written.current.has(now)) return;
    written.current.clear();
    setQuery(now);
  }, [address]);
  const params = useMemo(() => new URLSearchParams(query), [query]);
  const set = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    written.current.add(next.toString());
    setQuery(next.toString());
    setAddress(next, { replace: true });
  };
  return [params, set];
}
