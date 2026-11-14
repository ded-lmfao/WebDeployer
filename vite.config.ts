import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const rawBase = process.env.VITE_BASE_PATH;
const base = rawBase
  ? rawBase.endsWith("/")
    ? rawBase
    : `${rawBase}/`
  : "./";

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
