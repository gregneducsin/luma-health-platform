import { type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useCurrentUser, useLogout } from "../hooks/useAuth";
import { Button } from "./ui";
import { AiAssistantWidget } from "./AiAssistantWidget";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard" },
  { href: "/customers", label: "Leads" },
  { href: "/orders", label: "Orders" },
  { href: "/questionnaires", label: "Questionnaires" },
  { href: "/conversations", label: "Conversations" },
  { href: "/support", label: "Support" },
  { href: "/marketing-cpa", label: "Marketing CPA" },
  { href: "/payroll/employees", label: "Employees" },
  { href: "/payroll/weeks", label: "Payroll" },
];

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { data } = useCurrentUser();
  const logout = useLogout();

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-[1800px] items-center justify-between px-4 py-3">
          <nav className="flex items-center gap-4">
            <span className="mr-2 text-sm font-semibold text-gray-900">Luma Health</span>
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={
                  location === item.href
                    ? "text-sm font-medium text-blue-600"
                    : "text-sm font-medium text-gray-600 hover:text-gray-900"
                }
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            {data?.user && <span className="text-sm text-gray-500">{data.user.email}</span>}
            <Button variant="secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
              Log out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1800px] px-4 py-6">{children}</main>
      {data?.user && (data.user.role === "admin" || data.user.role === "manager") && <AiAssistantWidget />}
    </div>
  );
}
