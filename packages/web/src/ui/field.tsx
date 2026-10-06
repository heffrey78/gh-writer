import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn.ts";

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: ReactNode;
}

/** A labelled text input, with an optional hint read with it. */
export function Field({ label, hint, className, id, ...props }: FieldProps) {
  const own = useId();
  const inputId = id ?? own;
  const hintId = `${inputId}-hint`;
  return (
    <div className={cn("grid gap-1.5", className)}>
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={inputId}
        aria-describedby={hint ? hintId : undefined}
        className="h-9 w-full min-w-0 rounded-md border border-rule bg-raised px-3 text-sm text-ink placeholder:text-muted"
        {...props}
      />
      {hint && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}
