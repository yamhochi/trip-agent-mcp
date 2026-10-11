import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

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

const MAX_READ_BYTES = 5_000_000;

/** The file this server last exported for a trip, or nothing when there is none (or it cannot be read). */
export async function readTripFile(name: string, startDate: string): Promise<string | undefined> {
  try {
    const path = tripFilePath(name, startDate);
    // A calendar file for one trip is small; refuse to read anything much larger.
    if ((await stat(path)).size > MAX_READ_BYTES) return undefined;
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export interface WrittenTripFile {
  path: string;
  /** Other files in the folder for the same trip name but a different start date. */
  similar: string[];
}

function tripSlug(filename: string, startDate: string): string {
  return filename.slice(0, -`-${startDate}.ics`.length);
}

async function findSimilar(folder: string, filename: string, startDate: string): Promise<string[]> {
  const slug = tripSlug(filename, startDate);
  const pattern = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{4}-\\d{2}-\\d{2}\\.ics$`);
  try {
    const names = await readdir(folder);
    return names.filter((n) => n !== filename && pattern.test(n)).sort();
  } catch {
    return []; // advisory only: never fail an export that already succeeded
  }
}

/**
 * Writes to a temporary file in the same folder and renames it over the real one, so an
 * interrupted write leaves the old file or the new one. The previous version is kept as
 * one backup (`<file>.bak`). With two writers at once, the later rename wins.
 */
export async function writeTripFile(name: string, startDate: string, content: string): Promise<WrittenTripFile> {
  const folder = exportFolder();
  await mkdir(folder, { recursive: true });
  const path = tripFilePath(name, startDate);
  const filename = basename(path);
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(temp, content, "utf8");
    try {
      await copyFile(path, `${temp}.bak`);
      await rename(`${temp}.bak`, `${path}.bak`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    await rm(`${temp}.bak`, { force: true });
    throw err;
  }
  return { path, similar: await findSimilar(folder, filename, startDate) };
}
