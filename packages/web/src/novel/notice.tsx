import { X } from "lucide-react";
import { create } from "zustand";
import { Button } from "../ui/button.tsx";

export interface Notice {
  message: string;
  action?: { label: string; run: () => void };
}

/** One notice at a time, at the bottom of the workspace, until dismissed or replaced. */
export const useNotice = create<{ notice: Notice | undefined; show: (n: Notice | undefined) => void }>((set) => ({
  notice: undefined,
  show: (notice) => set({ notice }),
}));

export function NoticeBar() {
  const { notice, show } = useNotice();
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
      {notice && (
        <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-rule bg-raised py-2 pr-2 pl-4 text-sm shadow-lg">
          <p>{notice.message}</p>
          {notice.action && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                const run = notice.action!.run;
                show(undefined);
                run();
              }}
            >
              {notice.action.label}
            </Button>
          )}
          <Button size="sm" variant="ghost" aria-label="Dismiss" onClick={() => show(undefined)}>
            <X className="size-4" aria-hidden />
          </Button>
        </div>
      )}
    </div>
  );
}
