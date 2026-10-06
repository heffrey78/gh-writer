import { create } from "zustand";

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "ghw:theme";

function stored(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** Light or dark follows the OS unless the author picks one; the choice is this browser's own. */
export const useTheme = create<{ theme: ThemeChoice; setTheme: (t: ThemeChoice) => void }>((set) => ({
  theme: stored(),
  setTheme: (theme) => {
    try {
      if (theme === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch {
      // Storage blocked: the choice lasts this page.
    }
    apply(theme);
    set({ theme });
  },
}));

export function apply(theme: ThemeChoice = useTheme.getState().theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
