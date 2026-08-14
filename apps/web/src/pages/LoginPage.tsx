import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { useCurrentUser, useLogin, ApiError } from "../hooks/useAuth";
import { Button, Card, ErrorText, Field, Input } from "../components/ui";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { data } = useCurrentUser();
  const login = useLogin();
  const [, navigate] = useLocation();

  if (data?.user) {
    navigate("/");
    return null;
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    login.mutate(
      { email, password },
      {
        onSuccess: () => navigate("/"),
      },
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <Card className="w-full max-w-sm">
        <h1 className="mb-4 text-lg font-semibold text-gray-900">Luma Health</h1>
        <form onSubmit={handleSubmit} className="space-y-3">
          <Field label="Email">
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          <ErrorText>{login.isError ? (login.error instanceof ApiError ? login.error.message : "Something went wrong.") : null}</ErrorText>
          <Button type="submit" className="w-full" disabled={login.isPending}>
            {login.isPending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
