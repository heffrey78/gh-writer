import type { SyncStatus } from "@gh-writer/client";
import { AlertTriangle, Check, CloudOff, GitMerge, KeyRound, Laptop, RefreshCw, type LucideIcon } from "lucide-react";
import { Popover } from "radix-ui";
import { useId } from "react";
import { ago } from "../format.ts";
import { useConnect } from "../github/connect.tsx";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";

function describe(s: SyncStatus): { label: string; icon: LucideIcon; tone: "ok" | "muted" | "warn" | "danger" } {
  switch (s.state) {
    case "synced":
      return { label: "Synced", icon: Check, tone: "ok" };
    case "syncing":
      return { label: "Syncing…", icon: RefreshCw, tone: "muted" };
    case "ahead":
      return { label: `${s.ahead} ahead`, icon: RefreshCw, tone: "muted" };
    case "behind":
      return { label: `${s.behind} behind`, icon: RefreshCw, tone: "muted" };
    case "offline":
      return { label: "Offline", icon: CloudOff, tone: "warn" };
    case "needs-sign-in":
      return { label: "Sign-in needed", icon: KeyRound, tone: "warn" };
    case "conflict":
      return { label: "Conflict", icon: GitMerge, tone: "danger" };
    case "local":
      return { label: "Local only", icon: Laptop, tone: "muted" };
    case "off":
      return { label: "Sync off", icon: Laptop, tone: "muted" };
    default:
      return { label: "Sync error", icon: AlertTriangle, tone: "danger" };
  }
}

const TONES = { ok: "text-ok", muted: "text-muted", warn: "text-warn", danger: "text-danger" } as const;

/** What a state means for the author, in a sentence. */
function explain(s: SyncStatus): string {
  switch (s.state) {
    case "synced":
      return "Everything is on GitHub, and this copy has everything from it.";
    case "syncing":
      return "Bringing in changes from GitHub and sending yours.";
    case "ahead":
      return `${s.ahead} change${s.ahead === 1 ? "" : "s"} on this computer will go to GitHub with the next sync.`;
    case "behind":
      return `GitHub has ${s.behind} change${s.behind === 1 ? "" : "s"} this copy doesn't have yet.`;
    case "offline":
      return "GitHub can't be reached. Keep writing: your work is saved here, and sync resumes by itself.";
    case "conflict":
      return "The same passage changed here and on GitHub. Choose what to keep; until then, both versions are safe.";
    case "local":
      return "This novel has no GitHub remote, so it's saved on this computer only.";
    case "off":
      return "Syncing is turned off.";
    default:
      return s.error?.message ?? "Sync stopped.";
  }
}

/** The sync state at a glance; its popover has the details, Sync now, and the way to conflicts. */
export function SyncBadge({
  status,
  onSyncNow,
  syncing,
  onResolve,
  onPublish,
}: {
  status: SyncStatus | undefined;
  onSyncNow: () => void;
  syncing: boolean;
  onResolve: () => void;
  /** Put a local-only novel on GitHub. */
  onPublish?: () => void;
}) {
  const headingId = useId();
  if (!status) return null;
  const { label, icon: Icon, tone } = describe(status);
  const busy = syncing || status.state === "syncing";
  const commit = status.commit;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="sm" aria-label={`Sync: ${label}`}>
          <Icon className={cn("size-4", TONES[tone], busy && "animate-spin")} aria-hidden />
          <span className={TONES[tone]}>{label}</span>
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} aria-labelledby={headingId} className="z-40 grid w-80 gap-3 rounded-lg border border-rule bg-raised p-4 text-sm text-ink shadow-lg">
          <div>
            <h2 id={headingId} className="font-semibold">
              Sync
            </h2>
            <p className="mt-1 text-muted">{explain(status)}</p>
            {status.error && status.state !== "conflict" && status.error.message !== explain(status) && <p className="mt-1">{status.error.message}</p>}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted">
            {status.lastSync !== undefined && (
              <>
                <dt>Last synced</dt>
                <dd className="text-ink">{status.lastSync ? ago(status.lastSync) : "not yet"}</dd>
              </>
            )}
            {commit.state !== "off" && (
              <>
                <dt>Saved work</dt>
                <dd className="text-ink">
                  {commit.blocked
                    ? commit.blocked.message
                    : commit.pendingChanges
                      ? `${commit.pendingChanges} file${commit.pendingChanges === 1 ? "" : "s"} waiting to be committed`
                      : "All committed"}
                </dd>
              </>
            )}
            {commit.lastCommit && (
              <>
                <dt>Last commit</dt>
                <dd className="truncate text-ink" title={commit.lastCommit.summary}>
                  {commit.lastCommit.summary}
                </dd>
              </>
            )}
          </dl>
          <div className="flex gap-2">
            {status.state === "local" && onPublish && (
              <Popover.Close asChild>
                <Button variant="primary" onClick={onPublish}>
                  Put on GitHub…
                </Button>
              </Popover.Close>
            )}
            {status.state === "needs-sign-in" && (
              <Popover.Close asChild>
                <Button variant="primary" onClick={() => useConnect.getState().show(onSyncNow)}>
                  Connect GitHub…
                </Button>
              </Popover.Close>
            )}
            {status.state === "conflict" && (
              <Popover.Close asChild>
                <Button variant="primary" onClick={onResolve}>
                  Resolve conflicts…
                </Button>
              </Popover.Close>
            )}
            {status.state !== "off" && status.state !== "local" && (
              <Button onClick={onSyncNow} disabled={busy}>
                {busy ? "Syncing…" : "Sync now"}
              </Button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
