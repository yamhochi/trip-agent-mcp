/** Offset in minutes of `timeZone` from UTC at the given instant, plus its short name. */
export function zoneAt(instant: number, timeZone: string): { offset: number; name: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    timeZoneName: "short",
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const asUtc = Date.UTC(+get("year"), +get("month") - 1, +get("day"), +get("hour"), +get("minute"), +get("second"));
  return { offset: Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60000), name: get("timeZoneName") };
}

export function wallClockAsUtc(localTime: string): number {
  const [d, t] = localTime.split("T");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  return Date.UTC(y, mo - 1, da, h, mi);
}

/** The real moment a wall-clock time in a named zone happens, as milliseconds since the epoch, so times in different zones can be ordered. */
export function instantOf(localTime: string, timeZone: string): number {
  const wall = wallClockAsUtc(localTime);
  const guess = zoneAt(wall, timeZone).offset;
  const { offset } = zoneAt(wall - guess * 60000, timeZone);
  return wall - offset * 60000;
}
