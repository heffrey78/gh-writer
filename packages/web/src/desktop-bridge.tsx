import { useQuery } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useAbout } from "./about.tsx";
import { api, keys } from "./api.ts";
import { chooseFolder, desktop, onShellCommand, reportRecent } from "./desktop.ts";
import { Button } from "./ui/button.tsx";

/** In the desktop app: runs the shell's commands in this page, and keeps its Open Recent menu current. */
export function DesktopBridge() {
  const navigate = useNavigate();
  const library = useQuery({ queryKey: keys.library, queryFn: api.library, enabled: desktop });
  useEffect(() => onShellCommand("go", (path) => path && void navigate(path)), [navigate]);
  useEffect(() => onShellCommand("about", () => useAbout.getState().set(true)), []);
  useEffect(() => {
    if (library.data) reportRecent(library.data.novels.slice(0, 10).map(({ id, title }) => ({ id, title })));
  }, [library.data]);
  return null;
}

/** Beside a folder field in the desktop app: choose the folder in the system's dialog instead of typing it. */
export function ChooseFolder({ title, onChosen }: { title: string; onChosen: (path: string) => void }) {
  if (!desktop) return null;
  return (
    <Button className="justify-self-start" onClick={() => void chooseFolder(title).then((path) => path && onChosen(path))}>
      <FolderOpen className="size-4" aria-hidden /> Choose…
    </Button>
  );
}
