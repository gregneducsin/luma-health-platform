import { useState } from "react";
import type { UnmatchedEmailItem } from "@luma/shared";
import { useUnmatchedEmailsList, useSendUnmatchedEmailReply, useDismissUnmatchedEmail } from "../hooks/useUnmatchedEmails";
import { Badge, Card, Button } from "../components/ui";
import { ApiError } from "../hooks/useAuth";
import { formatDateTime } from "../lib/formatTime";

const INTENT_LABEL: Record<string, string> = {
  new_lead_interest: "New lead interest",
  existing_customer_support: "Support question",
  spam_or_irrelevant: "Spam / irrelevant",
  other: "Other",
};

const INTENT_COLOR: Record<string, "green" | "blue" | "gray" | "yellow"> = {
  new_lead_interest: "green",
  existing_customer_support: "blue",
  spam_or_irrelevant: "gray",
  other: "yellow",
};

const CONFIDENCE_COLOR: Record<string, "green" | "yellow" | "gray"> = { high: "green", medium: "yellow", low: "gray" };

function EmailRow({ item }: { item: UnmatchedEmailItem }) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(item.suggestedReply ?? "");
  const sendReply = useSendUnmatchedEmailReply();
  const dismiss = useDismissUnmatchedEmail();

  function handleSend() {
    const body = draft.trim();
    if (!body || sendReply.isPending) return;
    sendReply.mutate({ id: item.id, body });
  }

  return (
    <Card className="p-0">
      <button onClick={() => setExpanded((e) => !e)} className="block w-full px-4 py-3 text-left hover:bg-gray-50">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-sm font-medium text-gray-900">
            {item.fromName || item.fromAddress}
            {item.aiIntent && <Badge color={INTENT_COLOR[item.aiIntent] ?? "gray"}>{INTENT_LABEL[item.aiIntent] ?? item.aiIntent}</Badge>}
            {item.status !== "needs_review" && <Badge color={item.status === "replied" ? "green" : "gray"}>{item.status}</Badge>}
          </span>
          <span className="text-xs text-gray-400">{formatDateTime(item.createdAt)}</span>
        </div>
        <p className="mt-1 text-xs text-gray-500">{item.subject}</p>
        {item.aiSummary && <p className="mt-1 truncate text-xs text-gray-400">{item.aiSummary}</p>}
      </button>
      {expanded && (
        <div className="space-y-3 border-t border-gray-100 px-4 py-3">
          <div>
            <p className="text-xs font-medium text-gray-400">From</p>
            <p className="text-sm text-gray-800">
              {item.fromName ? `${item.fromName} <${item.fromAddress}>` : item.fromAddress}
            </p>
          </div>
          <div className="rounded-md bg-gray-50 p-3">
            <p className="text-xs font-medium text-gray-400">{item.subject}</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-gray-800">{item.body}</p>
          </div>

          {item.suggestedMatchCustomerId && (
            <div className="rounded-md bg-yellow-50 px-3 py-2">
              <p className="text-xs text-yellow-800">
                Possibly an existing customer ({item.suggestedMatchConfidence && (
                  <Badge color={CONFIDENCE_COLOR[item.suggestedMatchConfidence]}>{item.suggestedMatchConfidence} confidence</Badge>
                )}
                ) — not linked automatically. Confirm in{" "}
                <a href={`/customers/${item.suggestedMatchCustomerId}`} className="font-medium underline">
                  their customer record
                </a>{" "}
                before treating this as their thread.
              </p>
            </div>
          )}

          {item.status === "needs_review" && (
            <div>
              <p className="mb-1 text-xs font-medium text-gray-400">
                {item.suggestedReply ? "Claude's suggested reply — review and edit before sending:" : "No suggested reply — write one, or dismiss:"}
              </p>
              <textarea
                className="w-full rounded-md border border-gray-300 p-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                rows={4}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={sendReply.isPending}
              />
              <div className="mt-2 flex items-center gap-2">
                <Button onClick={handleSend} disabled={sendReply.isPending || !draft.trim()}>
                  {sendReply.isPending ? "Sending…" : "Send reply"}
                </Button>
                <Button variant="secondary" onClick={() => dismiss.mutate(item.id)} disabled={dismiss.isPending}>
                  {dismiss.isPending ? "Dismissing…" : "Dismiss"}
                </Button>
              </div>
              {sendReply.isSuccess && sendReply.data.sent === false && (
                <p className="mt-1 text-xs text-red-600">Send failed — nothing went out. Try again.</p>
              )}
              {sendReply.isError && (
                <p className="mt-1 text-xs text-red-600">{sendReply.error instanceof ApiError ? sendReply.error.message : "Something went wrong."}</p>
              )}
            </div>
          )}
          {item.status === "replied" && item.repliedAt && <p className="text-xs text-gray-400">Replied {formatDateTime(item.repliedAt)}.</p>}
        </div>
      )}
    </Card>
  );
}

export function UnmatchedEmailsPage() {
  const { data, isLoading } = useUnmatchedEmailsList();
  const needsReview = data?.items.filter((i) => i.status === "needs_review") ?? [];
  const resolved = data?.items.filter((i) => i.status !== "needs_review") ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Unmatched Emails</h1>
        {data && <p className="text-sm text-gray-500">{needsReview.length} awaiting review</p>}
      </div>
      <p className="text-xs text-gray-400">
        Inbound email from an address that doesn't match any customer record. Claude drafts a classification and a safe, generic suggested reply for
        each one — nothing here is ever sent automatically, and a suggested existing-customer match is never linked automatically. Review, edit if
        needed, and send or dismiss.
      </p>

      {isLoading && <p className="text-sm text-gray-400">Loading…</p>}
      {data && data.items.length === 0 && (
        <Card>
          <p className="text-sm text-gray-500">Nothing here right now.</p>
        </Card>
      )}

      <div className="space-y-2">
        {needsReview.map((item) => (
          <EmailRow key={item.id} item={item} />
        ))}
      </div>

      {resolved.length > 0 && (
        <details className="text-sm text-gray-500">
          <summary className="cursor-pointer text-xs font-medium text-gray-400">{resolved.length} replied or dismissed</summary>
          <div className="mt-2 space-y-2">
            {resolved.map((item) => (
              <EmailRow key={item.id} item={item} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
