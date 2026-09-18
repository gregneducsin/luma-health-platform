import { describe, expect, it, afterEach, vi } from "vitest";

const notifySmsSlackMock = vi.fn();
vi.mock("./slack.js", () => ({ notifySmsSlack: (...args: unknown[]) => notifySmsSlackMock(...args) }));

const { notifySnapmePriorityCodeReceived } = await import("./snapme-webhook.js");

describe("notifySnapmePriorityCodeReceived", () => {
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

    await notifySnapmePriorityCodeReceived("+15551234567", "44hh45");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs just phone and code", async () => {
    process.env.SNAPME_DTC_RESOLVER_URL = "https://www.snapme.link/resolve/99c5ebdb1e86854a";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await notifySnapmePriorityCodeReceived("+15551234567", "LUMK6MF");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.snapme.link/resolve/99c5ebdb1e86854a",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "Content-Type": "application/json" }) }),
    );
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody).toEqual({ phone: "+15551234567", code: "LUMK6MF" });
    expect(sentBody).not.toHaveProperty("message");
    expect(sentBody).not.toHaveProperty("email");
    expect(sentBody).not.toHaveProperty("ghl_contact_id");
  });

  it("alerts Slack but never throws on a non-2xx response", async () => {
    process.env.SNAPME_DTC_RESOLVER_URL = "https://www.snapme.link/resolve/99c5ebdb1e86854a";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("server error") }));

    await expect(notifySnapmePriorityCodeReceived("+15551234567", "44hh45")).resolves.toBeUndefined();
    expect(notifySmsSlackMock).toHaveBeenCalledTimes(1);
  });

  it("alerts Slack but never throws when the fetch itself rejects", async () => {
    process.env.SNAPME_DTC_RESOLVER_URL = "https://www.snapme.link/resolve/99c5ebdb1e86854a";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(notifySnapmePriorityCodeReceived("+15551234567", "44hh45")).resolves.toBeUndefined();
    expect(notifySmsSlackMock).toHaveBeenCalledTimes(1);
  });
});
