import { notesMentioning, type Novel } from "@gh-writer/core";
import { useMemo } from "react";
import { Link } from "react-router";
import { ProfileSection } from "../bible/profile.tsx";
import { useEntryPanel } from "../novel/entry-tab.tsx";

/**
 * The writer's notes that mention an entry or an event (#205), on its profile: each opens its page, or
 * on the Entry tab (`beside`) the note in its place. Nothing when no note mentions it.
 */
export function NotesAbout({ novelId, novel, id, beside }: { novelId: string; novel: Novel; id: string; beside?: boolean }) {
  const notes = useMemo(() => notesMentioning(novel, id), [novel, id]);
  if (!notes.length) return null;
  return (
    <ProfileSection title="In your notes">
      <ul className="grid gap-1 text-sm">
        {notes.map((n) => (
          <li key={n.id}>
            <Link
              to={`/novels/${novelId}/note/${n.id}`}
              onClick={(click) => {
                if (!beside) return;
                click.preventDefault();
                useEntryPanel.getState().open(n.id);
              }}
              className="text-accent underline decoration-accent/35 underline-offset-[3px] hover:decoration-accent"
            >
              {n.title}
            </Link>
            {n.tags.length > 0 && <span className="text-muted"> · {n.tags.join(", ")}</span>}
          </li>
        ))}
      </ul>
    </ProfileSection>
  );
}
