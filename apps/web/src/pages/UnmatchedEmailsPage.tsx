import { useState } from "react";
import type { UnmatchedEmailThreadSummary } from "@luma/shared";
import { useUnmatchedEmailsList, useUnmatchedEmailThread, useSendUnmatchedEmailReply, useDismissUnmatchedEmail } from "../hooks/useUnmatchedEmails";
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

function ThreadMessages({ threadId }: { threadId: string }) {
  const { data, isLoading } = useUnmatchedEmailThread(threadId);

  if (isLoading || !data) return <p className="px-4 pb-3 text-xs text-gray-400">Loading messages…</p>;

  return (
    <div className="space-y-2 px-4 pb-3">
      {data.messages.map((m) => (
        <div key={m.id} className={m.direction === "inbound" ? "text-left" : "text-right"}>
          <div className={"inline-block max-w-[85%] rounded-lg px-3 py-2 text-left text-xs " + (m.direction === "inbound" ? "bg-gray-100 text-gray-800" : "bg-blue-600 text-white")}>
            <p className="mb-0.5 font-semibold">{m.subject}</p>
            <p className="whitespace-pre-wrap">{m.body}</p>
          </div>
          <p className="mt-0.5 text-[11px] text-gray-400">{formatDateTime(m.createdAt)}</p>
        </div>
      ))}
    </div>
  );
}

function ThreadRow({ thread }: { thread: UnmatchedEmailThreadSummary }) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(thread.suggestedReply ?? "");
  const sendReply = useSendUnmatchedEmailReply();
  const dismiss = useDismissUnmatchedEmail();

  function handleSend() {
    const body = draft.trim();
    if (!body || sendReply.isPending) return;
    sendReply.mutate({ id: thread.id, body });
  }

  return (
    <Card className="p-0">
      <button onClick={() => setExpanded((e) => !e)} className="block w-full px-4 py-3 text-left hover:bg-gray-50">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-sm font-medium text-gray-900">
            {thread.fromName || thread.fromAddress}
            {thread.aiIntent && <Badge color={INTENT_COLOR[thread.aiIntent] ?? "gray"}>{INTENT_LABEL[thread.aiIntent] ?? thread.aiIntent}</Badge>}
            {thread.linkedCustomerId && <Badge color="green">Lead created</Badge>}
            {thread.status !== "needs_review" && <Badge color={thread.status === "replied" ? "green" : "gray"}>{thread.status}</Badge>}
          </span>
          <span className="text-xs text-gray-400">{formatDateTime(thread.lastMessageAt ?? thread.createdAt)}</span>
        </div>
        {thread.aiSummary && <p className="mt-1 truncate text-xs text-gray-400">{thread.aiSummary}</p>}
        <p className="mt-1 truncate text-xs text-gray-500">{thread.lastMessagePreview ?? "No messages yet"}</p>
      </button>
      {expanded && (
        <div className="space-y-3 border-t border-gray-100">
          <div className="px-4 pt-3">
            <p className="text-xs font-medium text-gray-400">From</p>
            <p className="text-sm text-gray-800">{thread.fromName ? `${thread.fromName} <${thread.fromAddress}>` : thread.fromAddress}</p>
          </div>

          <ThreadMessages threadId={thread.id} />

          {thread.linkedCustomerId && (
            <div className="mx-4 rounded-md bg-green-50 px-3 py-2">
              <p className="text-xs text-green-800">
                A new lead was created for this sender —{" "}
                <a href={`/customers/${thread.linkedCustomerId}`} className="font-medium underline">
                  view their record
                </a>
                . Future emails from this address will route through the normal Lucy pipeline automatically.
              </p>
            </div>
          )}

          {thread.suggestedMatchCustomerId && !thread.linkedCustomerId && (
            <div className="mx-4 rounded-md bg-yellow-50 px-3 py-2">
              <p className="text-xs text-yellow-800">
                Possibly an existing customer ({thread.suggestedMatchConfidence && (
                  <Badge color={CONFIDENCE_COLOR[thread.suggestedMatchConfidence]}>{thread.suggestedMatchConfidence} confidence</Badge>
                )}
                ) — not linked automatically. Confirm in{" "}
                <a href={`/customers/${thread.suggestedMatchCustomerId}`} className="font-medium underline">
                  their customer record
                </a>{" "}
                before treating this as their thread.
              </p>
            </div>
          )}

          {thread.status === "needs_review" && (
            <div className="px-4 pb-3">
              <p className="mb-1 text-xs font-medium text-gray-400">
                {thread.suggestedReply ? "Claude's suggested reply — review and edit before sending:" : "No suggested reply — write one, or dismiss:"}
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
                <Button variant="secondary" onClick={() => dismiss.mutate(thread.id)} disabled={dismiss.isPending}>
                  {dismiss.isPending ? "Dismissing…" : "Dismiss"}
                </Button>
              </div>
              {sendReply.isSuccess && sendReply.data.sent === false && <p className="mt-1 text-xs text-red-600">Send failed — nothing went out. Try again.</p>}
              {sendReply.isError && <p className="mt-1 text-xs text-red-600">{sendReply.error instanceof ApiError ? sendReply.error.message : "Something went wrong."}</p>}
            </div>
          )}
          {thread.status === "replied" && thread.repliedAt && <p className="px-4 pb-3 text-xs text-gray-400">Replied {formatDateTime(thread.repliedAt)}.</p>}
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
        Inbound email from an address that doesn't match any customer record, grouped one thread per sender. Claude drafts a classification and a
        safe, generic suggested reply — it asks for the sender's name if we don't already know it. A new lead is created automatically once we know
        their name and Claude is confident it's a genuine inquiry, but suggested matches to an existing customer are never linked automatically, and
        no reply is ever sent automatically. Review, edit if needed, and send or dismiss.
      </p>

      {isLoading && <p className="text-sm text-gray-400">Loading…</p>}
      {data && data.items.length === 0 && (
        <Card>
          <p className="text-sm text-gray-500">Nothing here right now.</p>
        </Card>
      )}

      <div className="space-y-2">
        {needsReview.map((thread) => (
          <ThreadRow key={thread.id} thread={thread} />
        ))}
      </div>

      {resolved.length > 0 && (
        <details className="text-sm text-gray-500">
          <summary className="cursor-pointer text-xs font-medium text-gray-400">{resolved.length} replied or dismissed</summary>
          <div className="mt-2 space-y-2">
            {resolved.map((thread) => (
              <ThreadRow key={thread.id} thread={thread} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
