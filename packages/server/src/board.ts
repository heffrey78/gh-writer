import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { countWords, editFrontMatter, type Novel, type SceneStatus } from "@gh-writer/core";
import { git } from "./git.ts";
import { GitHubError, type GitHub, type GitHubRepo } from "./github.ts";
import type { TextFile } from "./files.ts";
import type { WriteResult } from "./workspace.ts";

/*
 * The drafting board (#11, D8): the main version's scenes mirrored to a GitHub Project, one draft
 * item per scene, so drafting progress has GitHub's board, table and roadmap views. The scene files
 * stay authoritative (D1). Only Status flows back from the board, merged three ways against the
 * status last synced from this clone; a status changed on both sides to different values is a
 * conflict that waits for the author. Every other field is put back from the files. What this
 * clone knows (the project, the last-synced values) is kept in .git/gh-writer/board.json, never
 * committed: deleting it, or the project, loses no story data.
 */

export const STATUSES: SceneStatus[] = ["idea", "outlined", "drafted", "revised", "final"];
const STATUS_NAMES: Record<SceneStatus, string> = { idea: "Idea", outlined: "Outlined", drafted: "Drafted", revised: "Revised", final: "Final" };
const STATUS_COLOURS: Record<SceneStatus, string> = { idea: "GRAY", outlined: "BLUE", drafted: "YELLOW", revised: "ORANGE", final: "GREEN" };
const STATUS_DESCRIPTIONS: Record<SceneStatus, string> = {
  idea: "A scene not yet planned",
  outlined: "Planned, not yet written",
  drafted: "Written in a first draft",
  revised: "Rewritten after a draft",
  final: "Done",
};
/** The options GitHub gives a new project's Status field: replaced by the scene statuses. */
const STOCK_STATUS = ["todo", "in progress", "done"];
/** The field of gh-writer's own that holds the status where the project's Status field can't be changed. */
const OWN_STATUS = "Scene status";

/** The fields gh-writer keeps, by the names they have on the board. */
const FIELD = { pov: "POV", part: "Part", chapter: "Chapter", words: "Words", order: "Order", scene: "Scene ID" } as const;
type Mirrored = "title" | "pov" | "part" | "chapter" | "words" | "order";
const MIRRORED: Mirrored[] = ["title", "pov", "part", "chapter", "words", "order"];
const FIELD_NAMES: Record<Mirrored, string> = { title: "Title", pov: FIELD.pov, part: FIELD.part, chapter: FIELD.chapter, words: FIELD.words, order: FIELD.order };

/** How many mutations go to GitHub in one request. */
const BATCH = 20;
const MARKER = /<!--\s*gh-writer-board:\s*(\S+)\s*-->/;

export type BoardErrorCode = "BAD_REQUEST" | "NOT_ON_GITHUB" | "NOT_SET_UP" | "NOT_MAIN" | "GONE" | "NO_SIGN_IN" | "NEEDS_SCOPE" | "OFFLINE" | "RATE_LIMITED" | "NOT_FOUND" | "GITHUB";

export class BoardError extends Error {
  readonly code: BoardErrorCode;
  readonly resetAt: string | undefined;

  constructor(code: BoardErrorCode, message: string, resetAt?: string) {
    super(message);
    this.name = "BoardError";
    this.code = code;
    this.resetAt = resetAt;
  }
}

/** A scene whose status was changed both in its file and on the board, to different values, since the last sync. */
export interface BoardConflict {
  scene: string;
  title: string;
  file: SceneStatus;
  board: SceneStatus;
}

/** What one sync did. */
export interface BoardSummary {
  /** Items made for new scenes, and removed for scenes that are gone. */
  added: number;
  removed: number;
  /** Items whose fields were brought up to date from the files. */
  updated: number;
  /** Scenes whose status was changed on the board, now in their files. */
  fromBoard: { scene: string; title: string; status: SceneStatus }[];
  /** Board edits to fields the files own, put back. */
  putBack: { scene: string; title: string; fields: string[] }[];
}

export interface BoardProject {
  number: number;
  title: string;
  url: string;
}

export interface BoardStatus {
  repo: GitHubRepo | null;
  /** The novel's project, once made or found. */
  project: BoardProject | null;
  syncedAt: string | null;
  /** What the last sync did. */
  last: BoardSummary | null;
  conflicts: BoardConflict[];
  /** Why the last sync didn't happen or failed. */
  error?: { code: BoardErrorCode; message: string; resetAt?: string };
  /** The project was there, and has been deleted on GitHub. */
  gone?: boolean;
}

/** What gh-writer last put on the board for a scene, or read back from it. */
interface Synced {
  /** Null when unknown (a board found by a fresh clone): then any difference is a conflict. */
  status: SceneStatus | null;
  title: string;
  pov: string | null;
  part: string | null;
  chapter: string | null;
  words: number;
  order: number;
}

interface State {
  /** owner/name: a state for another repository is started afresh. */
  repo: string;
  project: (BoardProject & { id: string }) | null;
  gone: boolean;
  /** Scene ID → what was last synced. */
  base: Record<string, Synced>;
  conflicts: BoardConflict[];
  syncedAt: string | null;
  last: BoardSummary | null;
}

export interface BoardDeps {
  /** The story model. */
  novel: () => Promise<Novel>;
  /** Whether the main version is open (the board follows it alone). */
  onMain: () => Promise<boolean>;
  read: (path: string) => Promise<TextFile | undefined>;
  /** A conflict-checked write that open editors hear of as an outside change. */
  write: (path: string, content: string, base: string) => Promise<WriteResult>;
}

interface Field {
  id: string;
  name: string;
  dataType: string;
  options?: { id: string; name: string; color: string; description: string }[];
}

interface Item {
  id: string;
  type: string;
  draftId: string | undefined;
  title: string;
  /** field ID → text, number, or a single-select option's ID. */
  values: Map<string, string | number>;
}

interface Board {
  id: string;
  number: number;
  title: string;
  url: string;
  fields: Field[];
  items: Item[];
}

/** A GraphQL enum value, written without quotes. */
class Enum {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }
}
type Literal = string | number | boolean | null | Enum | Literal[] | { [key: string]: Literal | undefined };

/** A value as a GraphQL literal: mutations go in batches, so their inputs are written out rather than declared. */
function literal(value: Literal): string {
  if (value instanceof Enum) return value.name;
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  return `{ ${Object.entries(value)
    .filter((e): e is [string, Literal] => e[1] !== undefined)
    .map(([k, v]) => `${k}: ${literal(v)}`)
    .join(", ")} }`;
}

const PROJECT_FIELDS = `fields(first: 50) {
  nodes {
    ... on ProjectV2FieldCommon { id name dataType }
    ... on ProjectV2SingleSelectField { options { id name color description } }
  }
}`;

const READ = `query($id: ID!, $after: String) {
  node(id: $id) {
    ... on ProjectV2 {
      id number title url
      ${PROJECT_FIELDS}
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id type
          content { ... on DraftIssue { id title } ... on Issue { title } }
          fieldValues(first: 30) {
            nodes {
              ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id } } }
              ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { id } } }
              ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2FieldCommon { id } } }
            }
          }
        }
      }
    }
  }
}`;

const FIND = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    owner { id }
    projectsV2(first: 50) { nodes { id number title url readme } }
  }
}`;

interface GhField {
  id: string;
  name: string;
  dataType: string;
  options?: Field["options"];
}

interface GhItem {
  id: string;
  type: string;
  content: { id?: string; title?: string } | null;
  fieldValues: { nodes: ({ text?: string | null; number?: number | null; optionId?: string | null; field?: { id?: string } } | null)[] };
}

interface GhProject {
  id: string;
  number: number;
  title: string;
  url: string;
  fields: { nodes: (GhField | null)[] };
  items: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: (GhItem | null)[] };
}

export class BoardStore {
  readonly root: string;
  #github: GitHub;
  #repo: () => Promise<GitHubRepo | null>;
  #deps: BoardDeps;
  #state: State | undefined;
  #file: string | undefined;
  #error: BoardStatus["error"];
  #syncing: Promise<BoardStatus> | undefined;
  #again: Promise<BoardStatus> | undefined;
  #listeners = new Set<() => void>();
  #saving: Promise<void> = Promise.resolve();
  /** Whether this session has looked for a board made by another clone (once is enough). */
  #searched = false;

  constructor(root: string, github: GitHub, repo: () => Promise<GitHubRepo | null>, deps: BoardDeps) {
    this.root = root;
    this.#github = github;
    this.#repo = repo;
    this.#deps = deps;
  }

  /** Hear when the board's status changes. Returns a function that stops it. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  async status(): Promise<BoardStatus> {
    const { state, repo } = await this.#load();
    return {
      repo,
      project: state.project && { number: state.project.number, title: state.project.title, url: state.project.url },
      syncedAt: state.syncedAt,
      last: state.last,
      conflicts: state.conflicts,
      ...(this.#error ? { error: this.#error } : {}),
      ...(state.gone ? { gone: true } : {}),
    };
  }

  /** Whether the novel has a board (made here, or found on GitHub by an earlier sync). */
  async isSetUp(): Promise<boolean> {
    return Boolean((await this.#load()).state.project);
  }

  /**
   * Make the novel's project on GitHub, or adopt the one already marked as the novel's, and sync it.
   * The project belongs to the repository's owner and is linked to the repository.
   */
  async setUp(): Promise<BoardStatus> {
    await this.#run(async () => {
      const { state, repo } = await this.#load();
      if (!repo) throw new BoardError("NOT_ON_GITHUB", "This novel isn't on GitHub yet. Publish it first.");
      const novel = await this.#deps.novel();
      if (!state.project) {
        const found = await this.#find(repo, novel);
        state.project = found.project ?? (await this.#create(found, novel));
        state.gone = false;
        state.base = {};
        state.conflicts = [];
        state.syncedAt = null;
        state.last = null;
        await this.#save();
      }
    });
    return this.sync();
  }

  /**
   * Bring the board and the scene files into step. Resolves to the status; a failure is kept in it
   * (and the board left as it was) rather than thrown, since this runs in the background too.
   */
  sync(): Promise<BoardStatus> {
    // Asked again while one is under way: one more follows it, shared by everyone asking meanwhile.
    if (this.#syncing) {
      this.#again ??= this.#syncing
        .catch(() => undefined)
        .then(() => {
          this.#again = undefined;
          return this.sync();
        });
      return this.#again;
    }
    this.#syncing = this.#run(() => this.#sync())
      .catch(() => {})
      .then(() => this.status())
      .finally(() => (this.#syncing = undefined));
    return this.#syncing;
  }

  /**
   * Settle a conflict: keep the file's status (it goes to the board) or the board's (it goes to the
   * file). Done by taking the other side as the last-synced one, so the sync that follows copies it.
   */
  async resolve(scene: string, keep: "file" | "board"): Promise<BoardStatus> {
    const { state } = await this.#load();
    const conflict = state.conflicts.find((c) => c.scene === scene);
    if (!conflict) throw new BoardError("NOT_FOUND", "That scene's status doesn't disagree with the board any more.");
    // A conflict's scene always has a last-synced record: the sync that found the conflict made it.
    const base = state.base[scene];
    if (base) base.status = keep === "file" ? conflict.board : conflict.file;
    state.conflicts = state.conflicts.filter((c) => c !== conflict);
    await this.#save();
    this.#changed();
    return this.sync();
  }

  /** Run `task`, keeping its failure in the status. */
  async #run(task: () => Promise<void>): Promise<void> {
    try {
      await task();
      this.#error = undefined;
    } catch (e) {
      const error = asBoardError(e);
      this.#error = { code: error.code, message: error.message, ...(error.resetAt ? { resetAt: error.resetAt } : {}) };
      throw error;
    } finally {
      this.#changed();
    }
  }

  async #sync(): Promise<void> {
    const { state, repo } = await this.#load();
    if (!repo) throw new BoardError("NOT_ON_GITHUB", "This novel isn't on GitHub yet. Publish it first.");
    if (!(await this.#deps.onMain())) throw new BoardError("NOT_MAIN", "The board follows the main version: open it to sync the board.");
    const novel = await this.#deps.novel();
    if (!state.project && !state.gone && !this.#searched) {
      // Another clone may have made it: the repository's linked projects say (asked once a session).
      const found = await this.#find(repo, novel);
      this.#searched = true;
      if (found.project) {
        state.project = found.project;
        state.base = {};
      }
    }
    if (!state.project) {
      if (state.gone) throw new BoardError("GONE", "The novel's board has been deleted on GitHub. Make a new one to carry on.");
      throw new BoardError("NOT_SET_UP", "This novel has no board on GitHub yet.");
    }

    const board = await this.#read(state.project.id);
    if (!board) {
      // Deleted on GitHub: nothing of the story was there, so nothing is lost. Offer a new one.
      state.project = null;
      state.gone = true;
      state.base = {};
      state.conflicts = [];
      state.syncedAt = null;
      state.last = null;
      await this.#save();
      throw new BoardError("GONE", "The novel's board has been deleted on GitHub. Make a new one to carry on.");
    }
    state.project = { id: board.id, number: board.number, title: board.title, url: board.url };

    const wanted = desired(novel);
    const fields = await this.#ensureFields(board, wanted);
    const summary: BoardSummary = { added: 0, removed: 0, updated: 0, fromBoard: [], putBack: [] };
    const mutations: string[] = [];
    const projectId = board.id;

    // Items by the scene they're for; gh-writer's items for scenes that are gone, and duplicates, go.
    const byScene = new Map<string, Item>();
    for (const item of board.items) {
      const scene = item.values.get(fields.scene.id);
      if (typeof scene !== "string" || !scene) continue; // not gh-writer's: left alone
      if (!wanted.has(scene) || byScene.has(scene)) {
        mutations.push(`deleteProjectV2Item(input: ${literal({ projectId, itemId: item.id })}) { deletedItemId }`);
        summary.removed++;
        delete state.base[scene];
        continue;
      }
      byScene.set(scene, item);
    }

    // Items for new scenes, made first: their IDs are needed to set their fields.
    const missing = [...wanted.values()].filter((w) => !byScene.has(w.id));
    const made = await this.#mutate(missing.map((w) => `addProjectV2DraftIssue(input: ${literal({ projectId, title: w.synced.title })}) { projectItem { id content { ... on DraftIssue { id } } } }`));
    missing.forEach((w, i) => {
      const item = (made[i] as { projectItem: { id: string; content: { id?: string } | null } }).projectItem;
      byScene.set(w.id, { id: item.id, type: "DRAFT_ISSUE", draftId: item.content?.id, title: w.synced.title, values: new Map() });
      summary.added++;
    });

    const conflicts: BoardConflict[] = [];
    const set = (item: Item, field: Field, value: string | number | null) => {
      const current = item.values.get(field.id);
      if (value === null) {
        if (current !== undefined) mutations.push(`clearProjectV2ItemFieldValue(input: ${literal({ projectId, itemId: item.id, fieldId: field.id })}) { projectV2Item { id } }`);
        return current !== undefined;
      }
      let input: Literal;
      if (field.dataType === "SINGLE_SELECT") {
        const option = field.options?.find((o) => o.name.toLowerCase() === String(value).toLowerCase());
        if (!option || current === option.id) return false;
        input = { singleSelectOptionId: option.id };
      } else if (field.dataType === "NUMBER") {
        if (current === value) return false;
        input = { number: Number(value) };
      } else {
        if (current === String(value)) return false;
        input = { text: String(value) };
      }
      mutations.push(`updateProjectV2ItemFieldValue(input: ${literal({ projectId, itemId: item.id, fieldId: field.id, value: input })}) { projectV2Item { id } }`);
      return true;
    };

    for (const w of wanted.values()) {
      const item = byScene.get(w.id)!;
      const isNew = missing.includes(w);
      const base = state.base[w.id];
      const onBoard = readItem(item, fields);
      let status = w.synced.status;

      // Status, three ways: whichever side changed since the last sync wins; both, to different values, is a conflict.
      const boardStatus = onBoard.status;
      if (!isNew && boardStatus && boardStatus !== status) {
        const fileChanged = !base?.status || base.status !== status;
        const boardChanged = !base?.status || base.status !== boardStatus;
        if (fileChanged && boardChanged) {
          conflicts.push({ scene: w.id, title: w.synced.title, file: status, board: boardStatus });
          status = boardStatus; // left as it is on the board, for now
        } else if (boardChanged) {
          if (await this.#writeStatus(w.file, boardStatus)) {
            summary.fromBoard.push({ scene: w.id, title: w.synced.title, status: boardStatus });
            status = boardStatus;
          } else status = boardStatus; // the file changed meanwhile: the next sync sees it
        }
      }
      let changed = set(item, fields.status, STATUS_NAMES[status]);

      // Everything else is the files': board edits are put back, and said so.
      const edited: string[] = [];
      // A status that isn't a scene's (an option the author added) can't go in the file.
      if (!isNew && onBoard.statusName && !boardStatus) edited.push("Status");
      for (const key of MIRRORED) {
        const want = w.synced[key];
        const have = onBoard[key];
        // An issue's title is the issue's (an item converted on GitHub): gh-writer leaves it.
        if (key === "title" && item.type !== "DRAFT_ISSUE") continue;
        if (!isNew && base && have !== null && have !== want && have !== base[key]) edited.push(FIELD_NAMES[key]);
        if (key === "title") {
          if (item.title !== want && item.type === "DRAFT_ISSUE" && item.draftId) {
            mutations.push(`updateProjectV2DraftIssue(input: ${literal({ draftIssueId: item.draftId, title: String(want) })}) { draftIssue { id } }`);
            changed = true;
          }
          continue;
        }
        const field = fields[key];
        if (field) changed = set(item, field, want) || changed;
      }
      changed = set(item, fields.scene, w.id) || changed;
      if (edited.length) summary.putBack.push({ scene: w.id, title: w.synced.title, fields: edited });
      if (changed && !isNew) summary.updated++;

      const conflict = conflicts.find((c) => c.scene === w.id);
      // In conflict, the last-synced status stays as it was (or unknown), so both sides still count as changed.
      state.base[w.id] = { ...w.synced, status: conflict ? (base?.status ?? null) : status };
    }

    await this.#mutate(mutations);
    state.conflicts = conflicts;
    state.syncedAt = new Date().toISOString();
    state.last = summary;
    for (const id of Object.keys(state.base)) if (!wanted.has(id)) delete state.base[id];
    await this.#save();
  }

  /** Change a scene file's status, if it's still as read. Whether it was written. */
  async #writeStatus(path: string, status: SceneStatus): Promise<boolean> {
    const file = await this.#deps.read(path);
    if (!file) return false;
    const result = await this.#deps.write(path, editFrontMatter(file.content, [{ path: ["status"], value: status }]), file.hash);
    return result.ok;
  }

  /**
   * Make sure the board has the fields gh-writer keeps, and the options its single-select fields
   * need. Changing a field's options may clear the values that used them (GitHub gives options new
   * IDs): those items' values are forgotten here, so they're set again.
   */
  async #ensureFields(board: Board, wanted: Map<string, Wanted>): Promise<Fields> {
    const byName = (name: string) => board.fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
    const forget = (field: Field) => board.items.forEach((i) => i.values.delete(field.id));
    const statusOptions = STATUSES.map((s) => ({ name: STATUS_NAMES[s], color: new Enum(STATUS_COLOURS[s]), description: STATUS_DESCRIPTIONS[s] }));

    // Status: the project's own field, with the scene statuses as its options; else one of gh-writer's.
    let status = byName(OWN_STATUS) ?? byName("Status");
    if (status?.dataType !== "SINGLE_SELECT") status = undefined;
    const has = (f: Field, names: string[]) => names.every((n) => f.options?.some((o) => o.name.toLowerCase() === n.toLowerCase()));
    if (status && !has(status, STATUSES.map((s) => STATUS_NAMES[s]))) {
      // The author's own options stay, after the statuses; GitHub's stock ones go.
      const keep = (status.options ?? []).filter((o) => !STOCK_STATUS.includes(o.name.toLowerCase()) && !STATUSES.some((s) => STATUS_NAMES[s].toLowerCase() === o.name.toLowerCase()));
      const options = [...statusOptions, ...keep.map((o) => ({ name: o.name, color: new Enum(o.color), description: o.description }))];
      try {
        status = await this.#updateOptions(status, options);
        forget(status);
      } catch (e) {
        if (asBoardError(e).code !== "GITHUB") throw e;
        status = undefined;
      }
    }
    status ??= await this.#createField(board, OWN_STATUS, "SINGLE_SELECT", statusOptions);

    const select = async (name: string, needed: string[]): Promise<Field | undefined> => {
      let field = byName(name);
      if (!needed.length) return field;
      const options = needed.map((n) => ({ name: n, color: new Enum("GRAY"), description: "" }));
      if (!field) return this.#createField(board, name, "SINGLE_SELECT", options);
      if (field.dataType !== "SINGLE_SELECT") return field;
      const current = (field.options ?? []).map((o) => o.name);
      if (current.length === needed.length && needed.every((n, i) => current[i] === n)) return field;
      field = await this.#updateOptions(field, options);
      forget(field);
      return field;
    };
    const scenes = [...wanted.values()].map((w) => w.synced);
    const unique = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => v !== null))];
    const plain = async (name: string, dataType: "NUMBER" | "TEXT") => byName(name) ?? this.#createField(board, name, dataType);
    return {
      status,
      pov: await select(FIELD.pov, unique(scenes.map((s) => s.pov))),
      part: await select(FIELD.part, unique(scenes.map((s) => s.part))),
      chapter: await select(FIELD.chapter, unique(scenes.map((s) => s.chapter))),
      words: await plain(FIELD.words, "NUMBER"),
      order: await plain(FIELD.order, "NUMBER"),
      scene: await plain(FIELD.scene, "TEXT"),
    };
  }

  async #createField(board: Board, name: string, dataType: "SINGLE_SELECT" | "NUMBER" | "TEXT", options?: Literal[]): Promise<Field> {
    const [made] = await this.#mutate([
      `createProjectV2Field(input: ${literal({ projectId: board.id, name, dataType: new Enum(dataType), singleSelectOptions: options })}) { projectV2Field { ... on ProjectV2FieldCommon { id name dataType } ... on ProjectV2SingleSelectField { options { id name color description } } } }`,
    ]);
    const field = fieldOf((made as { projectV2Field: GhField }).projectV2Field);
    board.fields.push(field);
    return field;
  }

  async #updateOptions(field: Field, options: Literal[]): Promise<Field> {
    const [made] = await this.#mutate([
      `updateProjectV2Field(input: ${literal({ fieldId: field.id, singleSelectOptions: options })}) { projectV2Field { ... on ProjectV2FieldCommon { id name dataType } ... on ProjectV2SingleSelectField { options { id name color description } } } }`,
    ]);
    const updated = fieldOf((made as { projectV2Field: GhField }).projectV2Field);
    Object.assign(field, updated);
    return field;
  }

  /** Send mutations in batches, each by an alias. Resolves to their answers, in order. */
  async #mutate(mutations: string[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let i = 0; i < mutations.length; i += BATCH) {
      const batch = mutations.slice(i, i + BATCH);
      const data = await this.#github.graphql<Record<string, unknown>>(`mutation {\n${batch.map((m, j) => `  m${j}: ${m}`).join("\n")}\n}`);
      out.push(...batch.map((_, j) => data[`m${j}`]));
    }
    return out;
  }

  /** The board as it is on GitHub, every item; null when the project is gone. */
  async #read(id: string): Promise<Board | null> {
    let board: Board | null = null;
    let after: string | null = null;
    do {
      const data: { node: GhProject | null } = await this.#github.graphql<{ node: GhProject | null }>(READ, { id, after }).catch((e: unknown) => {
        if (e instanceof GitHubError && e.code === "NOT_FOUND") return { node: null };
        throw e;
      });
      const project = data.node;
      if (!project?.id) return null;
      board ??= { id: project.id, number: project.number, title: project.title, url: project.url, fields: project.fields.nodes.filter((f): f is GhField => !!f?.id).map(fieldOf), items: [] };
      for (const node of project.items.nodes) {
        if (!node) continue;
        const values = new Map<string, string | number>();
        for (const v of node.fieldValues.nodes) {
          const field = v?.field?.id;
          if (!field) continue;
          const value = v.optionId ?? v.number ?? v.text;
          if (value !== undefined && value !== null) values.set(field, value);
        }
        board.items.push({ id: node.id, type: node.type, draftId: node.type === "DRAFT_ISSUE" ? node.content?.id : undefined, title: node.content?.title ?? "", values });
      }
      after = project.items.pageInfo.hasNextPage ? project.items.pageInfo.endCursor : null;
    } while (after);
    return board;
  }

  /** The repository's IDs, and the project already marked as this novel's, if one is linked to it. */
  async #find(repo: GitHubRepo, novel: Novel): Promise<{ repositoryId: string; ownerId: string; project: State["project"] }> {
    const data = await this.#github.graphql<{ repository: { id: string; owner: { id: string }; projectsV2: { nodes: ({ id: string; number: number; title: string; url: string; readme: string | null } | null)[] } } | null }>(FIND, { owner: repo.owner, name: repo.name });
    if (!data.repository) throw new BoardError("NOT_FOUND", `GitHub doesn't have ${repo.owner}/${repo.name} (or doesn't let this sign-in see it).`);
    const id = novel.config?.id;
    const mine = data.repository.projectsV2.nodes.find((p) => p && id && MARKER.exec(p.readme ?? "")?.[1] === id);
    return {
      repositoryId: data.repository.id,
      ownerId: data.repository.owner.id,
      project: mine ? { id: mine.id, number: mine.number, title: mine.title, url: mine.url } : null,
    };
  }

  /** Make the novel's project: owned by the repository's owner, linked to it, marked with the novel's ID. */
  async #create({ repositoryId, ownerId }: { repositoryId: string; ownerId: string }, novel: Novel): Promise<NonNullable<State["project"]>> {
    const title = novel.config?.title || "Novel";
    const [made] = await this.#mutate([`createProjectV2(input: ${literal({ ownerId, repositoryId, title: `${title}: drafting board` })}) { projectV2 { id number title url } }`]);
    const project = (made as { projectV2: { id: string; number: number; title: string; url: string } }).projectV2;
    const readme = [
      `The drafting board of *${title}*, kept by [gh-writer](https://github.com/heffrey78/gh-writer) from the novel's files: one card per scene.`,
      "",
      "Move a card to another status here and the scene's file follows at gh-writer's next sync. POV, part, chapter, words and order come from the files: change them in the novel, not here.",
      "",
      `<!-- gh-writer-board: ${novel.config?.id ?? ""} -->`,
    ].join("\n");
    await this.#mutate([`updateProjectV2(input: ${literal({ projectId: project.id, readme, shortDescription: `Scenes of ${title}, by drafting status` })}) { projectV2 { id } }`]);
    return project;
  }

  #changed(): void {
    for (const l of this.#listeners) l();
  }

  /** The state for the novel's current repository (a novel put on GitHub, or moved, starts afresh). */
  async #load(): Promise<{ state: State; repo: GitHubRepo | null }> {
    const repo = await this.#repo();
    const key = repo ? `${repo.owner}/${repo.name}` : "";
    if (this.#state && this.#state.repo === key) return { state: this.#state, repo };
    this.#file ??= join((await git(this.root).raw(["rev-parse", "--absolute-git-dir"])).trim(), "gh-writer", "board.json");
    const saved = await readFile(this.#file, "utf8")
      .then((t) => JSON.parse(t) as State)
      .catch(() => undefined);
    const fresh: State = { repo: key, project: null, gone: false, base: {}, conflicts: [], syncedAt: null, last: null };
    this.#state = saved && saved.repo === key ? { ...fresh, ...saved } : fresh;
    return { state: this.#state, repo };
  }

  /** Write the state, one write at a time (each with its own temporary file), the last one winning. */
  #save(): Promise<void> {
    this.#saving = this.#saving.catch(() => {}).then(async () => {
      if (!this.#state || !this.#file) return;
      await mkdir(dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(this.#state));
      await rename(tmp, this.#file);
    });
    return this.#saving;
  }
}

interface Fields {
  status: Field;
  pov: Field | undefined;
  part: Field | undefined;
  chapter: Field | undefined;
  words: Field;
  order: Field;
  scene: Field;
}

interface Wanted {
  id: string;
  file: string;
  synced: Synced & { status: SceneStatus };
}

/** What the board should show for each scene of the book, in reading order. */
function desired(novel: Novel): Map<string, Wanted> {
  const names = uniqueNames(novel.entities.filter((e) => e.type === "character").map((e) => [e.id, e.name]));
  const parts = uniqueNames(novel.parts.map((p, i) => [p.id, p.title ? `${i + 1}. ${p.title}` : `Part ${i + 1}`]));
  const chapters = uniqueNames(novel.chapters.map((c, i) => [c.id, c.title ? `${i + 1}. ${c.title}` : `Chapter ${i + 1}`]));
  const out = new Map<string, Wanted>();
  novel.scenes.forEach((s, i) => {
    const chapter = novel.chapters.find((c) => c.id === s.chapterId);
    out.set(s.id, {
      id: s.id,
      file: s.file,
      synced: {
        status: s.status,
        title: s.title || "Untitled scene",
        pov: (s.pov && names.get(s.pov)) ?? null,
        part: (chapter?.partId && parts.get(chapter.partId)) ?? null,
        chapter: (chapter && chapters.get(chapter.id)) ?? null,
        words: countWords(s.body),
        order: i + 1,
      },
    });
  });
  return out;
}

/** Names as single-select options need them: unique, so a second “Ben” is “Ben (2)”. */
function uniqueNames(pairs: [string, string][]): Map<string, string> {
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const [id, raw] of pairs) {
    const name = raw.trim() || id;
    const n = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), n);
    out.set(id, n > 1 ? `${name} (${n})` : name);
  }
  return out;
}

/** An item's values as gh-writer reads them. */
function readItem(item: Item, fields: Fields): { status: SceneStatus | undefined; statusName: string | null } & Record<Mirrored, string | number | null> {
  const option = (field: Field | undefined) => {
    if (!field) return null;
    const v = item.values.get(field.id);
    if (v === undefined) return null;
    return field.dataType === "SINGLE_SELECT" ? (field.options?.find((o) => o.id === v)?.name ?? null) : v;
  };
  const statusName = option(fields.status);
  const status = STATUSES.find((s) => typeof statusName === "string" && STATUS_NAMES[s].toLowerCase() === statusName.toLowerCase());
  const number = (field: Field) => {
    const v = item.values.get(field.id);
    return typeof v === "number" ? v : null;
  };
  return { status, statusName: typeof statusName === "string" ? statusName : null, title: item.title, pov: option(fields.pov), part: option(fields.part), chapter: option(fields.chapter), words: number(fields.words), order: number(fields.order) };
}

function fieldOf(f: GhField): Field {
  return { id: f.id, name: f.name, dataType: f.dataType, ...(f.options ? { options: f.options } : {}) };
}

function asBoardError(e: unknown): BoardError {
  if (e instanceof BoardError) return e;
  if (e instanceof GitHubError) {
    switch (e.code) {
      case "NO_SIGN_IN":
        return new BoardError("NO_SIGN_IN", e.message);
      case "NEEDS_SCOPE":
        return new BoardError("NEEDS_SCOPE", "This GitHub sign-in doesn't allow gh-writer to use Projects. Reconnect GitHub to grant it.");
      case "OFFLINE":
        return new BoardError("OFFLINE", "GitHub can't be reached right now. The board will catch up at the next sync.");
      case "RATE_LIMITED":
        return new BoardError("RATE_LIMITED", e.message, e.resetAt);
      case "NOT_FOUND":
        return new BoardError("NOT_FOUND", e.message);
      default:
        return new BoardError("GITHUB", e.message);
    }
  }
  return new BoardError("GITHUB", e instanceof Error ? e.message : String(e));
}
