#!/usr/bin/env node
// Packs the built server into a .mcpb bundle with the format's own command-line tool (@anthropic-ai/mcpb).
// Run `npm run build` first (the `build:mcpb` npm script does both). The bundle is staged in a temporary
// folder so that only what the server needs goes in: the manifest, the build output, the licence and the
// production dependencies, installed from the lockfile.
//
//   node scripts/build-mcpb.mjs [--out path/to/file.mcpb]
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`manifest.json says version ${manifest.version} but package.json says ${pkg.version}: make them match.`);
  process.exit(1);
}
if (!existsSync(join(root, "dist", "index.js"))) {
  console.error("dist/index.js is missing: run `npm run build` first.");
  process.exit(1);
}

const flag = process.argv.indexOf("--out");
const out = resolve(flag > 0 ? process.argv[flag + 1] : join(root, "build", `trip-agent-mcp-${pkg.version}.mcpb`));
mkdirSync(dirname(out), { recursive: true });

const stage = mkdtempSync(join(tmpdir(), "trip-agent-mcpb-stage-"));
try {
  for (const name of ["manifest.json", "package.json", "package-lock.json", "LICENSE", "README.md"]) cpSync(join(root, name), join(stage, name));
  cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: stage, stdio: "inherit" });
  execFileSync(join(root, "node_modules", ".bin", "mcpb"), ["pack", stage, out], { stdio: "inherit" });
} finally {
  rmSync(stage, { recursive: true, force: true });
}
console.log(`Built ${out}`);
