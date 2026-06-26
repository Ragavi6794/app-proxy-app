import { defineConfig } from "vitest/config";

// Standalone Vitest config — intentionally does NOT load vite.config.js,
// because the @react-router/dev Vite plugin expects the full app-server
// environment and is irrelevant for unit-testing the proxy route modules.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["app/**/*.{test,spec}.{js,jsx}"],
    clearMocks: true,
  },
});
