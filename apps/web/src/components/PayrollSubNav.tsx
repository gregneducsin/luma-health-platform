import { Link, useLocation } from "wouter";

const TABS = [
  { href: "/payroll/employees", label: "Employees" },
  { href: "/payroll/weeks", label: "Payroll Weeks" },
] as const;

/** Employees and Payroll Weeks share one top-nav tab — this sub-nav is how staff switch between the two once inside it. */
export function PayrollSubNav() {
  const [location] = useLocation();
  return (
    <div className="flex gap-1">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={"rounded-lg px-3 py-1.5 text-sm font-medium transition-colors duration-150 " + (location.startsWith(t.href) ? "bg-luma-action text-luma-bg" : "bg-luma-surface-alt text-luma-ink-secondary hover:bg-luma-border")}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
