import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Sequential — each test file that touches the DB manages its own
    // isolated schema; keep runs simple and predictable for now.
    fileParallelism: false,
  },
});
