import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api, keys } from "./api.ts";
import { githubKey, useConnect, useGitHub } from "./github/connect.tsx";
import { useCommands } from "./commands.ts";
import { APP_KEYS, useOverlay } from "./palette.tsx";
import { useTheme, type ThemeChoice } from "./theme.ts";

/** Commands available everywhere: the library, each novel, the theme, the shortcut reference. */
export function GlobalCommands() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const library = useQuery({ queryKey: keys.library, queryFn: api.library, staleTime: 30_000 });
  const novels = library.data?.novels ?? [];
  const github = useGitHub();
  const signedIn = github.data?.signedIn ?? false;
  useCommands(
    () => [
      { id: "app.library", title: "Go to your novels", group: "Go to", run: () => void navigate("/") },
      { id: "app.new", title: "New novel…", group: "Novels", keywords: ["start", "create"], run: () => void navigate("/?add=new") },
      { id: "app.open-folder", title: "Open a novel's folder…", group: "Novels", keywords: ["add"], run: () => void navigate("/?add=open") },
      { id: "app.clone", title: "Clone a novel from GitHub…", group: "Novels", keywords: ["add", "repository"], run: () => void navigate("/?add=clone") },
      ...novels.map((n) => ({ id: `app.open.${n.id}`, title: `Open “${n.title}”`, group: "Novels", keywords: [n.path], run: () => void navigate(`/novels/${n.id}`) })),
      ...(["system", "light", "dark"] as ThemeChoice[]).map((t) => ({
        id: `app.theme.${t}`,
        title: `Theme: ${t === "system" ? "follow the system" : t}`,
        group: "App",
        run: () => useTheme.getState().setTheme(t),
        isActive: () => useTheme.getState().theme === t,
      })),
      signedIn
        ? {
            id: "app.github.sign-out",
            title: "Sign out of GitHub",
            group: "App",
            run: () => void api.github.signOut().then((status) => queryClient.setQueryData(githubKey, status)),
          }
        : { id: "app.github.connect", title: "Connect to GitHub…", group: "App", keywords: ["sign in", "log in", "account"], run: () => useConnect.getState().show() },
      { id: "app.shortcuts", title: "Keyboard shortcuts", group: "App", keys: APP_KEYS[1]!.keys, run: () => useOverlay.getState().set("shortcuts") },
    ],
    [navigate, novels, signedIn, queryClient],
  );
  return null;
}
