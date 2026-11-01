import { defineConfig } from "vitest/config";

// Generated plugins are executed with real toolchains (python, javac/java), which is slow on cold start.
export default defineConfig({ test: { testTimeout: 120_000, hookTimeout: 240_000 } });
