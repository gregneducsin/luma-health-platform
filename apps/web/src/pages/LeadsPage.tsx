import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { useCustomersList, useCreateCustomer, useCustomersSummary, useLeadTypes, useQuestionnaireIds } from "../hooks/useCustomers";
import { Badge, Button, Card, ErrorText, Field, Input } from "../components/ui";
import { ApiError } from "../hooks/useAuth";
import type { CustomersSummaryQuery } from "@luma/shared";

const PERIOD_OPTIONS: { value: CustomersSummaryQuery["period"]; label: string }[] = [
  { value: 7, label: "Last 7 Days" },
  { value: 30, label: "Last 30 Days" },
  { value: 90, label: "Last 90 Days" },
  { value: "all", label: "All Time" },
];

function SummaryTile({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <p className="text-xs font-medium uppercase text-gray-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
    </Card>
  );
}

function SummaryBar() {
  const [period, setPeriod] = useState<CustomersSummaryQuery["period"]>(30);
  const { data } = useCustomersSummary({ period });
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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <SummaryTile label="Total leads" value={data?.totalLeads ?? "…"} />
        <SummaryTile label="Meta form fill" value={data?.metaFormFillCount ?? "…"} />
        <SummaryTile label="Questionnaire" value={data?.questionnaireCount ?? "…"} />
        <SummaryTile label="Purchased" value={data?.purchased ?? "…"} />
        <SummaryTile label="Not purchased" value={data?.notPurchased ?? "…"} />
        <SummaryTile label="Conversion rate" value={data ? `${data.conversionRate}%` : "…"} />
      </div>
    </Card>
  );
}

const QUESTIONNAIRE_BADGE_COLOR: Record<string, "gray" | "green" | "yellow" | "blue"> = {
  started: "blue",
  abandoned: "yellow",
  submitted: "green",
};

type SortBy = "createdAt" | "leadReceivedDate" | "lastName";

function SortHeader({
  label,
  column,
  sortBy,
  sortDir,
  onSort,
}: {
  label: string;
  column: SortBy;
  sortBy: SortBy;
  sortDir: "asc" | "desc";
  onSort: (column: SortBy) => void;
}) {
  const active = sortBy === column;
  return (
    <th className="px-4 py-2">
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`flex items-center gap-1 font-medium uppercase ${active ? "text-gray-900" : "text-gray-500 hover:text-gray-700"}`}
      >
        {label}
        <span className="text-[10px]">{active ? (sortDir === "asc" ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
}

export function LeadsPage() {
  const [search, setSearch] = useState("");
  const [leadType, setLeadType] = useState("");
  const [purchaseStatus, setPurchaseStatus] = useState("");
  const [questionnaireId, setQuestionnaireId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("leadReceivedDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [showCreate, setShowCreate] = useState(false);

  function handleSort(column: SortBy) {
    if (column === sortBy) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(column);
      setSortDir("desc");
    }
  }

  const { data: leadTypesData } = useLeadTypes();
  const { data: questionnaireIdsData } = useQuestionnaireIds();
  const { data, isLoading } = useCustomersList({
    search: search || undefined,
    leadType: leadType || undefined,
    purchaseStatus: (purchaseStatus || undefined) as "purchased" | "not_purchased" | undefined,
    questionnaireId: questionnaireId || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    sortBy,
    sortDir,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Leads</h1>
        <Button onClick={() => setShowCreate((s) => !s)}>{showCreate ? "Cancel" : "New lead"}</Button>
      </div>

      <SummaryBar />

      {showCreate && <CreateCustomerForm onDone={() => setShowCreate(false)} />}

      <div className="flex flex-wrap gap-2">
        <Input
          className="max-w-xs"
          placeholder="Search by name, email, or phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="rounded-md border border-gray-300 px-3 py-1.5 text-sm" value={leadType} onChange={(e) => setLeadType(e.target.value)}>
          <option value="">All Lead Types</option>
          {leadTypesData?.leadTypes.map((lt) => (
            <option key={lt} value={lt}>
              {lt}
            </option>
          ))}
        </select>
        <select
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          value={purchaseStatus}
          onChange={(e) => setPurchaseStatus(e.target.value)}
        >
          <option value="">All Purchases</option>
          <option value="purchased">Purchased</option>
          <option value="not_purchased">Not Purchased</option>
        </select>
        <select
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          value={questionnaireId}
          onChange={(e) => setQuestionnaireId(e.target.value)}
        >
          <option value="">All Questionnaires</option>
          {questionnaireIdsData?.questionnaireIds.map((qid) => (
            <option key={qid} value={qid}>
              {qid}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-gray-500">Lead received</span>
          <Input type="date" className="w-auto" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          <span className="text-sm text-gray-400">–</span>
          <Input type="date" className="w-auto" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          {(dateFrom || dateTo) && (
            <button
              type="button"
              onClick={() => {
                setDateFrom("");
                setDateTo("");
              }}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <Card className="overflow-x-auto p-0">
        {isLoading ? (
          <p className="p-4 text-sm text-gray-500">Loading…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
              <tr>
                <SortHeader label="Lead" column="lastName" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <th className="px-4 py-2">Contact</th>
                <th className="px-4 py-2">Lead type</th>
                <SortHeader label="Lead received" column="leadReceivedDate" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <th className="px-4 py-2">Questionnaire</th>
                <th className="px-4 py-2">Purchase</th>
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
                  <td className="px-4 py-2 text-gray-600">
                    <div>{c.email}</div>
                    {c.phone && <div className="text-xs text-gray-400">{c.phone}</div>}
                  </td>
                  <td className="px-4 py-2">
                    <Badge color="gray">{c.leadType}</Badge>
                  </td>
                  <td className="px-4 py-2 text-gray-600">{c.leadReceivedDate}</td>
                  <td className="px-4 py-2">
                    {c.questionnaireStatus ? (
                      <Badge color={QUESTIONNAIRE_BADGE_COLOR[c.questionnaireStatus] ?? "gray"}>{c.questionnaireStatus}</Badge>
                    ) : (
                      <span className="text-xs text-gray-400">Not started</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {c.purchaseCount > 0 ? (
                      <div>
                        <Badge color="green">Purchased</Badge>
                        {c.firstPurchaseDate && <div className="mt-0.5 text-xs text-gray-400">since {c.firstPurchaseDate}</div>}
                      </div>
                    ) : (
                      <Badge color="gray">Not Purchased</Badge>
                    )}
                  </td>
                </tr>
              ))}
              {data?.customers.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-sm text-gray-400">
                    No leads found.
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
            {createCustomer.isPending ? "Creating…" : "Create lead"}
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
