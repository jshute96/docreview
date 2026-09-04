import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Other generated/vendored directories that are not source. Linting these
    // is slow (they contain huge bundled files) and can crash ESLint.
    ".next-test/**",
    ".next-test-interactive/**",
    ".chrome-test-profile/**",
    ".chrome-test-extension-profile/**",
    ".playwright-mcp/**",
    "test-results/**",
    "playwright-report/**",
    "coverage/**",
    "logs/**",
    // Captured third-party web pages used as test fixtures.
    "testing/extension-snapshot/snapshots/**",
  ]),
  {
    // Project policy: app code logs via the helpers in `src/lib/log.ts`, never
    // raw console. Client components that legitimately want output in the
    // browser devtools console opt out with an inline eslint-disable comment.
    // Not applied to `src/chrome-extension/**` (browser-only, no access to the
    // server logger) or `scripts/**` (CLI tools whose output *is* the console).
    files: ["src/**"],
    ignores: ["src/chrome-extension/**", "src/lib/log.ts"],
    rules: {
      "no-console": "warn",
    },
  },
  {
    // Every <img> in this app is a small fixed-size icon (mostly the local
    // logo SVG, which next/image does not optimize), so `next/image` would add
    // configuration without saving any bytes.
    rules: {
      "@next/next/no-img-element": "off",
    },
  },
  {
    // `_`-prefixed names are the codebase's marker for a deliberately unused
    // binding (destructuring rest-omits, placeholder callback params).
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Chrome extension scripts share one global scope: the manifest loads
    // several files into the same context, so a function declared in one file
    // and called from another looks unused to a per-file linter.
    files: ["src/chrome-extension/**"],
    languageOptions: {
      // Classic scripts (the manifest loads several into one context), not ES
      // modules — so their top-level declarations are globals, not module-local.
      sourceType: "script",
    },
    rules: {
      // A per-file linter can't see the cross-file uses, so every shared helper
      // would be reported as dead code.
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // Test code: partial mocks and fixtures are cast with `as any` on purpose,
    // since building fully-typed Prisma/Drive objects for each case adds noise
    // without adding safety.
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "testing/**/*.ts",
      "testing/**/*.tsx",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Playwright fixtures take a callback named `use`, which this rule mistakes
    // for the React `use` hook. Scoped to the Playwright suites only, so React
    // component tests keep the check.
    files: ["testing/**/*.ts", "testing/**/*.tsx"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
]);

export default eslintConfig;
