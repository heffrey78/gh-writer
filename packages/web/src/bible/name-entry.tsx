import type { Novel } from "@gh-writer/core";
import { useState } from "react";
import { Button } from "../ui/button.tsx";
import { Modal } from "../ui/dialog.tsx";
import { Field } from "../ui/field.tsx";
import { useNaming } from "./quick-entry.ts";

/** "New <type>…" from the @ menu: the new entry's name, asked for in place. */
export function NameEntryDialog({ novel }: { novel: Novel }) {
  const { type, answer } = useNaming();
  if (!type) return null;
  const label = (novel.entityTypes.find((t) => t.key === type)?.label ?? "entry").toLowerCase();
  return <Ask key={type} label={label} answer={answer} />;
}

function Ask({ label, answer }: { label: string; answer: (name: string | undefined) => void }) {
  const [name, setName] = useState("");
  return (
    <Modal title={`New ${label}`} onClose={() => answer(undefined)}>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) answer(name.trim());
        }}
      >
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={() => answer(undefined)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Add {label}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
