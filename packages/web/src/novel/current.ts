import { create } from "zustand";

/** The scene the author is in: the open scene, or in a chapter the one holding the caret. */
export interface CurrentScene {
  id: string;
  title: string;
  path: string;
}

export const useCurrentScene = create<{ scene: CurrentScene | undefined; set: (scene: CurrentScene | undefined) => void }>((set) => ({
  scene: undefined,
  set: (scene) => set({ scene }),
}));
