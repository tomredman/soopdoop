// ABOUTME: Lints the Convex functions with the Convex ESLint plugin's rules (https://docs.convex.dev/eslint).
// ABOUTME: Type-aware, because explicit-table-ids reads Id<"table"> types; without type info that rule does nothing.
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import convexPlugin from "@convex-dev/eslint-plugin";

export default defineConfig([
  globalIgnores(["convex/_generated/**"]),
  {
    files: ["convex/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // Functions and tests have separate tsconfigs; together they cover every file in convex/.
        project: ["./convex/tsconfig.json", "./convex/tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...convexPlugin.configs.recommended,
  {
    files: ["convex/**/*.ts"],
    rules: {
      // Off in the plugin's recommended set. On here because AGENTS.md says every public function is session-authenticated.
      "@convex-dev/require-access-control": "error",
      // Off in the recommended set. Nothing uses "use node" yet, so it costs nothing and guards the first file that does.
      "@convex-dev/import-wrong-runtime": "error",
      // no-collect-in-query stays off: every .collect() here reads one hacker's friends, machines, or open knocks.
    },
  },
]);
