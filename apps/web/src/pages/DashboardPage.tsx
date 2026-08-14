import { useCustomersList } from "../hooks/useCustomers";
import { useEmployees, usePayrollWeeks } from "../hooks/usePayroll";
import { Card } from "../components/ui";

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <p className="text-xs font-medium uppercase text-gray-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
    </Card>
  );
}

export function DashboardPage() {
  // limit: 100 is a pragmatic ceiling for a client-computed summary in this
  // phase — a real aggregate endpoint (computed in SQL, not paginated
  // client data) would be the right fix if the customer count grows well
  // beyond that.
  const { data: customersData } = useCustomersList({ limit: 100 });
  const { data: employeesData } = useEmployees();
  const { data: weeksData } = usePayrollWeeks();

  const totalRevenue = customersData?.customers.reduce((sum, c) => sum + Number(c.totalPaid), 0) ?? 0;
  const activeEmployees = employeesData?.employees.filter((e) => e.status === "active").length ?? 0;
  const draftWeeks = weeksData?.weeks.filter((w) => w.status === "draft").length ?? 0;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Customers" value={customersData?.total ?? "…"} />
        <StatCard label="Revenue" value={`$${totalRevenue.toFixed(2)}`} />
        <StatCard label="Active employees" value={activeEmployees} />
        <StatCard label="Draft payroll weeks" value={draftWeeks} />
      </div>
    </div>
  );
}
