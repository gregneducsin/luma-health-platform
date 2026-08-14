import { type ReactNode, useEffect } from "react";
import { useLocation } from "wouter";
import { useCurrentUser } from "../hooks/useAuth";
import { Layout } from "./Layout";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { data, isLoading } = useCurrentUser();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!isLoading && !data?.user) {
      navigate("/login");
    }
  }, [isLoading, data?.user, navigate]);

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-gray-500">Loading…</div>;
  }
  if (!data?.user) {
    return null;
  }
  return <Layout>{children}</Layout>;
}
