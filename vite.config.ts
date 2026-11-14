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
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("motion") || id.includes("framer-motion")) {
            return "vendor-motion";
          }
          if (
            id.includes("@heroui") ||
            id.includes("@react-aria") ||
            id.includes("@react-stately") ||
            id.includes("react-aria") ||
            id.includes("@internationalized")
          ) {
            return "vendor-heroui";
          }
          if (id.includes("lucide-react")) {
            return "vendor-icons";
          }
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/scheduler/")
          ) {
            return "vendor-react";
          }
        },
      },
    },
  },
});
