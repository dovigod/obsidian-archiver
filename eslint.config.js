import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config([
  {
    ignores: ["dist/**", "node_modules/**", "test_result/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Always require braces around control flow bodies.
      curly: ["error", "all"],
      // Match the project's import-style: ignore underscore-prefixed unused.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
]);
