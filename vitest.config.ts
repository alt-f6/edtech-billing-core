import { defineConfig } from "vitest/config";

// Load DATABASE_URL from .env when present (CI sets it directly).
try {
  process.loadEnvFile();
} catch {
  // no .env file
}

export default defineConfig({
  test: {
    globalSetup: ["./tests/global-setup.ts"],
    env: { IP_HASH_KEY: process.env.IP_HASH_KEY ?? "test-only-ip-hash-key" },
    // All test files share one database; run them one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
