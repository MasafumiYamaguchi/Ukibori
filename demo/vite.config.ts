import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      ukibori: resolve("../packages/ukibori/src/index.ts"),
      "ukibori-renderer": resolve("../packages/renderer/src/index.ts"),
      "ukibori-dom": resolve("../packages/ukibori-dom/src/index.ts"),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve("./index.html"),
        "renderer-debug": resolve("./renderer-debug.html"),
        "dom-debug": resolve("./dom-debug.html"),
      },
    },
  },
});
