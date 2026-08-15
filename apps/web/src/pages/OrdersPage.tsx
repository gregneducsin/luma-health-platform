import { Link } from "wouter";
import { usePurchasesList } from "../hooks/useCustomers";
import { Badge, Card } from "../components/ui";

const STATUS_COLOR: Record<string, "gray" | "green" | "yellow" | "red" | "blue"> = {
  completed: "green",
  pending: "yellow",
  refunded: "gray",
  cancelled: "red",
};

export function OrdersPage() {
  const { data, isLoading } = usePurchasesList({ limit: 50 });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-gray-900">Orders</h1>

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
