import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the SPA in client/ into dist/client, which wrangler.jsonc serves as static assets.
export default defineConfig({
  root: "client",
  plugins: [react()],
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
});
