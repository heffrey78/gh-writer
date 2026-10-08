import { ApiError } from "@gh-writer/client";
import { slugify } from "@gh-writer/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { create } from "zustand";
import { api, keys } from "../api.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { Modal } from "../ui/dialog.tsx";
import { Field } from "../ui/field.tsx";
import { GitHubMark, useConnect, useGitHub } from "./connect.tsx";

/** The Put on GitHub dialog, for one novel, opened from its sync badge or its book on the shelf. */
export const usePublish = create<{ novel: { id: string; folder: string } | undefined; show: (novel: { id: string; folder: string }) => void; hide: () => void }>((set) => ({
  novel: undefined,
  show: (novel) => set({ novel }),
  hide: () => set({ novel: undefined }),
}));

export function PublishDialog() {
  const { novel, hide } = usePublish();
  return novel ? <Publish key={novel.id} novel={novel} onClose={hide} /> : null;
}

/** The repository name a folder suggests: its name, as GitHub would accept it. */
const suggest = (folder: string) => slugify(folder.split(/[\\/]/).filter(Boolean).pop() ?? "") || "novel";

/**
 * Put a novel that is only on this computer on GitHub: a new repository, private unless the author
 * says otherwise, which the novel then syncs with. Signed out, it connects first and comes back.
 */
function Publish({ novel, onClose }: { novel: { id: string; folder: string }; onClose: () => void }) {
  const queryClient = useQueryClient();
  const github = useGitHub();
  const [name, setName] = useState(suggest(novel.folder));
  const [description, setDescription] = useState("");
  const [priv, setPriv] = useState(true);
  const publish = useMutation({
    mutationFn: () => api.github.publish(novel.id, { name: name.trim(), private: priv, ...(description.trim() ? { description: description.trim() } : {}) }),
    onSuccess: async ({ status }) => {
      queryClient.setQueryData(keys.sync(novel.id), status);
      await queryClient.invalidateQueries({ queryKey: keys.library });
      onClose();
    },
  });
  const connect = () => {
    onClose();
    useConnect.getState().show(() => usePublish.getState().show(novel));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) publish.mutate();
  };
  const signedIn = github.data?.signedIn;
  const login = github.data?.account?.login;
  const needsSignIn = publish.error instanceof ApiError && publish.error.code === "NO_SIGN_IN";

  return (
    <Modal title="Put on GitHub" onClose={onClose}>
      {github.data && !signedIn ? (
        <div className="grid gap-3 text-sm">
          <p>Connect gh-writer to GitHub first. The novel will go in a new repository on your account.</p>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={connect}>
              <GitHubMark className="size-4" /> Connect GitHub
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="grid gap-3">
          <p className="text-sm text-muted">
            A new repository{login ? <> on <span className="font-medium text-ink">{login}</span>'s account</> : null} for this novel. From then on it syncs with it, and you can work on it from any computer.
          </p>
          <Field
            label="Repository name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            pattern="[A-Za-z0-9._\-]+"
            hint={login ? `github.com/${login}/${name.trim() || "…"}` : undefined}
          />
          <Field label="Description" value={description} onChange={(e) => setDescription(e.target.value)} hint="Optional." />
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} className="mt-0.5" />
            <span>
              <span className="font-medium">Private</span>
              <span className="block text-xs text-muted">Only you, and people you invite, can see it. Untick to make it public.</span>
            </span>
          </label>
          {publish.isError && (
            <ErrorAlert title="Couldn't put it on GitHub">
              {publish.error.message}
              {needsSignIn && (
                <Button size="sm" className="mt-2" onClick={connect}>
                  Connect GitHub
                </Button>
              )}
            </ErrorAlert>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!name.trim() || publish.isPending}>
              {publish.isPending ? "Putting it on GitHub…" : "Create and push"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
