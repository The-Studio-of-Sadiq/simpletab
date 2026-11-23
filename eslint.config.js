// Architecture rules for SimpleTab (design section 2): @simpletab/core must run unchanged in
// Electron, Cloudflare Workers and browsers, so its source may not import Node, React, Electron,
// Next.js or Firebase, and may not read browser globals. Test files may use Node.
import tseslint from "typescript-eslint";

const BROWSER_GLOBALS = ["window", "document", "navigator", "localStorage", "sessionStorage", "indexedDB", "location"];

export default tseslint.config(
  // Build output lives in packages/*/lib; core's own source folder src/lib must stay linted.
  { ignores: ["**/node_modules/**", "**/dist/**", "packages/*/lib/**", "**/src-gen/**", "docs/**"] },
  {
    files: ["packages/core/src/**/*.ts"],
    ignores: ["**/*.test.ts", "packages/core/src/test/**"],
    languageOptions: { parser: tseslint.parser },
    rules: {
      "no-restricted-imports": ["error", {
        // Bare Node built-ins are matched by exact name ("paths"), so core's own folders that
        // share a name, such as "@/crypto/keys", are not caught by mistake.
        paths: ["fs", "path", "crypto", "os", "child_process", "worker_threads", "stream", "buffer"].map((name) => ({
          name,
          message: "@simpletab/core must not use Node APIs.",
        })),
        patterns: [
          { group: ["node:*"], message: "@simpletab/core must not use Node APIs." },
          { group: ["react", "react-dom", "react/*"], message: "UI code belongs in tab-ui or the apps, not core." },
          { group: ["electron", "next", "next/*", "firebase", "firebase/*", "firebase-admin", "firebase-admin/*"], message: "Not allowed in @simpletab/core." },
        ],
      }],
      // CrabbyTab code already disables this rule where it means to match control characters.
      "no-control-regex": "error",
      "no-restricted-globals": ["error", ...BROWSER_GLOBALS.map((name) => ({
        name,
        message: "@simpletab/core must not read browser globals; pass the value in instead.",
      }))],
    },
  },
);
