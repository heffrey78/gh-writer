import { ApiError, type Issue, type IssueFilter, type IssueInput, type IssueList } from "@gh-writer/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, keys } from "../api.ts";
import { githubKey, useConnect } from "../github/connect.tsx";
import { useNotice } from "../novel/notice.tsx";

/** The novel's issues matching `filter`, from gh-writer's cache (refetched when they change). */
export function useIssueList(novelId: string, filter: IssueFilter, { enabled = true } = {}) {
  return useQuery({ queryKey: [...keys.issues(novelId), "list", filter], queryFn: () => api.issues.list(novelId, filter), enabled });
}

/** One issue with its comments. One gh-writer hasn't fetched yet (a link to it) is looked for on GitHub first. */
export function useIssue(novelId: string, number: number) {
  return useQuery({
    queryKey: [...keys.issues(novelId), "issue", number],
    queryFn: async () => {
      try {
        return await api.issues.get(novelId, number);
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "NOT_FOUND")) throw e;
        await api.issues.refresh(novelId).catch(() => {});
        return api.issues.get(novelId, number);
      }
    },
    retry: false,
  });
}

/** The repository's labels and milestones, how the cache stands, and every issue (for which labels are in use). */
export function useIssueMeta(novelId: string): IssueList | undefined {
  return useIssueList(novelId, { state: "all" }).data;
}

/**
 * Changes to issues. A change GitHub refuses for the sign-in (signed out, or missing a permission)
 * offers to reconnect, and is tried again once connected; others are shown as a notice.
 */
export function useIssueChanges(novelId: string) {
  const queryClient = useQueryClient();
  const show = useNotice((n) => n.show);
  const settled = () => void queryClient.invalidateQueries({ queryKey: keys.issues(novelId) });
  const failed = (e: unknown, retry: () => void) => {
    if (e instanceof ApiError && e.code === "NO_SIGN_IN") {
      // The account's status has changed too: the views say so.
      void queryClient.invalidateQueries({ queryKey: githubKey });
      show({ message: e.message, action: { label: "Reconnect GitHub", run: () => useConnect.getState().show(retry) } });
      return;
    }
    show({ message: `Couldn't change the issue: ${e instanceof Error ? e.message : String(e)}` });
  };
  // The issue as GitHub answered, at once: a change made right after this one starts from it, not
  // from the copy shown before the refetch (which would undo this one).
  const keep = (issue: Issue, asked = issue.number) => {
    for (const n of new Set([asked, issue.number])) queryClient.setQueryData([...keys.issues(novelId), "issue", n], issue);
  };
  const create = useMutation({
    mutationFn: (input: IssueInput & { title: string }) => api.issues.create(novelId, input),
    onSuccess: (issue) => keep(issue),
    onSettled: settled,
  });
  const update = useMutation({
    mutationFn: ({ number, input }: { number: number; input: IssueInput }) => api.issues.update(novelId, number, input),
    onSuccess: (issue, { number }) => keep(issue, number),
    onSettled: settled,
  });
  const comment = useMutation({
    mutationFn: ({ number, body }: { number: number; body: string }) => api.issues.comment(novelId, number, body),
    onSettled: settled,
  });
  return {
    create: (input: IssueInput & { title: string }): Promise<Issue | undefined> =>
      create.mutateAsync(input).catch((e: unknown) => (failed(e, () => void create.mutate(input)), undefined)),
    update: (number: number, input: IssueInput): Promise<Issue | undefined> =>
      update.mutateAsync({ number, input }).catch((e: unknown) => (failed(e, () => void update.mutate({ number, input })), undefined)),
    comment: (number: number, body: string): Promise<boolean> =>
      comment
        .mutateAsync({ number, body })
        .then(() => true)
        .catch((e: unknown) => (failed(e, () => void comment.mutate({ number, body })), false)),
    busy: create.isPending || update.isPending || comment.isPending,
  };
}
