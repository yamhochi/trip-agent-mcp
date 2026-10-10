import { execFile } from "node:child_process";

/** The command that hands a file to the platform's default application. */
function openerFor(file: string): [string, string[]] {
  if (process.platform === "darwin") return ["open", [file]];
  if (process.platform === "win32") return ["cmd", ["/c", "start", "", file]];
  return ["xdg-open", [file]];
}

/** A Linux machine with no display (an SSH session, a container) has no calendar app to open. */
function noDisplay(): boolean {
  return process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

export function openFile(file: string): Promise<void> {
  if (noDisplay()) return Promise.reject(new Error("no display available"));
  const [command, args] = openerFor(file);
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15_000 }, (err) => (err ? reject(err) : resolve()));
  });
}
