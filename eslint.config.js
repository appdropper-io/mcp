import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      // On a stdio MCP server stdout is the protocol. Diagnostics use log()
      // (stderr); stdio-guard.ts is the one place allowed to touch console.
      "no-console": ["error", { allow: ["error"] }],
      "no-restricted-properties": [
        "error",
        { object: "process", property: "stdout", message: "stdout carries MCP protocol messages only. Use log() from ./log.js." },
      ],
    },
  },
  {
    files: ["src/stdio-guard.ts"],
    rules: { "no-console": "off", "no-restricted-properties": "off" },
  },
  {
    files: ["test/**/*.js", "scripts/**/*.mjs", "eslint.config.js"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Buffer: "readonly",
        AbortController: "readonly",
      },
    },
  }
);
