import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api, keys } from "./api.ts";
import { useCommands } from "./commands.ts";
import { APP_KEYS, useOverlay } from "./palette.tsx";
import { useTheme, type ThemeChoice } from "./theme.ts";

/** Commands available everywhere: the library, each novel, the theme, the shortcut reference. */
export function GlobalCommands() {
  const navigate = useNavigate();
  const library = useQuery({ queryKey: keys.library, queryFn: api.library, staleTime: 30_000 });
  const novels = library.data?.novels ?? [];
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
      { id: "app.shortcuts", title: "Keyboard shortcuts", group: "App", keys: APP_KEYS[1]!.keys, run: () => useOverlay.getState().set("shortcuts") },
    ],
    [navigate, novels],
  );
  return null;
}
