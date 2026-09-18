import { describe, expect, it, afterEach, vi } from "vitest";

const notifySmsSlackMock = vi.fn();
vi.mock("./slack.js", () => ({ notifySmsSlack: (...args: unknown[]) => notifySmsSlackMock(...args) }));

const { notifySnapmeDtcLeadResponded } = await import("./snapme-webhook.js");

describe("notifySnapmeDtcLeadResponded", () => {
  const original = process.env.SNAPME_DTC_RESOLVER_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.SNAPME_DTC_RESOLVER_URL;
    else process.env.SNAPME_DTC_RESOLVER_URL = original;
    vi.unstubAllGlobals();
    notifySmsSlackMock.mockClear();
  });

  it("does nothing when SNAPME_DTC_RESOLVER_URL is unset", async () => {
    delete process.env.SNAPME_DTC_RESOLVER_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await notifySnapmeDtcLeadResponded("hey- id like to claim your fall offer, my promo code is 44hh45", "+15551234567", null);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs message and phone, omitting email when unknown — matches snapme.link's GHL-style resolver body", async () => {
    process.env.SNAPME_DTC_RESOLVER_URL = "https://www.snapme.link/resolve/99c5ebdb1e86854a";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await notifySnapmeDtcLeadResponded("my priority code is LUMK6MF", "+15551234567", null);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.snapme.link/resolve/99c5ebdb1e86854a",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "Content-Type": "application/json" }) }),
    );
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody).toEqual({ message: "my priority code is LUMK6MF", phone: "+15551234567" });
    expect(sentBody).not.toHaveProperty("email");
    expect(sentBody).not.toHaveProperty("ghl_contact_id");
  });

  it("includes email when already known", async () => {
    process.env.SNAPME_DTC_RESOLVER_URL = "https://www.snapme.link/resolve/99c5ebdb1e86854a";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await notifySnapmeDtcLeadResponded("my promo code is 44hh45", "+15551234567", "siba@example.com");

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody).toEqual({ message: "my promo code is 44hh45", phone: "+15551234567", email: "siba@example.com" });
  });

  it("alerts Slack but never throws on a non-2xx response", async () => {
    process.env.SNAPME_DTC_RESOLVER_URL = "https://www.snapme.link/resolve/99c5ebdb1e86854a";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("server error") }));

    await expect(notifySnapmeDtcLeadResponded("hi", "+15551234567", null)).resolves.toBeUndefined();
    expect(notifySmsSlackMock).toHaveBeenCalledTimes(1);
  });

  it("alerts Slack but never throws when the fetch itself rejects", async () => {
    process.env.SNAPME_DTC_RESOLVER_URL = "https://www.snapme.link/resolve/99c5ebdb1e86854a";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(notifySnapmeDtcLeadResponded("hi", "+15551234567", null)).resolves.toBeUndefined();
    expect(notifySmsSlackMock).toHaveBeenCalledTimes(1);
  });
});
