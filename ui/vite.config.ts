/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const GW = process.env.UI_PROXY_TARGET || "http://gateway-dev:8080";

export default defineConfig({
  plugins: [react()],
  base: "/",
  server: {
    host: true,
    port: 5173,
    allowedHosts: ["ui-dev", "gateway-dev", "127.0.0.1", "localhost"],
    proxy: {
      "/api": GW,
      "/v1": GW,
      "/health": GW,
      "/ws": { target: GW, ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  test: {
    globals: true,
    environment: "node",
  },
});