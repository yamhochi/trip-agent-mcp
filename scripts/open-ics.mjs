#!/usr/bin/env node
// Open an exported trip calendar in the system's default calendar app.
// Usage: node scripts/open-ics.mjs <filename.ics> [--dry-run]
// Takes a filename only, never a path, like the export tool (design item 9).
// The folder is $TRIP_AGENT_DIR, or ~/Documents/trip-agent/ by default.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const name = args.find((a) => !a.startsWith("--"));

if (!name || !/^[A-Za-z0-9][A-Za-z0-9._ -]*\.ics$/.test(name) || name.includes("..")) {
  console.error("Give a file name like 'japan-dec-2026.ics' (letters, digits, . _ - and spaces; no paths).");
  process.exit(2);
}

const folder = process.env.TRIP_AGENT_DIR || join(homedir(), "Documents", "trip-agent");
const file = join(folder, name);

if (!existsSync(file)) {
  console.error(`Not found: ${file}`);
  process.exit(1);
}

const [cmd, cmdArgs] =
  process.platform === "darwin" ? ["open", [file]]
  : process.platform === "win32" ? ["cmd", ["/c", "start", "", file]]
  : ["xdg-open", [file]];

if (dryRun) {
  console.log([cmd, ...cmdArgs].join(" "));
  process.exit(0);
}

execFile(cmd, cmdArgs, (err) => {
  if (err) {
    console.error(`Could not open ${file}: ${err.message}`);
    process.exit(1);
  }
  console.log(`Opened ${file}`);
});
