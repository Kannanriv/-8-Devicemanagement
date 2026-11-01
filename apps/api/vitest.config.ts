import { defineConfig } from "vitest/config";

// PGlite migrations take several seconds on a loaded dev machine.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
