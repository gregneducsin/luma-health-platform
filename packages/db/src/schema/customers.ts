import { pgTable, text, uuid, date, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// person_number_seq is NOT declared here via drizzle-kit's pgSequence() —
// drizzle-kit hard-qualifies generated sequences to "public" regardless of
// the connection's search_path (unlike tables, which it leaves unqualified),
// which silently breaks schema-based test isolation. Instead this sequence
// is created as an idempotent, unqualified bootstrap step in migrate.ts,
// which correctly follows search_path in both production and test. See
// PERSON_NUMBER_SEQ_NAME below and migrate.ts's SEQUENCE_BOOTSTRAP_SQL.
export const PERSON_NUMBER_SEQ_NAME = "person_number_seq";

/**
 * Customers/leads. `phone` is kept normalized (E.164) — this is the join key
 * the future texting/messaging phase will hang off of; see ARCHITECTURE.md.
 */
export const customersTable = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personNumber: text("person_number")
      .notNull()
      .default(sql`('PER-' || lpad(nextval('person_number_seq')::text, 6, '0'))`),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    leadReceivedDate: date("lead_received_date", { mode: "string" }).notNull(),
    leadCreatedAt: timestamp("lead_created_at", { withTimezone: true }),
    leadType: text("lead_type").notNull().default("Other / Unknown"),
    // Do-not-disturb: set when the customer texts STOP/UNSUBSCRIBE, cleared
    // automatically the moment they make a purchase. Every outbound send
    // path (dnd.service.ts's isCustomerDnd) must check this before sending.
    dnd: boolean("dnd").notNull().default(false),
    dndAt: timestamp("dnd_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("customers_person_number_key").on(t.personNumber), index("customers_email_idx").on(t.email)],
);

/** External system ID mappings (e.g. a GoHighLevel contact ID) per customer. */
export const externalIdentitiesTable = pgTable(
  "external_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
    system: text("system").notNull(),
    externalId: text("external_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("external_identities_system_external_id_key").on(t.system, t.externalId),
    index("external_identities_person_id_idx").on(t.personId),
  ],
);

export type Customer = typeof customersTable.$inferSelect;
export type InsertCustomer = typeof customersTable.$inferInsert;
