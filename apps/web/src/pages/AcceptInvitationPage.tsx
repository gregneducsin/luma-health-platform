import { useState, type FormEvent } from "react";
import { Link, useSearch } from "wouter";
import { useAcceptInvitation, ApiError } from "../hooks/useAuth";
import { Button, Card, ErrorText, Field, Input } from "../components/ui";

export function AcceptInvitationPage() {
  const search = useSearch();
  const token = new URLSearchParams(search).get("token") ?? "";
  const [password, setPassword] = useState("");
  const acceptInvitation = useAcceptInvitation();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    // Deliberately no auto-navigate here — an immediate redirect would
    // unmount this success message before anyone could ever read it.
    // The user confirms when they're ready via the link below.
    acceptInvitation.mutate({ token, password });
  }

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-luma-bg px-4">
        <Card className="w-full max-w-sm">
          <p className="text-sm text-luma-ink-secondary">This invitation link is missing its token.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-luma-bg px-4">
      <Card className="w-full max-w-sm">
        <h1 className="mb-1 text-lg font-semibold text-luma-ink">Set your password</h1>
        <p className="mb-4 text-sm text-luma-ink-secondary">Choose a password to activate your account.</p>
        {acceptInvitation.isSuccess ? (
          <div className="space-y-3">
            <p className="text-sm text-luma-success">Password set. You can now log in.</p>
            <Link href="/login" className="inline-block text-sm font-medium text-luma-accent hover:underline">
              Go to login →
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <Field label="New password (12+ characters)">
              <Input
                type="password"
                required
                minLength={12}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <ErrorText>
              {acceptInvitation.isError
                ? acceptInvitation.error instanceof ApiError
                  ? acceptInvitation.error.message
                  : "Something went wrong."
                : null}
            </ErrorText>
            <Button type="submit" className="w-full" disabled={acceptInvitation.isPending}>
              {acceptInvitation.isPending ? "Setting password…" : "Set password"}
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
