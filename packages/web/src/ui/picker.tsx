import { Command as Cmdk } from "cmdk";
import { Check, ChevronsUpDown } from "lucide-react";
import { Popover } from "radix-ui";
import { useId, useState } from "react";
import { rank } from "../palette.tsx";
import { cn } from "./cn.ts";

export interface PickerItem {
  value: string;
  label: string;
  /** Items are listed under their group's heading, in the order given. */
  group?: string;
  /** Other words that find it (aliases, a chapter's title). */
  keywords?: string[];
}

export interface PickerProps {
  /** The field's name, shown above it and read by screen readers. */
  label: string;
  items: PickerItem[];
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  /** Shown when nothing is chosen; with `allowNone`, also the choice that clears it. */
  placeholder?: string;
  allowNone?: boolean;
  className?: string;
}

/** Choose one item from a long list by typing: a button that opens a searchable, grouped list. */
export function Picker({ label, items, value, onChange, placeholder = "Choose…", allowNone, className }: PickerProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const chosen = items.find((i) => i.value === value);
  const groups = [...new Set(items.map((i) => i.group ?? ""))];
  const pick = (v: string | undefined) => {
    onChange(v);
    setOpen(false);
  };
  return (
    <div className={cn("grid gap-1.5", className)}>
      <span id={`${id}-label`} className="text-sm font-medium">
        {label}
      </span>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-labelledby={`${id}-label ${id}-value`}
            className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-rule bg-raised px-3 text-left text-sm"
          >
            <span id={`${id}-value`} className={cn("truncate", !chosen && "text-muted")}>
              {chosen?.label ?? placeholder}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted" aria-hidden />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={4} className="z-[80] w-[var(--radix-popover-trigger-width)] min-w-64 rounded-md border border-rule bg-raised text-ink shadow-lg">
            <Cmdk label={label} filter={rank} loop>
              <Cmdk.Input placeholder="Type to search…" aria-label={`Search ${label.toLowerCase()}`} className="h-9 w-full border-b border-rule bg-transparent px-3 text-sm outline-none" />
              <Cmdk.List className="max-h-72 overflow-y-auto p-1">
                <Cmdk.Empty className="px-3 py-4 text-center text-sm text-muted">Nothing matches</Cmdk.Empty>
                {allowNone && (
                  <Cmdk.Item value="(none)" keywords={[placeholder]} onSelect={() => pick(undefined)} className="cursor-pointer rounded px-2 py-1.5 text-sm text-muted data-[selected=true]:bg-accent-soft">
                    {placeholder}
                  </Cmdk.Item>
                )}
                {groups.map((group) => (
                  <Cmdk.Group key={group} heading={group || undefined} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted">
                    {items
                      .filter((i) => (i.group ?? "") === group)
                      .map((i) => (
                        <Cmdk.Item
                          key={i.value}
                          value={`${i.label} ${i.value}`}
                          keywords={[i.label, ...(i.keywords ?? [])]}
                          onSelect={() => pick(i.value)}
                          className="flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-sm data-[selected=true]:bg-accent-soft"
                        >
                          {i.label}
                          {i.value === value && <Check className="size-4 text-accent" aria-label="chosen" />}
                        </Cmdk.Item>
                      ))}
                  </Cmdk.Group>
                ))}
              </Cmdk.List>
            </Cmdk>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
