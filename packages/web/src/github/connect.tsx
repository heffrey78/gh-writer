import { ApiError, type DeviceCode, type GitHubStatus } from "@gh-writer/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { api } from "../api.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Modal } from "../ui/dialog.tsx";

export const githubKey = ["github"] as const;

/** The connection's status, shared by every control that shows it. */
export function useGitHub() {
  return useQuery({ queryKey: githubKey, queryFn: api.github.account, staleTime: 60_000 });
}

/** The Connect GitHub dialog, opened from anywhere; `then` runs once connected (e.g. sync again). */
export const useConnect = create<{ open: boolean; then: (() => void) | undefined; show: (then?: () => void) => void; hide: () => void }>((set) => ({
  open: false,
  then: undefined,
  show: (then) => set({ open: true, then }),
  hide: () => set({ open: false, then: undefined }),
}));

/** GitHub's mark, in the current colour. */
export function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/**
 * The account control in the top bar: Connect GitHub while signed out (Reconnect after GitHub stopped
 * accepting the sign-in), and once signed in the login, with Sign out in its menu.
 */
export function AccountMenu() {
  const github = useGitHub();
  const show = useConnect((s) => s.show);
  const queryClient = useQueryClient();
  // The server says "expired" once; keep showing it until the author connects again.
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (github.data?.expired) setExpired(true);
    if (github.data?.signedIn) setExpired(false);
  }, [github.data]);
  const signOut = useMutation({ mutationFn: api.github.signOut, onSuccess: (status) => queryClient.setQueryData(githubKey, status) });
  // The menu opens inside the top bar's landmark, not at the end of the page.
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const item = "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent-soft";

  if (!github.data) return null;
  const { signedIn, account, offline } = github.data;
  if (!signedIn) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className={cn(expired && "text-warn")}
        title={expired ? "GitHub stopped accepting gh-writer's sign-in (it was revoked or has expired)." : undefined}
        onClick={() => show()}
      >
        <GitHubMark className="size-4" />
        {expired ? "Reconnect GitHub" : "Connect GitHub"}
      </Button>
    );
  }
  const login = account?.login;
  return (
    <span ref={setAnchor}>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <Button size="sm" variant="ghost" aria-label={login ? `GitHub account: ${login}` : "GitHub account"}>
            <GitHubMark className="size-4" />
            <span className="max-w-32 truncate">{login ?? "GitHub"}</span>
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal container={anchor}>
          <DropdownMenu.Content align="end" sideOffset={4} className="z-50 grid min-w-56 rounded-md border border-rule bg-raised p-1 text-ink shadow-lg">
            <DropdownMenu.Label className="px-2 py-1.5 text-sm">
              {login ? (
                <>
                  Signed in to GitHub as <span className="font-semibold">{login}</span>
                </>
              ) : (
                "Signed in to GitHub"
              )}
              {offline && <span className="block text-xs text-muted">GitHub can't be reached right now.</span>}
            </DropdownMenu.Label>
            <DropdownMenu.Separator className="my-1 h-px bg-rule" />
            <DropdownMenu.Item className={item} onSelect={() => signOut.mutate()}>
              Sign out of GitHub
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </span>
  );
}

type Step = { kind: "choose" } | { kind: "code"; code: DeviceCode; outcome?: "expired" | "denied" };

/**
 * Connect gh-writer to GitHub: with gh's account when the gh CLI is signed in, or with a code the
 * author enters on github.com (the device flow), polled until GitHub says yes, no, or time's up.
 */
export function ConnectDialog() {
  const { open, then, hide } = useConnect();
  if (!open) return null;
  return <Connect then={then} onClose={hide} />;
}

function Connect({ then, onClose }: { then: (() => void) | undefined; onClose: () => void }) {
  const queryClient = useQueryClient();
  const github = useQuery({ queryKey: githubKey, queryFn: api.github.account, staleTime: 0 });
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [copied, setCopied] = useState(false);
  const closed = useRef(false);
  useEffect(() => () => void (closed.current = true), []);

  const connected = (status: GitHubStatus) => {
    queryClient.setQueryData(githubKey, status);
    onClose();
    then?.();
  };
  const start = useMutation({ mutationFn: api.github.startDevice, onSuccess: (code) => setStep({ kind: "code", code }) });
  const gh = useMutation({ mutationFn: api.github.useGh, onSuccess: connected });
  const [pollError, setPollError] = useState<Error>();

  // Ask GitHub every `interval` seconds whether the code has been entered.
  const code = step.kind === "code" && !step.outcome ? step.code : undefined;
  useEffect(() => {
    if (!code) return;
    let timer: ReturnType<typeof setTimeout>;
    let interval = code.interval;
    const poll = async () => {
      try {
        const result = await api.github.pollDevice();
        if (closed.current) return;
        if (result.status === "done") return connected(result.account);
        if (result.status === "pending") {
          interval = result.interval;
          timer = setTimeout(() => void poll(), Math.max(interval, 0.25) * 1000);
          return;
        }
        setStep({ kind: "code", code, outcome: result.status === "denied" ? "denied" : "expired" });
      } catch (e) {
        if (!closed.current) setPollError(e instanceof Error ? e : new Error(String(e)));
      }
    };
    timer = setTimeout(() => void poll(), Math.max(interval, 0.25) * 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one polling loop per code
  }, [code]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const status = github.data;
  const error = start.error ?? gh.error ?? pollError;

  return (
    <Modal title="Connect to GitHub" onClose={onClose}>
      {step.kind === "choose" ? (
        <div className="grid gap-3 text-sm">
          <p className="text-muted">
            gh-writer uses your GitHub account to clone and sync your novels, and to put new ones on GitHub. Your sign-in is kept in this computer's keychain.
          </p>
          {status?.keychain && <ErrorAlert title="The keychain can't be reached">{status.keychain}</ErrorAlert>}
          {status?.gh && (
            <Button variant="primary" disabled={gh.isPending} onClick={() => gh.mutate()} className="justify-self-start">
              <GitHubMark className="size-4" /> Use gh's account ({status.gh.login})
            </Button>
          )}
          {status?.deviceFlow ? (
            <Button variant={status.gh ? "secondary" : "primary"} disabled={start.isPending} onClick={() => start.mutate()} className="justify-self-start">
              {start.isPending ? "Asking GitHub…" : "Sign in with a code"}
            </Button>
          ) : (
            status &&
            !status.gh && (
              <p>
                Signing in with a code isn't set up in this copy of gh-writer yet. Sign in with the GitHub CLI instead (<code className="font-mono">gh auth login</code>), then come back.
              </p>
            )
          )}
        </div>
      ) : (
        <div className="grid gap-3 text-sm">
          {step.outcome ? (
            <>
              <p role="status">{step.outcome === "denied" ? "The sign-in was cancelled on GitHub." : "The code expired before it was entered."}</p>
              <Button variant="primary" onClick={() => start.mutate()} disabled={start.isPending} className="justify-self-start">
                Get a new code
              </Button>
            </>
          ) : (
            <>
              <p>Enter this code on GitHub:</p>
              <div className="flex items-center gap-2">
                <output aria-label="Your code" className="rounded-md border border-rule bg-panel px-3 py-1.5 font-mono text-xl tracking-[0.2em]">
                  {step.code.userCode}
                </output>
                <Button size="sm" onClick={() => void copy(step.code.userCode)} aria-label="Copy the code">
                  {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <a href={step.code.verificationUri} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 justify-self-start text-accent underline-offset-2 hover:underline">
                Open {step.code.verificationUri.replace(/^https?:\/\//, "")} <ExternalLink className="size-3.5" aria-hidden />
              </a>
              <p className="text-muted" role="status">
                Waiting for you to enter the code on GitHub…
              </p>
            </>
          )}
        </div>
      )}
      {error && (
        <ErrorAlert title="Couldn't connect to GitHub">{error instanceof ApiError || error instanceof Error ? error.message : String(error)}</ErrorAlert>
      )}
      <div className="flex justify-end">
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Modal>
  );
}
