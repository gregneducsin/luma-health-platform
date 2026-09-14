import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";

export function Button({ className, variant = "primary", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" }) {
  return (
    <button
      className={clsx(
        "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-luma-action text-luma-bg hover:bg-luma-action-hover",
        variant === "secondary" && "border border-luma-border bg-luma-surface text-luma-ink hover:bg-luma-surface-alt",
        variant === "danger" && "bg-luma-error text-luma-bg hover:opacity-90",
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={clsx(
        "w-full rounded-lg border border-luma-border bg-luma-surface px-3 py-1.5 text-sm text-luma-ink placeholder:text-luma-ink-muted transition-colors duration-150 focus:border-luma-accent focus:outline-none focus:ring-1 focus:ring-luma-accent",
        className,
      )}
      {...props}
    />
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("rounded-xl border border-luma-border bg-luma-surface p-4", className)}>{children}</div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-luma-ink-secondary">{label}</span>
      {children}
    </label>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="mt-1 text-sm text-luma-error">{children}</p>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-luma-ink/40 px-4">
      <div className="w-full max-w-md rounded-xl border border-luma-border bg-luma-surface p-5 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-luma-ink">{title}</h2>
          <button type="button" onClick={onClose} className="text-luma-ink-muted hover:text-luma-ink" aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A right-hand slide-in panel for contextual work that should keep the underlying list/page in view — e.g. editing a record without leaving its table. */
export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-luma-ink/40">
      <div className="h-full w-full max-w-md overflow-y-auto border-l border-luma-border bg-luma-surface p-5 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-luma-ink">{title}</h2>
          <button type="button" onClick={onClose} className="text-luma-ink-muted hover:text-luma-ink" aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Badge({ children, color = "gray" }: { children: ReactNode; color?: "gray" | "green" | "yellow" | "red" | "blue" | "purple" }) {
  const colors: Record<string, string> = {
    gray: "bg-luma-surface-alt text-luma-ink-secondary",
    green: "bg-luma-success-soft text-luma-success",
    yellow: "bg-luma-warning-soft text-luma-warning",
    red: "bg-luma-error-soft text-luma-error",
    blue: "bg-luma-info-soft text-luma-info",
    purple: "bg-luma-accent-soft text-luma-accent",
  };
  return <span className={clsx("rounded-md px-2 py-0.5 text-xs font-medium", colors[color])}>{children}</span>;
}

/** Page-level heading: the editorial serif moment at the top of every screen, with an optional right-aligned action slot (filters, a primary button). */
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="font-serif text-2xl font-medium text-luma-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-luma-ink-secondary">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function SectionHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="text-sm font-semibold text-luma-ink">{title}</h2>
      {actions}
    </div>
  );
}

/** A dashboard/summary metric — the large number uses the editorial serif, matching the brief's "select dashboard numbers may use serif" guidance. */
export function MetricCard({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <Card>
      <p className="text-xs font-medium uppercase tracking-wide text-luma-ink-muted">{label}</p>
      <p className="mt-1 font-serif text-2xl font-medium text-luma-ink">{value}</p>
      {hint && <p className="mt-1 text-xs text-luma-ink-muted">{hint}</p>}
    </Card>
  );
}

/** An intentional, quiet empty state — no illustration, just a headline and one line of context. */
export function EmptyState({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-luma-border py-12 text-center">
      <p className="font-serif text-lg font-medium text-luma-ink">{title}</p>
      {description && <p className="text-sm text-luma-ink-secondary">{description}</p>}
    </div>
  );
}

/** A pulsing placeholder block sized to match the real layout it stands in for, e.g. <Skeleton className="h-4 w-32" /> in place of a table cell. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("animate-pulse rounded-md bg-luma-surface-alt", className)} />;
}
