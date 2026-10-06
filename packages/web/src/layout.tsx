import type { ReactNode } from "react";
import { Link } from "react-router";
import { useTheme, type ThemeChoice } from "./theme.ts";
import { cn } from "./ui/cn.ts";

/** The app's frame: a skip link, the top bar (home, page actions, theme), and the page. */
export function Shell({ actions, children, wide }: { actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-raised focus:px-3 focus:py-2">
        Skip to content
      </a>
      <header className="flex items-center gap-3 border-b border-rule bg-panel px-4 py-2">
        <Link to="/" className="flex items-center gap-2 rounded-md px-1 font-semibold">
          <Logo />
          gh-writer
        </Link>
        <div className="flex flex-1 items-center justify-end gap-2">
          {actions}
          <ThemeSelect />
        </div>
      </header>
      <main id="main" tabIndex={-1} className={cn("flex-1 outline-none", !wide && "mx-auto w-full max-w-4xl px-4 py-8")}>
        {children}
      </main>
    </div>
  );
}

function ThemeSelect() {
  const { theme, setTheme } = useTheme();
  return (
    <label className="flex items-center gap-1.5 text-sm text-muted">
      Theme
      <select
        value={theme}
        onChange={(e) => setTheme(e.target.value as ThemeChoice)}
        className="h-8 rounded-md border border-rule bg-raised px-2 text-sm text-ink"
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}

/** The mark, drawn in the theme's ink and paper so it holds up in both themes. */
function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="size-5" aria-hidden>
      <rect width="32" height="32" rx="7" fill="var(--ghw-ink)" />
      <path d="M9 23c5-1 9-6 12-14l2 1c-2 8-7 13-13 15z" fill="var(--ghw-paper)" />
      <path d="M8 24h16" stroke="var(--ghw-paper)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
