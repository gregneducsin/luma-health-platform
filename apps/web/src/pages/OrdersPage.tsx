import { useState } from "react";
import { Link } from "wouter";
import { usePurchasesList, usePurchasesSummary } from "../hooks/useCustomers";
import { Badge, Card } from "../components/ui";
import type { PurchasesSummaryQuery } from "@luma/shared";

const STATUS_COLOR: Record<string, "gray" | "green" | "yellow" | "red" | "blue"> = {
  completed: "green",
  pending: "yellow",
  refunded: "gray",
  cancelled: "red",
};

const PERIOD_OPTIONS: { value: PurchasesSummaryQuery["period"]; label: string }[] = [
  { value: 7, label: "Last 7 Days" },
  { value: 30, label: "Last 30 Days" },
  { value: 90, label: "Last 90 Days" },
  { value: "all", label: "Lifetime" },
];

function SummaryTile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card>
      <p className="text-xs font-medium uppercase text-gray-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </Card>
  );
}

function SummaryBar() {
  const [period, setPeriod] = useState<PurchasesSummaryQuery["period"]>("all");
  const { data } = usePurchasesSummary({ period });
  const periodLabel = PERIOD_OPTIONS.find((p) => p.value === period)?.label ?? "";

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Summary for <span className="font-medium text-gray-900">{periodLabel}</span>
        </p>
        <select
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
          value={String(period)}
          onChange={(e) => setPeriod(e.target.value === "all" ? "all" : Number(e.target.value))}
        >
          {PERIOD_OPTIONS.map((p) => (
            <option key={p.label} value={String(p.value)}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <SummaryTile
          label="Purchasing customers"
          value={data?.purchasingCustomers ?? "…"}
          hint="unique customers with a completed purchase"
        />
        <SummaryTile
          label="Total revenue"
          value={data ? `$${data.totalRevenue}` : "…"}
          hint={data ? `across ${data.totalCompletedOrders} purchases` : undefined}
        />
        <SummaryTile label="Completed orders" value={data?.totalCompletedOrders ?? "…"} />
        <SummaryTile label="New customers" value={data?.newCustomers ?? "…"} hint="first order in this period" />
        <SummaryTile label="Recurring customers" value={data?.recurringCustomers ?? "…"} hint="repeat order in this period" />
      </div>
    </Card>
  );
}

export function OrdersPage() {
  const [orderClassification, setOrderClassification] = useState("");
  const { data, isLoading } = usePurchasesList({
    limit: 50,
    orderClassification: (orderClassification || undefined) as "first_order" | "recurring" | undefined,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-gray-900">Orders</h1>

      <SummaryBar />

      <select
        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
        value={orderClassification}
        onChange={(e) => setOrderClassification(e.target.value)}
      >
        <option value="">All Orders</option>
        <option value="first_order">New (first order)</option>
        <option value="recurring">Recurring</option>
      </select>

      <Card className="overflow-x-auto p-0">
        {isLoading ? (
          <p className="p-4 text-sm text-gray-500">Loading…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">Order #</th>
                <th className="px-4 py-2">Customer</th>
                <th className="px-4 py-2">Product</th>
                <th className="px-4 py-2 text-right">Amount</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Classification</th>
              </tr>
            </thead>
            <tbody>
              {data?.purchases.map((p) => (
                <tr key={p.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-2 text-gray-600">{p.purchaseDate}</td>
                  <td className="px-4 py-2 text-gray-800">{p.orderNumber}</td>
                  <td className="px-4 py-2">
                    <Link href={`/customers/${p.customerId}`} className="font-medium text-blue-600 hover:underline">
                      {p.customerFirstName} {p.customerLastName}
                    </Link>
                    <div className="text-xs text-gray-400">{p.customerPersonNumber}</div>
                  </td>
                  <td className="px-4 py-2 text-gray-600">{p.productName}</td>
                  <td className="px-4 py-2 text-right text-gray-800">${p.amountPaid}</td>
                  <td className="px-4 py-2">
                    <Badge color={STATUS_COLOR[p.status] ?? "gray"}>{p.status}</Badge>
                  </td>
                  <td className="px-4 py-2 text-gray-600">{p.orderClassification ?? "—"}</td>
                </tr>
              ))}
              {data?.purchases.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-sm text-gray-400">
                    No orders found.
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
