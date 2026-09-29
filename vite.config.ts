import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Two pages: the app, and the tiny page Entra ID redirects back to after sign-in (MSAL's redirect bridge).
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: { input: { main: "index.html", redirect: "redirect.html" } },
  },
  server: { port: 5173, strictPort: true },
  test: { environment: "node" },
});
