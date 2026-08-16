import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useSupportConversationsList, useSupportConversationDetail, useSendSarahTestMessage, useClearSupportNeedsAttention } from "../hooks/useSupportConversations";
import { Badge, Card, Button, Input } from "../components/ui";
import { ApiError } from "../hooks/useAuth";

const SENTIMENT_COLOR: Record<string, "green" | "gray" | "red"> = {
  positive: "green",
  neutral: "gray",
  negative: "red",
};

function SentimentBadge({ sentiment }: { sentiment: "positive" | "neutral" | "negative" | null }) {
  if (!sentiment) return null;
  return <Badge color={SENTIMENT_COLOR[sentiment]}>{sentiment}</Badge>;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

function SupportConversationList({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string) => void }) {
  const { data, isLoading } = useSupportConversationsList();
  const [onlyNeedsAttention, setOnlyNeedsAttention] = useState(false);

  const attentionCount = data?.conversations.filter((c) => c.needsAttention).length ?? 0;
  const visible = useMemo(() => {
    if (!data) return [];
    return onlyNeedsAttention ? data.conversations.filter((c) => c.needsAttention) : data.conversations;
  }, [data, onlyNeedsAttention]);

  return (
    <Card className="flex h-[calc(100vh-180px)] flex-col overflow-hidden p-0">
      <div className="border-b border-gray-200 px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Support</h2>
          {attentionCount > 0 && <Badge color="red">{attentionCount} need attention</Badge>}
        </div>
        <div className="mt-2 flex gap-1">
          <button
            onClick={() => setOnlyNeedsAttention(false)}
            className={"rounded px-2 py-1 text-xs font-medium " + (!onlyNeedsAttention ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600")}
          >
            All
          </button>
          <button
            onClick={() => setOnlyNeedsAttention(true)}
            className={"rounded px-2 py-1 text-xs font-medium " + (onlyNeedsAttention ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600")}
          >
            Needs attention
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {isLoading && <p className="p-4 text-sm text-gray-400">Loading…</p>}
        {data && visible.length === 0 && (
          <p className="p-4 text-sm text-gray-400">{onlyNeedsAttention ? "Nothing needs attention right now." : "No conversations yet."}</p>
        )}
        {visible.map((c) => (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            className={
              "block w-full border-b border-gray-100 px-4 py-3 text-left hover:bg-gray-50 " + (selectedId === c.id ? "bg-blue-50" : "")
            }
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-sm font-medium text-gray-900">
                {c.needsAttention && <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-label="Needs attention" />}
                {c.firstName} {c.lastName}
              </span>
              <span className="text-xs text-gray-400">{relativeTime(c.lastMessageAt)}</span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <p className="flex-1 truncate text-xs text-gray-500">{c.lastMessagePreview ?? "No messages yet"}</p>
              <SentimentBadge sentiment={c.lastSentiment} />
            </div>
          </button>
        ))}
      </div>
    </Card>
  );
}

function SupportConversationDetailPanel({ conversationId }: { conversationId: string }) {
  const { data, isLoading } = useSupportConversationDetail(conversationId);
  const [input, setInput] = useState("");
  const sendMessage = useSendSarahTestMessage();
  const clearAttention = useClearSupportNeedsAttention();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [data?.messages.length]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const message = input.trim();
    if (!message || !data || sendMessage.isPending) return;
    sendMessage.mutate({ customerId: data.conversation.personId, message }, { onSuccess: () => setInput("") });
  }

  if (isLoading || !data) {
    return (
      <Card className="flex h-[calc(100vh-180px)] items-center justify-center">
        <p className="text-sm text-gray-400">Loading conversation…</p>
      </Card>
    );
  }

  const { conversation, customer, messages } = data;

  return (
    <Card className="flex h-[calc(100vh-180px)] flex-col overflow-hidden p-0">
      <div className="border-b border-gray-200 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              {customer.firstName} {customer.lastName}
              {conversation.needsAttention && <Badge color="red">Needs attention</Badge>}
            </p>
            <p className="text-xs text-gray-400">{customer.phone ?? "No phone on file"}</p>
          </div>
          <div className="flex flex-wrap justify-end gap-1">
            {conversation.prescriptionWritten && <Badge color="blue">prescription written</Badge>}
            {conversation.orderShipped && <Badge color="green">shipped{conversation.trackingNumber ? `: ${conversation.trackingNumber}` : ""}</Badge>}
            {conversation.reviewRequested && <Badge color="gray">review requested</Badge>}
            {conversation.reviewSentiment && <SentimentBadge sentiment={conversation.reviewSentiment} />}
          </div>
        </div>
        {conversation.needsAttention && (
          <div className="mt-2 flex items-center justify-between rounded-md bg-red-50 px-3 py-2">
            <p className="text-xs text-red-700">This conversation needs staff attention.</p>
            <Button variant="secondary" onClick={() => clearAttention.mutate(conversation.id)} disabled={clearAttention.isPending}>
              {clearAttention.isPending ? "Marking…" : "Mark reviewed"}
            </Button>
          </div>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && <p className="text-sm text-gray-400">No messages yet.</p>}
        {messages.map((m) => (
          <div key={m.id} className={m.direction === "inbound" ? "text-left" : "text-right"}>
            <div className={"inline-flex max-w-[75%] flex-col gap-1 " + (m.direction === "inbound" ? "items-start" : "items-end")}>
              <span
                className={
                  m.direction === "inbound"
                    ? "inline-block whitespace-pre-wrap rounded-lg bg-gray-100 px-3 py-2 text-left text-sm text-gray-800"
                    : "inline-block whitespace-pre-wrap rounded-lg bg-purple-600 px-3 py-2 text-left text-sm text-white"
                }
              >
                {m.body}
              </span>
              <div className="flex items-center gap-2 px-1">
                <span className="text-[11px] text-gray-400">{new Date(m.createdAt).toLocaleTimeString()}</span>
                <SentimentBadge sentiment={m.sentiment} />
              </div>
            </div>
          </div>
        ))}
        {sendMessage.isPending && <p className="text-sm text-gray-400">Sarah is thinking…</p>}
      </div>

      <form onSubmit={handleSubmit} className="border-t border-gray-200 p-3">
        <p className="mb-2 text-xs text-gray-400">
          No SMS provider is connected yet — simulate what the patient would text back to test the live guardrails.
        </p>
        <div className="flex items-center gap-2">
          <Input
            className="flex-1"
            placeholder="Simulate an inbound message…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={sendMessage.isPending}
          />
          <Button type="submit" disabled={sendMessage.isPending || !input.trim()}>
            Send
          </Button>
        </div>
        {sendMessage.isError && (
          <p className="mt-2 text-xs text-red-600">
            {sendMessage.error instanceof ApiError ? sendMessage.error.message : "Something went wrong."}
          </p>
        )}
        {sendMessage.isSuccess && sendMessage.data.ok === false && (
          <p className="mt-2 text-xs text-red-600">Sarah's reply was rejected by the guardrail ({sendMessage.data.code}) — nothing was sent.</p>
        )}
      </form>
    </Card>
  );
}

export function SupportPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <div className="md:col-span-1">
        <SupportConversationList selectedId={selectedId} onSelect={setSelectedId} />
      </div>
      <div className="md:col-span-2">
        {selectedId ? (
          <SupportConversationDetailPanel conversationId={selectedId} />
        ) : (
          <Card className="flex h-[calc(100vh-180px)] items-center justify-center">
            <p className="text-sm text-gray-400">Select a conversation to view it.</p>
          </Card>
        )}
      </div>
    </div>
  );
}
