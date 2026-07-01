import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { resolve } from "path";

// base "./" makes the built asset paths relative, so the dist works whether
// it's served from a domain root, a subpath, or copied into the broker.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { 
    outDir: "dist",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        dashboard: resolve(__dirname, "dashboard.html"),
        settings: resolve(__dirname, "settings.html"),
      },
    },
  },
});
