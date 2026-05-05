import { defineConfig } from "tsup";

// Single-entry build. cli.ts → dist/cli.js, with a shebang banner so the
// resulting file is directly executable from PATH (npm/bun set the
// executable bit when "bin" is in package.json).
//
// External: leave runtime deps unbundled. We're shipped via npm so users
// already have @solana/web3.js etc. installed alongside us — bundling
// would double the install size and risk dual-instance bugs.
export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  target: "node18",
  platform: "node",
  sourcemap: true,
  clean: true,
  splitting: false,
  banner: { js: "#!/usr/bin/env node" },
});
