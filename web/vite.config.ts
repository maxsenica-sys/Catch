import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  plugins: [preact()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: { main: `${root}index.html`, sw: `${root}src/sw.ts` },
      output: {
        // The service worker must live at a fixed URL at the root to control the whole app.
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
      },
    },
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8787", "/feeds": "http://localhost:8787" },
  },
});
