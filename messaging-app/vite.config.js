import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { resolve } from "path";

// base "/" (absolute asset paths) so the SPA also works from sub-paths like
// /agents — with relative paths, /agents would look for /agents/assets/* and
// hit the SPA redirect instead of the real files.
export default defineConfig({
  plugins: [react()],
  base: "/",
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
