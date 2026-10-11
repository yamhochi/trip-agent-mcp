import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMcpConfigForManifest } from "@anthropic-ai/mcpb";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { oneFlightTrip } from "./samples.js";
import { startServer, textOf } from "./harness.js";

const root = join(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "trip-agent-mcpb-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const manifestPath = join(root, "manifest.json");
const manifest = () => JSON.parse(readFileSync(manifestPath, "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const mcpb = join(root, "node_modules", ".bin", "mcpb");

describe("the extension manifest", () => {
  it("validates against the format's own rules, using its command-line tool", () => {
    const out = execFileSync(mcpb, ["validate", manifestPath], { encoding: "utf8" });
    expect(out).toMatch(/valid/i);
  });

  it("names the server, its version (the package's own), its licence and its author", () => {
    const m = manifest();
    expect(m.name).toBe("trip-agent-mcp");
    expect(m.version).toBe(pkg.version);
    expect(m.license).toBe("MIT");
    expect(m.author.name).toBeTruthy();
    expect(m.server.type).toBe("node");
    expect(existsSync(join(root, m.server.entry_point)), m.server.entry_point).toBe(true);
  });

  it("runs on macOS and Windows with the Node the package needs, and lists the four tools", () => {
    const m = manifest();
    expect(m.compatibility.platforms.sort()).toEqual(["darwin", "win32"]);
    expect(m.compatibility.runtimes.node).toBe(pkg.engines.node);
    expect(m.tools.map((t: { name: string }) => t.name).sort()).toEqual(["check_trip", "export_trip", "get_trip_file_info", "open_trip_file"]);
  });

  it("offers the export folder as an optional folder setting, and passes it to the server as TRIP_AGENT_DIR", () => {
    const m = manifest();
    expect(m.user_config.export_folder).toMatchObject({ type: "directory", required: false });
    expect(m.user_config.export_folder.title).toMatch(/export folder/i);
    expect(m.user_config.export_folder.description).toMatch(/Documents.*trip-agent|blank/i);
    expect(m.server.mcp_config.env).toEqual({ TRIP_AGENT_DIR: "${user_config.export_folder}" });
    expect(m.server.mcp_config.args).toEqual(["${__dirname}/dist/index.js"]);
  });
});

/** Build the bundle the way a release does, and unpack it where no source or tests exist. */
let built: { bundle: string; unpacked: string } | undefined;
function buildBundle(ctx: { skip: () => never }) {
  if (built) return built;
  const bundle = join(scratch, "trip-agent-mcp.mcpb");
  try {
    execFileSync("node", ["scripts/build-mcpb.mjs", "--out", bundle], { cwd: root, encoding: "utf8", stdio: "pipe", timeout: 240_000, env: { ...process.env, npm_config_cache: join(scratch, "npm-cache") } });
  } catch (err) {
    // The bundle's dependencies come from the registry. Locally, a machine that cannot reach it has nothing to build; in CI that failure is real.
    const text = String((err as { stderr?: string }).stderr ?? err);
    if (!process.env.CI && /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/.test(text)) ctx.skip();
    throw err;
  }
  const unpacked = join(scratch, "unpacked");
  mkdirSync(unpacked, { recursive: true });
  execFileSync(mcpb, ["unpack", bundle, unpacked], { encoding: "utf8", stdio: "pipe" });
  return (built = { bundle, unpacked });
}

describe("the built bundle", () => {
  it("is built from the repository with the format's tooling", (ctx) => {
    const { bundle } = buildBundle(ctx);
    expect(statSync(bundle).size).toBeGreaterThan(10_000);
  }, 240_000);

  it("holds the whole server: the manifest, the build output, the dependencies and the licence", (ctx) => {
    const { unpacked } = buildBundle(ctx);
    for (const path of ["manifest.json", "dist/index.js", "dist/server.js", "LICENSE", "node_modules/@modelcontextprotocol/sdk/package.json", "node_modules/zod/package.json"]) {
      expect(existsSync(join(unpacked, path)), path).toBe(true);
    }
  }, 240_000);

  it("holds no source, tests, docs, workflows or development tools", (ctx) => {
    const { unpacked } = buildBundle(ctx);
    const top = readdirSync(unpacked).sort();
    for (const unwanted of ["src", "test", "docs", "scripts", ".github", "AGENTS.md", "CONTEXT.md", "tsconfig.json", ".git"]) expect(top, unwanted).not.toContain(unwanted);
    for (const devOnly of ["typescript", "vitest", "@anthropic-ai"]) expect(existsSync(join(unpacked, "node_modules", devOnly)), devOnly).toBe(false);
  }, 240_000);

  it("carries the same manifest as the repository", (ctx) => {
    const { unpacked } = buildBundle(ctx);
    expect(JSON.parse(readFileSync(join(unpacked, "manifest.json"), "utf8"))).toEqual(manifest());
  }, 240_000);

  /** Start the unpacked server exactly as Claude Desktop would: the manifest's command, with the format's own variable substitution. */
  async function startFromBundle(ctx: { skip: () => never }, userConfig: Record<string, string>, home: string) {
    const { unpacked } = buildBundle(ctx);
    const m = JSON.parse(readFileSync(join(unpacked, "manifest.json"), "utf8"));
    const config = await getMcpConfigForManifest({
      manifest: m,
      extensionPath: unpacked,
      systemDirs: { HOME: home },
      userConfig,
      pathSeparator: "/",
    });
    expect(config, "the manifest produces a server configuration").toBeDefined();
    const client = new Client({ name: "mcpb-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: config!.args!,
        cwd: scratch,
        env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, ...config!.env },
      }),
    );
    return client;
  }

  it("starts from the unpacked bundle and receives the export folder the traveller chose", async (ctx) => {
    const home = join(scratch, "home-chosen");
    const chosen = join(scratch, "my calendar files");
    mkdirSync(home, { recursive: true });
    const client = await startFromBundle(ctx, { export_folder: chosen }, home);
    try {
      const result = await client.callTool({ name: "export_trip", arguments: { trip: oneFlightTrip } });
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(readdirSync(chosen).filter((f) => f.endsWith(".ics"))).toEqual(["sample-japan-trip-2026-12-01.ics"]);
      expect(existsSync(join(home, "Documents", "trip-agent"))).toBe(false);
    } finally {
      await client.close();
    }
  }, 60_000);

  it("uses Documents/trip-agent when the traveller leaves the setting blank, and never makes a folder named after the placeholder", async (ctx) => {
    const home = join(scratch, "home-blank");
    mkdirSync(home, { recursive: true });
    const client = await startFromBundle(ctx, {}, home);
    try {
      const result = await client.callTool({ name: "export_trip", arguments: { trip: oneFlightTrip } });
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(readdirSync(join(home, "Documents", "trip-agent")).filter((f) => f.endsWith(".ics"))).toHaveLength(1);
      expect(existsSync(join(scratch, "${user_config.export_folder}"))).toBe(false);
    } finally {
      await client.close();
    }
  }, 60_000);
});

describe("an export folder that the host did not fill in", () => {
  it("is ignored, so a placeholder left as it was is never used as a folder name", async () => {
    const home = join(scratch, "home-placeholder");
    mkdirSync(home, { recursive: true });
    const server = await startServer({ TRIP_AGENT_DIR: "${user_config.export_folder}" }, home);
    try {
      const result = await server.client.callTool({ name: "export_trip", arguments: { trip: oneFlightTrip } });
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(textOf(result)).toContain(join(home, "Documents", "trip-agent"));
    } finally {
      await server.close();
    }
  });
});

describe("the release workflow and the bundle", () => {
  const text = () => readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");

  it("builds the bundle after the checks pass, and attaches it to the release on a version tag", () => {
    const t = text();
    expect(t).toMatch(/npm run build:mcpb/);
    expect(t.indexOf("npm test")).toBeLessThan(t.indexOf("npm run build:mcpb"));
    expect(t).toMatch(/gh release (create|upload)/);
    expect(t).toMatch(/\.mcpb/);
  });

  it("gives only the bundle job the right to write to the release", () => {
    const t = text();
    expect(t.match(/contents: write/g) ?? []).toHaveLength(1);
    const bundleJob = t.slice(t.indexOf("\n  bundle:"));
    expect(bundleJob).toMatch(/contents: write/);
    expect(bundleJob).toMatch(/startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  });

  it("keeps the bundle as a downloadable build artifact when started by hand", () => {
    expect(text()).toMatch(/actions\/upload-artifact@/);
  });
});
