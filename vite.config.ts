import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:3001" },
  },
  build: {
    rollupOptions: {
      output: {
        // Stable library chunks can stay cached when application code changes.
        // Explicit ownership also keeps runtime helpers out of the app entry.
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          const path = id.replaceAll("\\", "/");
          if (path.includes("commonjsHelpers.js")) return "react-runtime";
          if (!path.includes("/node_modules/")) return undefined;
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(path))
            return "react-runtime";
          if (path.includes("/node_modules/lucide-react/")) return "icons";
          if (path.includes("/node_modules/zod/")) return "validation";
          // The remaining third-party modules currently implement Markdown/GFM.
          return "content-vendor";
        },
      },
    },
  },
});
