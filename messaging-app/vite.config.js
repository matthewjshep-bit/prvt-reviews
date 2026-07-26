import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { resolve } from "path";

// base "./" makes the built asset paths relative, so the dist works whether
// it's served from a domain root, a subpath, or copied into the broker.
export default defineConfig({
  plugins: [react()],
  base: "./",
  // The app imports the shared offer calculator from ../shared. Alias it and
  // let Vite's dev server read the repo root.
  resolve: {
    alias: { "@shared": resolve(__dirname, "../shared") },
  },
  server: {
    fs: { allow: [resolve(__dirname, ".."), __dirname] },
  },
  build: {
    outDir: "dist",
  },
});
