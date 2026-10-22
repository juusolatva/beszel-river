import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset URLs, so one build can be served at the site root or under a path.
  base: "./",
  // In dev, Vite proxies /stream to the bridge so the frontend uses the same relative URL as behind nginx.
  server: {
    proxy: {
      "/stream": "http://127.0.0.1:8787",
    },
  },
});
