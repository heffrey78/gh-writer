import type { ReactNode } from "react";
import { cn } from "./cn.ts";

/** A problem, with what to do about it. `detail` is tool output, behind a disclosure. */
export function ErrorAlert({ title, children, detail, className }: { title: string; children?: ReactNode; detail?: string | undefined; className?: string }) {
  return (
    <div role="alert" className={cn("grid gap-1 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm", className)}>
      <p className="font-medium text-danger">{title}</p>
      {children && <div>{children}</div>}
      {detail && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">Details</summary>
          <pre className="mt-1 whitespace-pre-wrap font-mono">{detail}</pre>
        </details>
      )}
    </div>
  );
}
