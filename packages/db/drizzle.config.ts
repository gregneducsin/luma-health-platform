import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
}

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  schema: path.join(dirname, "./src/schema/index.ts"),
  out: path.join(dirname, "./drizzle"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
