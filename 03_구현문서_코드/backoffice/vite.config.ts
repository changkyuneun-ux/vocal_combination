import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8080", rewrite: (p) => p.replace(/^\/api/, "") },
    },
  },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
