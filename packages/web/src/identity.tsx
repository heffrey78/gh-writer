import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { create } from "zustand";
import { api, keys } from "./api.ts";
import { ErrorAlert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { Modal } from "./ui/dialog.tsx";
import { Field } from "./ui/field.tsx";

/** Whether the name-and-email dialog is open: from the ⋯ menu, the palette, a blocked commit, or the first run. */
export const useIdentityDialog = create<{ open: boolean; show: () => void; hide: () => void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));

export function useIdentity() {
  return useQuery({ queryKey: keys.identity, queryFn: api.identity, staleTime: Infinity });
}

const ASKED = "ghw:identity-asked";

/**
 * The first time the app opens on a computer where git doesn't know the writer, and they're signed
 * in to GitHub, ask once, with the account's name and noreply address filled in (#186).
 */
export function FirstRunIdentity() {
  const identity = useIdentity().data;
  useEffect(() => {
    if (!identity || identity.identity || !identity.suggestion) return;
    try {
      if (localStorage.getItem(ASKED)) return;
      localStorage.setItem(ASKED, "1");
    } catch {
      // Storage blocked: ask this once anyway.
    }
    useIdentityDialog.getState().show();
  }, [identity]);
  return null;
}

/**
 * Your name and email: what git signs every saved change with, on this computer. Offers the GitHub
 * account's name and noreply address, which keeps the writer's own address out of the history.
 */
export function IdentityDialog() {
  const { open, hide } = useIdentityDialog();
  if (!open) return null;
  return <IdentityForm onClose={hide} />;
}

function IdentityForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const known = useIdentity().data;
  const start = known?.identity ?? known?.suggestion;
  const [name, setName] = useState(start?.name ?? "");
  const [email, setEmail] = useState(start?.email ?? "");
  // Fill in once the answer comes, unless the writer has started typing.
  useEffect(() => {
    if (!start) return;
    setName((n) => n || start.name);
    setEmail((e) => e || start.email);
  }, [start?.name, start?.email]);
  const save = useMutation({
    mutationFn: () => api.setIdentity({ name: name.trim(), email: email.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.identity });
      // Work that waited for a name and email has been committed.
      await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "sync" });
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && email.trim()) save.mutate();
  };
  const noreply = known?.suggestion && email.trim() === known.suggestion.email;

  return (
    <Modal title="Your name and email" onClose={onClose}>
      <form onSubmit={submit} className="grid gap-3">
        <p className="text-sm text-muted">
          Every change saved to your book's history is signed with a name and an email. They're kept with your novels, and are seen by anyone you share a novel
          with on GitHub.
        </p>
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          hint={noreply ? "Your GitHub account's private address: GitHub knows it's you, and your own address stays out of the history." : undefined}
        />
        {save.isError && <ErrorAlert title="Couldn't save them">{save.error.message}</ErrorAlert>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Not now</Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || !email.trim() || save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
