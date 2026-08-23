import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one development database (ADR-015: no Docker, so
    // no Testcontainers). Running files in parallel would let one suite's
    // logout race another's session, so they run sequentially.
    fileParallelism: false,
    // Argon2id is deliberately slow and each login pays for it.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
