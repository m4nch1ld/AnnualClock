import * as React from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-border bg-surface", className)} {...props} />;
}

export function Badge({
  className,
  tone = "neutral",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: "neutral" | "danger" | "success" | "warning" | "primary" }) {
  const tones = {
    neutral: "bg-canvas text-muted border-border",
    danger: "bg-danger-soft text-danger border-danger/30",
    success: "bg-success-soft text-success border-success/30",
    warning: "bg-warning-soft text-warning border-warning/30",
    primary: "bg-teal-5/40 text-primary border-primary/30",
  };
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", tones[tone], className)}
      {...props}
    />
  );
}
