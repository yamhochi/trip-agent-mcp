import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The export folder: $TRIP_AGENT_DIR, or Documents/trip-agent in the home folder. */
export function exportFolder(): string {
  return process.env.TRIP_AGENT_DIR || join(homedir(), "Documents", "trip-agent");
}

/** Built by the server alone from the trip name and start date; the model never supplies a path. */
export function tripFilename(name: string, startDate: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `${slug || "trip"}-${startDate}.ics`;
}

/** Where a trip's calendar file lives, whether or not it has been written yet. */
export function tripFilePath(name: string, startDate: string): string {
  return join(exportFolder(), tripFilename(name, startDate));
}

export async function writeTripFile(name: string, startDate: string, content: string): Promise<string> {
  await mkdir(exportFolder(), { recursive: true });
  const path = tripFilePath(name, startDate);
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, content, "utf8");
  await rename(temp, path);
  return path;
}
