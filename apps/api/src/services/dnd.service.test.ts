import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";
import { isCustomerDnd, setCustomerDnd } from "./dnd.service.js";

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName: "Dnd", lastName: "Test", email: `dnd-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15" })
    .returning({ id: customersTable.id });
  return row.id;
}

describe("dnd.service", () => {
  it("defaults to not do-not-disturb for a new customer", async () => {
    const personId = await seedCustomer();
    expect(await isCustomerDnd(personId)).toBe(false);
  });

  it("setCustomerDnd(true) sets dnd and stamps dndAt", async () => {
    const personId = await seedCustomer();
    await setCustomerDnd(personId, true);

    expect(await isCustomerDnd(personId)).toBe(true);
    const [row] = await db.select({ dnd: customersTable.dnd, dndAt: customersTable.dndAt }).from(customersTable).where(eq(customersTable.id, personId));
    expect(row.dnd).toBe(true);
    expect(row.dndAt).not.toBeNull();
  });

  it("setCustomerDnd(false) clears dnd and dndAt", async () => {
    const personId = await seedCustomer();
    await setCustomerDnd(personId, true);
    await setCustomerDnd(personId, false);

    expect(await isCustomerDnd(personId)).toBe(false);
    const [row] = await db.select({ dnd: customersTable.dnd, dndAt: customersTable.dndAt }).from(customersTable).where(eq(customersTable.id, personId));
    expect(row.dnd).toBe(false);
    expect(row.dndAt).toBeNull();
  });
});
