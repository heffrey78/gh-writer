import { create } from "zustand";

/**
 * A new off-page event asked for (the Story bible, the Timeline, the palette): it opens in its modal
 * over the Story bible, from its title (#236).
 */
export const useNewEvent = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));
