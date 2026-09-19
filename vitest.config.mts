import { defineConfig } from "vitest/config";

// Plain node: nothing under tests/ touches the Workers runtime, so the worker pool
// would only cost startup time.
export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
