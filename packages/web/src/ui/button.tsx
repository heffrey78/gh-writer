import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn.ts";

const VARIANTS = {
  primary: "bg-ink text-paper border-ink hover:opacity-90",
  secondary: "bg-raised text-ink border-rule hover:bg-panel",
  ghost: "bg-transparent text-ink border-transparent hover:bg-panel",
  danger: "bg-danger text-paper border-danger hover:opacity-90",
} as const;

const SIZES = {
  sm: "h-8 px-2.5 text-sm gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
}

export function Button({ variant = "secondary", size = "md", className, type = "button", ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md border font-medium whitespace-nowrap transition-colors",
        "disabled:pointer-events-none disabled:opacity-50 cursor-pointer",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
}
