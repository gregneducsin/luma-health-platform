import { describe, expect, it } from "vitest";
import { db, customersTable } from "@luma/db";
import { getOrCreateConversation, appendMessage, updateConversationState } from "./conversations.service.js";
import { getOrCreateSupportConversation, appendSupportMessage, updateSupportConversationState } from "./support-conversations.service.js";
import { getOrCreateEmailConversation, appendEmailMessage, updateEmailConversationState } from "./email-conversations.service.js";
import { getOrCreateSupportEmailConversation, appendSupportEmailMessage, updateSupportEmailConversationState } from "./support-email-conversations.service.js";
import { listNeedsAttention, getNeedsAttentionMessages, clearNeedsAttentionItem } from "./needs-attention.service.js";

async function seedCustomer(firstName: string): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName, lastName: "Attention", email: `attention-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15" })
    .returning({ id: customersTable.id });
  return row.id;
}

describe("listNeedsAttention", () => {
  it("returns flagged conversations across all 4 channels and excludes unflagged ones", async () => {
    const lucySmsPerson = await seedCustomer("LucySms");
    const lucySmsConvo = await getOrCreateConversation(lucySmsPerson);
    await appendMessage(lucySmsConvo.id, "inbound", "help, I have a medical question", {});
    await updateConversationState(lucySmsConvo.id, { needsAttention: true });

    const sarahSmsPerson = await seedCustomer("SarahSms");
    const sarahSmsConvo = await getOrCreateSupportConversation(sarahSmsPerson);
    await appendSupportMessage(sarahSmsConvo.id, "inbound", "is this covered by insurance", {});
    await updateSupportConversationState(sarahSmsConvo.id, { needsAttention: true });

    const lucyEmailPerson = await seedCustomer("LucyEmail");
    const lucyEmailConvo = await getOrCreateEmailConversation(lucyEmailPerson);
    await appendEmailMessage(lucyEmailConvo.id, "inbound", "Question", "what state am I in for this", {});
    await updateEmailConversationState(lucyEmailConvo.id, { needsAttention: true });

    const sarahEmailPerson = await seedCustomer("SarahEmail");
    const sarahEmailConvo = await getOrCreateSupportEmailConversation(sarahEmailPerson);
    await appendSupportEmailMessage(sarahEmailConvo.id, "inbound", "Re: order", "emergency, please call me", {});
    await updateSupportEmailConversationState(sarahEmailConvo.id, { needsAttention: true });

    const notFlaggedPerson = await seedCustomer("NotFlagged");
    await getOrCreateConversation(notFlaggedPerson);

    const items = await listNeedsAttention();
    const byPerson = Object.fromEntries(items.map((i) => [i.personId, i]));

    expect(byPerson[lucySmsPerson]).toMatchObject({ channel: "sms", persona: "lucy" });
    expect(byPerson[sarahSmsPerson]).toMatchObject({ channel: "sms", persona: "sarah" });
    expect(byPerson[lucyEmailPerson]).toMatchObject({ channel: "email", persona: "lucy" });
    expect(byPerson[sarahEmailPerson]).toMatchObject({ channel: "email", persona: "sarah" });
    expect(byPerson[notFlaggedPerson]).toBeUndefined();
  });
});

describe("getNeedsAttentionMessages", () => {
  it("returns the email conversation's recent messages with subjects, oldest first", async () => {
    const personId = await seedCustomer("EmailHistory");
    const convo = await getOrCreateEmailConversation(personId);
    await appendEmailMessage(convo.id, "inbound", "First subject", "first body", {});
    await appendEmailMessage(convo.id, "outbound", "Second subject", "second body", {});

    const messages = await getNeedsAttentionMessages("email", "lucy", convo.id);
    expect(messages.map((m) => m.subject)).toEqual(["First subject", "Second subject"]);
    expect(messages.map((m) => m.direction)).toEqual(["inbound", "outbound"]);
  });

  it("returns the SMS conversation's recent messages with a null subject", async () => {
    const personId = await seedCustomer("SmsHistory");
    const convo = await getOrCreateConversation(personId);
    await appendMessage(convo.id, "inbound", "hi there", {});

    const messages = await getNeedsAttentionMessages("sms", "lucy", convo.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toBeNull();
    expect(messages[0].body).toBe("hi there");
  });
});

describe("clearNeedsAttentionItem", () => {
  it("clears the flag for each of the 4 channel/persona combinations", async () => {
    const lucySmsPerson = await seedCustomer("ClearLucySms");
    const lucySmsConvo = await getOrCreateConversation(lucySmsPerson);
    await updateConversationState(lucySmsConvo.id, { needsAttention: true });
    await clearNeedsAttentionItem("sms", "lucy", lucySmsConvo.id);

    const sarahSmsPerson = await seedCustomer("ClearSarahSms");
    const sarahSmsConvo = await getOrCreateSupportConversation(sarahSmsPerson);
    await updateSupportConversationState(sarahSmsConvo.id, { needsAttention: true });
    await clearNeedsAttentionItem("sms", "sarah", sarahSmsConvo.id);

    const lucyEmailPerson = await seedCustomer("ClearLucyEmail");
    const lucyEmailConvo = await getOrCreateEmailConversation(lucyEmailPerson);
    await updateEmailConversationState(lucyEmailConvo.id, { needsAttention: true });
    await clearNeedsAttentionItem("email", "lucy", lucyEmailConvo.id);

    const sarahEmailPerson = await seedCustomer("ClearSarahEmail");
    const sarahEmailConvo = await getOrCreateSupportEmailConversation(sarahEmailPerson);
    await updateSupportEmailConversationState(sarahEmailConvo.id, { needsAttention: true });
    await clearNeedsAttentionItem("email", "sarah", sarahEmailConvo.id);

    const items = await listNeedsAttention();
    const flaggedPersonIds = new Set(items.map((i) => i.personId));
    for (const personId of [lucySmsPerson, sarahSmsPerson, lucyEmailPerson, sarahEmailPerson]) {
      expect(flaggedPersonIds.has(personId)).toBe(false);
    }
  });
});
