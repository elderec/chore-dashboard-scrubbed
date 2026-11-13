import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // e2e/ holds Playwright specs (run via `npm run test:e2e`), not Vitest ones —
    // without this exclude, Vitest's default *.spec.ts pattern picks them up too and
    // fails immediately (Playwright's `test` fixture only works under its own runner).
    exclude: ["node_modules/**", "e2e/**"],
  },
});
