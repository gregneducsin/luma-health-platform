import { useState, type FormEvent } from "react";
import { useParams } from "wouter";
import { useCustomer, useCreatePurchase, useUpdatePurchase } from "../hooks/useCustomers";
import { Badge, Button, Card, ErrorText, Field, Input } from "../components/ui";
import { ApiError } from "../hooks/useAuth";

const STATUS_COLORS: Record<string, "gray" | "green" | "yellow" | "red"> = {
  pending: "yellow",
  completed: "green",
  refunded: "gray",
  cancelled: "red",
};

export function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useCustomer(id);
  const [showAddPurchase, setShowAddPurchase] = useState(false);

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>;
  if (!data) return <p className="text-sm text-gray-500">Customer not found.</p>;

  const { customer, purchases } = data;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">
          {customer.firstName} {customer.lastName}
        </h1>
        <p className="text-sm text-gray-500">{customer.personNumber}</p>
      </div>

      <Card>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-gray-400">Email</dt>
            <dd className="text-gray-800">{customer.email}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">Phone</dt>
            <dd className="text-gray-800">{customer.phone ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">Lead type</dt>
            <dd className="text-gray-800">{customer.leadType}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">Lead received</dt>
            <dd className="text-gray-800">{customer.leadReceivedDate}</dd>
          </div>
        </dl>
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Purchase history</h2>
        <Button onClick={() => setShowAddPurchase((s) => !s)}>{showAddPurchase ? "Cancel" : "Add purchase"}</Button>
      </div>

      {showAddPurchase && <AddPurchaseForm customerId={customer.id} onDone={() => setShowAddPurchase(false)} />}

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
            <tr>
              <th className="px-4 py-2">Date</th>
              <th className="px-4 py-2">Order #</th>
              <th className="px-4 py-2">Product</th>
              <th className="px-4 py-2 text-right">Amount</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Classification</th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((p) => (
              <PurchaseRow key={p.id} purchase={p} customerId={customer.id} />
            ))}
            {purchases.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-gray-400">
                  No purchases yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function PurchaseRow({
  purchase,
  customerId,
}: {
  purchase: { id: number; purchaseDate: string; orderNumber: string; productName: string; amountPaid: string; status: string; orderClassification: string | null };
  customerId: string;
}) {
  const updatePurchase = useUpdatePurchase(customerId);

  return (
    <tr className="border-b border-gray-100 last:border-0">
      <td className="px-4 py-2 text-gray-600">{purchase.purchaseDate}</td>
      <td className="px-4 py-2 text-gray-600">{purchase.orderNumber}</td>
      <td className="px-4 py-2 text-gray-600">{purchase.productName}</td>
      <td className="px-4 py-2 text-right text-gray-600">${purchase.amountPaid}</td>
      <td className="px-4 py-2">
        <Badge color={STATUS_COLORS[purchase.status] ?? "gray"}>{purchase.status}</Badge>
      </td>
      <td className="px-4 py-2">
        <select
          className="rounded-md border border-gray-300 px-2 py-1 text-xs"
          value={purchase.orderClassification ?? ""}
          onChange={(e) =>
            updatePurchase.mutate({
              id: purchase.id,
              input: { orderClassification: e.target.value as "first_order" | "recurring" | "unknown" },
            })
          }
        >
          <option value="first_order">First order</option>
          <option value="recurring">Recurring</option>
          <option value="unknown">Unknown</option>
        </select>
      </td>
    </tr>
  );
}

function AddPurchaseForm({ customerId, onDone }: { customerId: string; onDone: () => void }) {
  const [form, setForm] = useState({ purchaseDate: "", orderNumber: "", productName: "", amountPaid: "" });
  const createPurchase = useCreatePurchase(customerId);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    createPurchase.mutate(form, { onSuccess: onDone });
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Date">
          <Input type="date" required value={form.purchaseDate} onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })} />
        </Field>
        <Field label="Order #">
          <Input required value={form.orderNumber} onChange={(e) => setForm({ ...form, orderNumber: e.target.value })} />
        </Field>
        <Field label="Product">
          <Input required value={form.productName} onChange={(e) => setForm({ ...form, productName: e.target.value })} />
        </Field>
        <Field label="Amount">
          <Input
            required
            placeholder="49.99"
            value={form.amountPaid}
            onChange={(e) => setForm({ ...form, amountPaid: e.target.value })}
          />
        </Field>
        <div className="col-span-2 flex items-center gap-2 sm:col-span-4">
          <Button type="submit" disabled={createPurchase.isPending}>
            {createPurchase.isPending ? "Adding…" : "Add purchase"}
          </Button>
          <ErrorText>
            {createPurchase.isError
              ? createPurchase.error instanceof ApiError
                ? createPurchase.error.message
                : "Something went wrong."
              : null}
          </ErrorText>
        </div>
      </form>
    </Card>
  );
}
