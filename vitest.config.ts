import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          root: "packages/core",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          globals: true,
          environment: "node",
        },
        resolve: {
          alias: { "@": path.resolve(__dirname, "packages/core/src") },
        },
      },
    ],
  },
});
