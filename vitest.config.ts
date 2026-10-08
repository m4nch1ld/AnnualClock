import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "e2e/**", ".next/**"],
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
