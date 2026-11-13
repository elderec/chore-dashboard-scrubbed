import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    // public/index.html itself still can't be parsed by ESLint (it's HTML, not
    // JS) — public/app.js and public/style.css, split out from it, are plain
    // files ESLint/its tooling handle natively, so they're not ignored below.
    ignores: ["node_modules/**", ".wrangler/**", "dist/**", "public/index.html"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.worker,
        ...globals.es2022,
      },
    },
  },
  {
    files: ["test/**/*.ts", "e2e/**/*.ts", "e2e/**/*.mjs", "playwright.config.ts", "scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // public/app.js runs in the kiosk's browser, not a Worker — a different
    // global set than the rest of this repo (window/document/location instead
    // of Cloudflare's WebWorker-shaped scope).
    files: ["public/app.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  eslintConfigPrettier
);
