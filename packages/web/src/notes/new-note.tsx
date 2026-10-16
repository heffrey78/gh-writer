import { create } from "zustand";

/** A new note asked for (the palette, the Notes gallery): it opens in its modal, from its title (#235). */
export const useNewNote = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));
