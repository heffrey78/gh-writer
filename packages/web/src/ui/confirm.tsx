import { AlertDialog } from "radix-ui";
import type { ReactNode } from "react";
import { Button } from "./button.tsx";

/** A confirmation dialog around `trigger`; focus returns to it when closed. */
export function Confirm({
  trigger,
  title,
  description,
  action,
  onConfirm,
  danger,
}: {
  trigger: ReactNode;
  title: string;
  description: ReactNode;
  action: string;
  onConfirm: () => void;
  danger?: boolean;
}) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-black/40" />
        <AlertDialog.Content className="fixed z-[60] top-1/2 left-1/2 grid w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-3 rounded-lg border border-rule bg-raised p-5 text-ink shadow-xl">
          <AlertDialog.Title className="text-base font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description className="text-sm text-muted">{description}</AlertDialog.Description>
          <div className="flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button>Cancel</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>
                {action}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
