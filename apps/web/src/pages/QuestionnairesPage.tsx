import { useMemo, useState } from "react";
import { useQuestionnairesData } from "../hooks/useCustomers";
import { Card, Input } from "../components/ui";
import type { QuestionnaireBreakdownRow, QuestionnairesQuery } from "@luma/shared";

const PERIOD_OPTIONS: { value: QuestionnairesQuery["period"]; label: string }[] = [
  { value: 7, label: "Last 7 Days" },
  { value: 30, label: "Last 30 Days" },
  { value: 90, label: "Last 90 Days" },
  { value: "all", label: "All Time" },
];

function SummaryTile({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <p className="text-xs font-medium uppercase text-luma-ink-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-luma-ink">{value}</p>
    </Card>
  );
}

type SortableColumn = keyof Pick<
  QuestionnaireBreakdownRow,
  "leads" | "customers" | "conversionRate" | "purchases" | "revenue" | "avgValue" | "lastPurchase"
>;

function SortHeader({
  label,
  column,
  sortBy,
  sortDir,
  onSort,
}: {
  label: string;
  column: SortableColumn;
  sortBy: SortableColumn;
  sortDir: "asc" | "desc";
  onSort: (column: SortableColumn) => void;
}) {
  const active = sortBy === column;
  return (
    <th className="px-4 py-2 text-right">
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`flex items-center gap-1 font-medium uppercase ml-auto ${active ? "text-luma-ink" : "text-luma-ink-secondary hover:text-luma-ink-secondary"}`}
      >
        {label}
        <span className="text-[10px]">{active ? (sortDir === "asc" ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
}

function numericValue(row: QuestionnaireBreakdownRow, column: SortableColumn): number {
  switch (column) {
    case "revenue":
      return Number(row.revenue);
    case "avgValue":
      return row.avgValue === null ? -1 : Number(row.avgValue);
    case "lastPurchase":
      return row.lastPurchase === null ? -1 : new Date(row.lastPurchase).getTime();
    default:
      return row[column];
  }
}

export function QuestionnairesPage() {
  const [period, setPeriod] = useState<QuestionnairesQuery["period"]>(30);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortableColumn>("leads");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const { data, isLoading } = useQuestionnairesData({ period });
  const periodLabel = PERIOD_OPTIONS.find((p) => p.value === period)?.label ?? "";

  function handleSort(column: SortableColumn) {
    if (column === sortBy) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(column);
      setSortDir("desc");
    }
  }

  const rows = useMemo(() => {
    const filtered = search.trim()
      ? (data?.rows ?? []).filter((r) => r.questionnaireId.toLowerCase().includes(search.trim().toLowerCase()))
      : (data?.rows ?? []);
    const sorted = [...filtered].sort((a, b) => {
      const diff = numericValue(a, sortBy) - numericValue(b, sortBy);
      return sortDir === "asc" ? diff : -diff;
    });
    return sorted;
  }, [data, search, sortBy, sortDir]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-serif text-2xl font-medium text-luma-ink">Questionnaires</h1>
        <p className="text-sm text-luma-ink-secondary">Performance by questionnaire source.</p>
      </div>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm text-luma-ink-secondary">
            Summary for <span className="font-medium text-luma-ink">{periodLabel}</span>
          </p>
          <select
            className="rounded-md border border-luma-border px-2 py-1 text-sm"
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
          <SummaryTile label="Leads w/ questionnaire" value={data?.summary.leadsWithQuestionnaire ?? "…"} />
          <SummaryTile label="First-time customers" value={data?.summary.firstTimeCustomers ?? "…"} />
          <SummaryTile label="Completed purchases" value={data?.summary.completedPurchases ?? "…"} />
          <SummaryTile label="Total revenue" value={data ? `$${data.summary.totalRevenue}` : "…"} />
          <SummaryTile label="Conversion rate" value={data ? `${data.summary.conversionRate}%` : "…"} />
        </div>
      </Card>

      <div className="flex items-center justify-between">
        <Input className="max-w-xs" placeholder="Search by questionnaire number…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <p className="text-xs text-luma-ink-muted">{rows.length} questionnaires</p>
      </div>

      <Card className="overflow-x-auto p-0">
        {isLoading ? (
          <p className="p-4 text-sm text-luma-ink-secondary">Loading…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-luma-border bg-luma-bg text-left text-xs font-medium uppercase text-luma-ink-secondary">
              <tr>
                <th className="px-4 py-2">Questionnaire</th>
                <SortHeader label="Leads" column="leads" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortHeader label="Customers" column="customers" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortHeader label="Conv. Rate" column="conversionRate" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortHeader label="Purchases" column="purchases" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortHeader label="Revenue" column="revenue" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortHeader label="Avg Value" column="avgValue" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortHeader label="Last Purchase" column="lastPurchase" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.questionnaireId} className="border-b border-luma-border last:border-0 hover:bg-luma-bg">
                  <td className="px-4 py-2 font-medium text-luma-ink">{r.questionnaireId}</td>
                  <td className="px-4 py-2 text-right text-luma-ink-secondary">{r.leads}</td>
                  <td className="px-4 py-2 text-right text-luma-ink-secondary">{r.customers}</td>
                  <td className="px-4 py-2 text-right text-luma-ink-secondary">{r.conversionRate}%</td>
                  <td className="px-4 py-2 text-right text-luma-ink-secondary">{r.purchases}</td>
                  <td className="px-4 py-2 text-right text-luma-ink-secondary">${r.revenue}</td>
                  <td className="px-4 py-2 text-right text-luma-ink-secondary">{r.avgValue === null ? "—" : `$${r.avgValue}`}</td>
                  <td className="px-4 py-2 text-right text-luma-ink-secondary">{r.lastPurchase ?? "—"}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-sm text-luma-ink-muted">
                    No questionnaire activity found.
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
