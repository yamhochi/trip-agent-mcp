import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
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
  const filename = tripFilename(name, startDate);
  const path = join(folder, filename);
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
