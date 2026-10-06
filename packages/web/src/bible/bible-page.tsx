import type { Novel } from "@gh-writer/core";
import { Plus, Search } from "lucide-react";
import { useId, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Button } from "../ui/button.tsx";
import { NewEntryDialog, NewTypeDialog } from "./new-entry.tsx";
import { RelationshipTypes } from "./relationship-types.tsx";
import { entriesByType, matches, plural } from "./types.ts";

/** The story bible: every entry by type, searchable by name and alias. */
export function BiblePage({ novelId, novel }: { novelId: string; novel: Novel }) {
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const [adding, setAdding] = useState<string | undefined | null>(null);
  const [addingType, setAddingType] = useState(false);
  const searchId = useId();
  const groups = entriesByType(novel).map((g) => ({ ...g, shown: g.entries.filter((e) => matches(e, query)) }));
  const found = groups.reduce((n, g) => n + g.shown.length, 0);

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6 px-6 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Story bible</h1>
        <div className="flex gap-2">
          <Button onClick={() => setAddingType(true)}>New type</Button>
          <Button variant="primary" onClick={() => setAdding(undefined)}>
            <Plus className="size-4" aria-hidden /> New entry
          </Button>
        </div>
      </div>
      <div className="relative">
        <label htmlFor={searchId} className="sr-only">
          Search the bible
        </label>
        <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" aria-hidden />
        <input
          id={searchId}
          type="search"
          placeholder="Search by name or alias"
          value={query}
          onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {}, { replace: true })}
          className="h-9 w-full rounded-md border border-rule bg-raised pr-3 pl-9 text-sm"
        />
      </div>
      {query && (
        <p role="status" className="text-sm text-muted">
          {found === 1 ? "1 entry" : `${found} entries`} match “{query}”
        </p>
      )}
      {groups.map(({ type, entries, shown }) =>
        query && !shown.length ? null : (
          <section key={type.key} aria-labelledby={`type-${type.key}`} className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <h2 id={`type-${type.key}`} className="font-semibold">
                {plural(type.label)} <span className="text-sm font-normal text-muted">{entries.length}</span>
              </h2>
              <Button size="sm" variant="ghost" onClick={() => setAdding(type.key)} aria-label={`New ${type.label.toLowerCase()}`}>
                <Plus className="size-4" aria-hidden /> New
              </Button>
            </div>
            {shown.length ? (
              <ul className="grid gap-1 sm:grid-cols-2">
                {shown.map((e) => (
                  <li key={e.id}>
                    <Link to={`/novels/${novelId}/bible/${e.id}`} className="block rounded-md border border-rule bg-raised px-3 py-2 hover:bg-panel">
                      <span className="font-medium">{e.name}</span>
                      {e.summary && <span className="mt-0.5 line-clamp-2 block text-sm text-muted">{e.summary}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No {plural(type.label).toLowerCase()} yet.</p>
            )}
          </section>
        ),
      )}
      {!query && <RelationshipTypes novelId={novelId} novel={novel} />}
      <NewEntryDialog novelId={novelId} novel={novel} type={adding ?? undefined} open={adding !== null} onOpenChange={(o) => !o && setAdding(null)} />
      <NewTypeDialog novelId={novelId} novel={novel} open={addingType} onOpenChange={setAddingType} />
    </div>
  );
}
