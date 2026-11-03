import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// Browser verification serves only static frontend code; every API request is intercepted.
// No production Worker or data-service credentials are loaded.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: "127.0.0.1", port: 5178, strictPort: true },
});
