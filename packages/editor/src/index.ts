export { proseSchema } from "./schema.ts";
export { parseProse, serializeProse } from "./markdown.ts";
export { joinSceneFile, splitSceneFile, type SceneFile } from "./scene-file.ts";
export { insertSectionBreak, proseContent } from "./extensions.ts";
export { getMarkdown, loadMarkdown, setInitialMarkdown } from "./editor.ts";
export {
  chapterContent,
  deleteAcrossScenes,
  loadChapter,
  parseChapter,
  parseScene,
  replaceScene,
  SCENE_STRUCTURE,
  serializeChapter,
  touchedScenes,
  type SceneMarkdown,
  type SceneSource,
} from "./chapter.ts";
export {
  centreCaret,
  TYPEWRITER_LINE,
  writingModeCommands,
  writingModes,
  WritingModesExtension,
  type EditorCommand,
  type WritingMode,
  type WritingModes,
} from "./modes.ts";
export {
  countNode,
  documentCounts,
  liveCounts,
  sessionCommands,
  sessionWords,
  WordCountExtension,
  writingSession,
  type LiveCounts,
  type SessionScene,
  type WordCountOptions,
  type WritingSession,
} from "./wordcount.ts";
export {
  applyReplacements,
  caretBlock,
  caretScene,
  compileQuery,
  editorScenes,
  expandReplacement,
  findInNode,
  replaceAll,
  replaceInEditor,
  replaceInMarkdown,
  searchManuscript,
  SearchHighlightExtension,
  setSearchHighlights,
  type ChapterResult,
  type Manuscript,
  type ManuscriptChapter,
  type ReplaceAllResult,
  type SceneResult,
  type SearchMatch,
  type SearchOptions,
  type SearchQuery,
  type SearchResults,
  type SearchScope,
} from "./search.ts";
export { closeFind, FindExtension, findCommands, findPanel, openFind, type FindPanelState } from "./find.ts";
export {
  closeSpellingMenu,
  createLocalSpellService,
  createWorkerSpellService,
  openSpellingMenu,
  spellCommands,
  SpellCheckExtension,
  type SpellCheckOptions,
  type SpellDictionary,
  type SpellService,
} from "./spell.ts";
export { SpellEngine, type Misspellings } from "./spell-engine.ts";
export { mentionSuggestKey, MentionSuggestExtension, suggestMentions, type MentionEntity, type MentionSuggestion, type MentionSuggestOptions } from "./mention-suggest.ts";
export { MENTION_INFO_KEYS, mentionAtCaret, MentionInfoExtension, type MentionInfoOptions, type MentionTarget } from "./mention-info.ts";
