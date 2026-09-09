// vitest.config.js — the console's smoke tests. Server-rendered, no browser:
// each test renders a component to a string and asserts on the words a
// person would see. Enough to catch a component that throws on the data
// the broker actually sends.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@shared": resolve(__dirname, "../shared") } },
  test: { include: ["src/__tests__/**/*.test.jsx"], environment: "node" },
});
