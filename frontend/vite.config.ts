import { defineConfig } from "vite";

// In dev, Vite proxies /stream to the bridge so the frontend uses the same relative URL as behind nginx.
export default defineConfig({
  server: {
    proxy: {
      "/stream": "http://127.0.0.1:8787",
    },
  },
});
