import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "ukibori-dom": resolve("../ukibori-dom/src/index.ts"),
      "ukibori-renderer": resolve("../renderer/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
  },
});
