import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3000", "/webhooks": "http://localhost:3000" },
  },
  test: {
    root: ".",
    include: ["tests/**/*.test.ts"],
    env: { ANTHROPIC_API_KEY: "", TWILIO_DRY_RUN: "true", TWILIO_AUTH_TOKEN: "", DATABASE_URL: "" },
    testTimeout: 30_000,
  },
} as never);
