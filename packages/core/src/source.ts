/** Read-only view of a novel repository. Paths are repository-relative and use "/". */
export interface FileSource {
  /** Entries of a directory ("" is the root), sorted by name. Empty if the directory is missing. */
  list(dir: string): Promise<DirEntry[]>;
  /** File contents, or undefined if the file is missing. */
  read(path: string): Promise<string | undefined>;
}

export interface DirEntry {
  name: string;
  dir: boolean;
}

export function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join("/");
}

/** An in-memory FileSource, for tests and for the browser. Hidden (dot) entries are listed like any other. */
export function memorySource(files: Record<string, string>): FileSource {
  const paths = Object.keys(files);
  return {
    async list(dir) {
      const prefix = dir ? `${dir}/` : "";
      const entries = new Map<string, boolean>();
      for (const p of paths) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) entries.set(rest, false);
        else entries.set(rest.slice(0, slash), true);
      }
      return [...entries].map(([name, isDir]) => ({ name, dir: isDir })).sort((a, b) => a.name.localeCompare(b.name));
    },
    async read(path) {
      return files[path];
    },
  };
}
