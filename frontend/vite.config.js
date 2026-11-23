import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` proxies /api (including the terminal WebSockets) to the backend on :8022.
// `npm run build` writes straight into backend/static, which FastAPI serves.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": { target: "http://127.0.0.1:8022", ws: true } } },
  build: { outDir: "../backend/static", emptyOutDir: true, chunkSizeWarningLimit: 1000, target: "es2022" },
});
