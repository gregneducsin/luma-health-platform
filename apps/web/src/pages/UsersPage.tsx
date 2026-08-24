import { useState, type FormEvent } from "react";
import type { AuthUser } from "@luma/shared";
import { useUsers, useInviteUser } from "../hooks/useUsers";
import { Badge, Button, Card, ErrorText, Field, Input } from "../components/ui";
import { ApiError } from "../hooks/useAuth";

const ROLE_LABEL: Record<AuthUser["role"], string> = {
  admin: "Admin",
  manager: "Manager",
  customer_service: "Customer Service",
};

const STATUS_COLOR: Record<AuthUser["status"], "green" | "yellow" | "red" | "gray"> = {
  active: "green",
  invited: "yellow",
  locked: "red",
  disabled: "gray",
};

export function UsersPage() {
  const [showInvite, setShowInvite] = useState(false);
  const { data, isLoading } = useUsers();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Users</h1>
        <Button onClick={() => setShowInvite((s) => !s)}>{showInvite ? "Cancel" : "Invite user"}</Button>
      </div>

      {showInvite && <InviteUserForm onDone={() => setShowInvite(false)} />}

      <Card className="overflow-x-auto p-0">
        {isLoading ? (
          <p className="p-4 text-sm text-gray-500">Loading…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {data?.users.map((u) => (
                <tr key={u.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-2 text-gray-800">
                    {u.firstName} {u.lastName}
                  </td>
                  <td className="px-4 py-2 text-gray-600">{u.email}</td>
                  <td className="px-4 py-2 text-gray-600">{ROLE_LABEL[u.role]}</td>
                  <td className="px-4 py-2">
                    <Badge color={STATUS_COLOR[u.status]}>{u.status}</Badge>
                  </td>
                </tr>
              ))}
              {data?.users.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-sm text-gray-400">
                    No users yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function InviteUserForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState<{ firstName: string; lastName: string; email: string; role: AuthUser["role"] }>({
    firstName: "",
    lastName: "",
    email: "",
    role: "customer_service",
  });
  const inviteUser = useInviteUser();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    inviteUser.mutate(form, { onSuccess: onDone });
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="First name">
          <Input required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
        </Field>
        <Field label="Last name">
          <Input required value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
        </Field>
        <Field label="Email">
          <Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Role">
          <select
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as AuthUser["role"] })}
          >
            <option value="customer_service">Customer Service</option>
            <option value="manager">Manager</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
        <div className="col-span-2 flex items-center gap-2 sm:col-span-4">
          <Button type="submit" disabled={inviteUser.isPending}>
            {inviteUser.isPending ? "Sending invite…" : "Send invite"}
          </Button>
          <ErrorText>
            {inviteUser.isError ? (inviteUser.error instanceof ApiError ? inviteUser.error.message : "Something went wrong.") : null}
          </ErrorText>
        </div>
      </form>
    </Card>
  );
}
