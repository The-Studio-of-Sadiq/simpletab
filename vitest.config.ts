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
      {
        test: {
          name: "host",
          root: "packages/host",
          include: ["src/**/*.test.ts"],
          globals: true,
          environment: "node",
        },
        resolve: {
          alias: {
            "@": path.resolve(__dirname, "packages/core/src"),
            "@simpletab/core": path.resolve(__dirname, "packages/core/src"),
          },
        },
      },
      {
        test: {
          name: "tabbycat-diff",
          root: "tools/tabbycat-diff",
          include: ["**/*.test.ts"],
          globals: true,
          environment: "node",
        },
        resolve: {
          alias: { "@": path.resolve(__dirname, "packages/core/src") },
        },
      },
      {
        test: {
          name: "tab-ui",
          root: "packages/tab-ui",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
          globals: true,
          environment: "jsdom",
        },
        resolve: {
          alias: {
            "@": path.resolve(__dirname, "packages/core/src"),
            "@simpletab/core": path.resolve(__dirname, "packages/core/src"),
            "@simpletab/host/lib/common": path.resolve(__dirname, "packages/host/src/common"),
            "@theia/core/shared/react": path.resolve(__dirname, "node_modules/react"),
            "@theia/core/shared/react-dom": path.resolve(__dirname, "node_modules/react-dom"),
          },
        },
      },
    ],
  },
});
