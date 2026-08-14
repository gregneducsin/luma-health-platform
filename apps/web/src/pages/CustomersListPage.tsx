import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { useCustomersList, useCreateCustomer } from "../hooks/useCustomers";
import { Button, Card, ErrorText, Field, Input } from "../components/ui";
import { ApiError } from "../hooks/useAuth";

export function CustomersListPage() {
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const { data, isLoading } = useCustomersList({ search: search || undefined });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Customers</h1>
        <Button onClick={() => setShowCreate((s) => !s)}>{showCreate ? "Cancel" : "New customer"}</Button>
      </div>

      {showCreate && <CreateCustomerForm onDone={() => setShowCreate(false)} />}

      <Input placeholder="Search by name, email, or phone…" value={search} onChange={(e) => setSearch(e.target.value)} />

      <Card className="overflow-x-auto p-0">
        {isLoading ? (
          <p className="p-4 text-sm text-gray-500">Loading…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Lead type</th>
                <th className="px-4 py-2 text-right">Purchases</th>
                <th className="px-4 py-2 text-right">Total paid</th>
              </tr>
            </thead>
            <tbody>
              {data?.customers.map((c) => (
                <tr key={c.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <Link href={`/customers/${c.id}`} className="font-medium text-blue-600 hover:underline">
                      {c.firstName} {c.lastName}
                    </Link>
                    <div className="text-xs text-gray-400">{c.personNumber}</div>
                  </td>
                  <td className="px-4 py-2 text-gray-600">{c.email}</td>
                  <td className="px-4 py-2 text-gray-600">{c.leadType}</td>
                  <td className="px-4 py-2 text-right text-gray-600">{c.purchaseCount}</td>
                  <td className="px-4 py-2 text-right text-gray-600">${c.totalPaid}</td>
                </tr>
              ))}
              {data?.customers.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm text-gray-400">
                    No customers found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </Card>
      {data && <p className="text-xs text-gray-400">{data.total} total</p>}
    </div>
  );
}

function CreateCustomerForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", phone: "", leadReceivedDate: "" });
  const createCustomer = useCreateCustomer();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    createCustomer.mutate(
      { ...form, phone: form.phone || undefined },
      { onSuccess: onDone },
    );
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-3">
        <Field label="First name">
          <Input required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
        </Field>
        <Field label="Last name">
          <Input required value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
        </Field>
        <Field label="Email">
          <Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Phone (optional)">
          <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Lead received date">
          <Input
            type="date"
            required
            value={form.leadReceivedDate}
            onChange={(e) => setForm({ ...form, leadReceivedDate: e.target.value })}
          />
        </Field>
        <div className="col-span-2 flex items-center gap-2">
          <Button type="submit" disabled={createCustomer.isPending}>
            {createCustomer.isPending ? "Creating…" : "Create customer"}
          </Button>
          <ErrorText>
            {createCustomer.isError
              ? createCustomer.error instanceof ApiError
                ? createCustomer.error.message
                : "Something went wrong."
              : null}
          </ErrorText>
        </div>
      </form>
    </Card>
  );
}
