import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests for the Electron main-process logic (security-critical helpers).
// The renderer is excluded — these tests target pure/mockable main modules.
export default defineConfig({
  // The vendored shared code, same alias as vite.config.ts — tests import it as well.
  resolve: {
    alias: { "@praimana/shared": path.resolve(__dirname, "shared/index.ts") },
  },
  
  test: {
    /**
     * ⚠ `shared/` IS INCLUDED, and it was not at first. With only `src/**` the six vendored test files were
     * collected by NOTHING — they sat in the repo looking like coverage while never running, which is worse
     * than not having them. It also hid a test that could not work here at all (a chat-limits drift check
     * that read a backend route file in another repo); it was removed rather than repaired,
     * because a cross-repo assertion has no meaning in a self-contained repo.
     */
    include: ["src/**/*.test.ts", "shared/**/*.test.ts"],
    environment: "node",
  },
});
