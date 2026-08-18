import { describe, expect, it } from "vitest";
import {
  htmlToPlainText,
  wrapEmailHtml,
  renderOrderReceivedEmail,
  renderPrescriptionWrittenEmail,
  renderOrderShippedEmail,
  renderReviewRequestEmail,
  renderAbandonedCartOpenerEmail,
  renderAbandonedCartUrgencyEmail,
  renderAbandonedCartEducationalEmail,
  renderAbandonedCartPlanComparisonEmail,
  renderCurrentlyTakingCheckinEmail,
  renderReengagementCheckinEmail,
  renderConversationReplyEmail,
} from "./templates.js";

const UNSUB_URL = "http://localhost:3000/unsubscribe/abc.def";
const CTA_URL = "http://localhost:3000/go/abc123";

describe("htmlToPlainText", () => {
  it("strips tags and collapses whitespace", () => {
    expect(htmlToPlainText("<p>Hello  <strong>there</strong></p>\n<p>Bye</p>")).toBe("Hello there Bye");
  });
});

describe("wrapEmailHtml", () => {
  it("includes the unsubscribe link in the footer", () => {
    const html = wrapEmailHtml("<p>hi</p>", UNSUB_URL);
    expect(html).toContain(UNSUB_URL);
    expect(html).toContain("<p>hi</p>");
  });
});

describe("fixed trigger-email templates", () => {
  const cases: Array<[string, () => { subject: string; html: string }]> = [
    ["order received", () => renderOrderReceivedEmail("Jamie", UNSUB_URL)],
    ["prescription written", () => renderPrescriptionWrittenEmail("Jamie", UNSUB_URL)],
    ["order shipped", () => renderOrderShippedEmail("Jamie", "1Z999AA10123456784", UNSUB_URL)],
    ["review request", () => renderReviewRequestEmail("Jamie", UNSUB_URL)],
    ["abandoned cart opener", () => renderAbandonedCartOpenerEmail("Jamie", CTA_URL, UNSUB_URL)],
    ["abandoned cart urgency", () => renderAbandonedCartUrgencyEmail("Jamie", CTA_URL, UNSUB_URL)],
    ["abandoned cart educational", () => renderAbandonedCartEducationalEmail("Jamie", CTA_URL, UNSUB_URL)],
    ["abandoned cart plan comparison", () => renderAbandonedCartPlanComparisonEmail("Jamie", CTA_URL, UNSUB_URL)],
    ["currently-taking checkin", () => renderCurrentlyTakingCheckinEmail("Jamie", UNSUB_URL)],
    ["reengagement checkin", () => renderReengagementCheckinEmail("Jamie", UNSUB_URL)],
  ];

  for (const [label, render] of cases) {
    it(`${label}: has a non-empty subject, mentions the customer by name, and carries the unsubscribe link`, () => {
      const { subject, html } = render();
      expect(subject.length).toBeGreaterThan(0);
      expect(html).toContain("Jamie");
      expect(html).toContain(UNSUB_URL);
    });
  }

  it("order-shipped includes the tracking number", () => {
    const { html } = renderOrderShippedEmail("Jamie", "1Z999AA10123456784", UNSUB_URL);
    expect(html).toContain("1Z999AA10123456784");
  });

  it("falls back to 'there' for a blank first name", () => {
    const { html } = renderOrderReceivedEmail("   ", UNSUB_URL);
    expect(html).toContain("there");
  });

  it("each abandoned-cart drip step's CTA button links to the minted per-lead ctaUrl, not a static link", () => {
    for (const render of [renderAbandonedCartOpenerEmail, renderAbandonedCartUrgencyEmail, renderAbandonedCartEducationalEmail, renderAbandonedCartPlanComparisonEmail]) {
      const { html } = render("Jamie", CTA_URL, UNSUB_URL);
      expect(html).toContain(`href="${CTA_URL}"`);
    }
  });
});

describe("renderConversationReplyEmail", () => {
  it("splits on blank lines into separate paragraphs and carries the unsubscribe link", () => {
    const html = renderConversationReplyEmail("First paragraph.\n\nSecond paragraph.", UNSUB_URL);
    expect(html).toContain("<p>First paragraph.</p>");
    expect(html).toContain("<p>Second paragraph.</p>");
    expect(html).toContain(UNSUB_URL);
  });
});
