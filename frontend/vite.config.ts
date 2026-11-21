import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset URLs, so one build can be served at the site root or under a path.
  base: "./",
  server: {
    // Serve files from this workspace only (resolved against Vite's root, frontend/; Vite adds its
    // own client). The default, the whole npm workspace, lets /@fs/ reach bridge/mix.json: Vite's
    // deny list covers .env files but not the private recipe.
    fs: {
      allow: ["."],
    },
    // In dev, Vite proxies /stream to the bridge so the frontend uses the same relative URL as behind nginx.
    proxy: {
      "/stream": "http://127.0.0.1:8787",
    },
  },
});
