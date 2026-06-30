import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" makes the built asset paths relative, so the dist works whether
// it's served from a domain root, a subpath, or copied into the broker.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist" },
});
