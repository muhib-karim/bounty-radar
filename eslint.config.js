// ESLint flat config. Linting is the only thing the devDependencies are for:
// the scripts themselves stay dependency-free.
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "worker/node_modules/", "**/.wrangler/", "site/"] },

  js.configs.recommended,

  {
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // `x == null` / `x != null` is used on purpose throughout to cover null and undefined.
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      "no-throw-literal": "error",
      "no-self-compare": "error",
      "no-template-curly-in-string": "error",
      "no-unused-vars": ["error", { args: "after-used", caughtErrors: "all" }],
    },
  },

  // Node scripts, tests and this file.
  {
    files: ["*.mjs", "*.js", "test/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },

  // The Worker runs on Cloudflare's runtime, not Node: only web-standard
  // globals, so an accidental `process` or `Buffer` is an error here.
  {
    files: ["worker/src/**/*.js"],
    languageOptions: {
      globals: {
        AbortController: "readonly",
        AbortSignal: "readonly",
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        crypto: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
      },
    },
  },
];
