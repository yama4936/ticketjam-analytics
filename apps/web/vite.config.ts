import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: "apps/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 4380,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:4381" },
  },
});
