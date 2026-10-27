import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  target: "node20",
  splitting: true, // keeps the TUI (react/ink) in a lazily-imported chunk so `clamux hook` starts fast
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
