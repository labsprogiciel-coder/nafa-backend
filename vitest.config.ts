import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // convex-test runs functions in the edge runtime Convex uses
    environmentMatchGlobs: [["tests/convex/**", "edge-runtime"]],
    server: { deps: { inline: ["convex-test"] } },
  },
});
