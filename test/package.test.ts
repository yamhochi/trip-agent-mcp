import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { startServer } from "./harness.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "trip-agent-package-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** What `npm pack` would put in the tarball. --ignore-scripts keeps it from rebuilding dist while other tests are using it. */
let packedList: string[] | undefined;
function packedFiles(): string[] {
  const out = packedList ? "" : execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
  packedList ??= (JSON.parse(out)[0].files as { path: string }[]).map((f) => f.path).sort();
  return packedList;
}

/** The files npm always includes besides the build output. */
const ALWAYS_PACKED = ["package.json", "LICENSE", "README.md"];

/** npm's own cache and config for these runs live in the scratch folder, so a test never touches the real ones. */
const isolatedNpm = () => ({
  ...process.env,
  npm_config_cache: join(scratch, "npm-cache"),
  npm_config_update_notifier: "false",
});

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("the packed package", () => {
  it("contains the built server, the licence and the readme", () => {
    const files = packedFiles();
    for (const name of ALWAYS_PACKED) expect(files).toContain(name);
    expect(files).toContain("dist/index.js");
    expect(files).toContain("dist/server.js");
  });

  it("contains only what is needed to run: the build output, the licence, the readme and the manifest", () => {
    const allowed = (path: string) => ALWAYS_PACKED.includes(path) || (path.startsWith("dist/") && /\.js$/.test(path));
    expect(packedFiles().filter((p) => !allowed(p))).toEqual([]);
  });

  it("leaves out the source, the tests, the docs, the scripts and the workflows", () => {
    const files = packedFiles();
    for (const unwanted of ["src/", "test/", "docs/", "scripts/", ".github/", "AGENTS.md", "CONTEXT.md", "tsconfig"]) {
      expect(files.filter((p) => p.startsWith(unwanted) || p.includes(unwanted)), unwanted).toEqual([]);
    }
    expect(files.filter((p) => /\.test\./.test(p))).toEqual([]);
  });

  it("is named trip-agent-mcp, under the MIT licence, with a bin that starts the server", () => {
    expect(manifest.name).toBe("trip-agent-mcp");
    expect(manifest.license).toBe("MIT");
    expect(manifest.bin).toEqual({ "trip-agent-mcp": "dist/index.js" });
    expect(readFileSync(join(root, "dist", "index.js"), "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
    expect(readFileSync(join(root, "LICENSE"), "utf8")).toMatch(/MIT License/);
  });

  it("says where it lives and which Node it needs, and rebuilds before it is packed", () => {
    expect(manifest.repository?.url).toMatch(/github\.com\/yamhochi\/trip-agent-mcp/);
    expect(manifest.engines.node).toBeTruthy();
    expect(manifest.scripts.prepack).toMatch(/build/);
  });

  it("installs from the tarball on a clean project and starts over standard input and output through npx", async (ctx) => {
    const packDir = join(scratch, "pack");
    mkdirSync(packDir, { recursive: true });
    const packed = execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir, "--json"], { cwd: root, encoding: "utf8", env: isolatedNpm() });
    const tarball = join(packDir, JSON.parse(packed)[0].filename);
    expect(existsSync(tarball)).toBe(true);

    const project = join(scratch, "clean-project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "clean-project", version: "1.0.0", private: true }));
    try {
      execFileSync("npm", ["install", tarball, "--no-audit", "--no-fund", "--loglevel=error"], { cwd: project, encoding: "utf8", stdio: "pipe", timeout: 120_000, env: isolatedNpm() });
    } catch (err) {
      // The tarball's own dependencies come from the registry. A machine that cannot reach it has nothing to start, so
      // locally the test is skipped; in CI (where the registry must be reachable) the failure is real and stays one.
      const text = String((err as { stderr?: string }).stderr ?? err);
      if (!process.env.CI && /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/.test(text)) return ctx.skip();
      throw err;
    }

    const home = join(scratch, "home");
    mkdirSync(home, { recursive: true });
    const client = new Client({ name: "package-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: "npx",
        args: ["--no-install", "trip-agent-mcp"],
        cwd: project,
        env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, TRIP_AGENT_DIR: join(home, "out"), npm_config_cache: join(scratch, "npm-cache") },
      }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["check_trip", "export_trip", "get_trip_file_info", "open_trip_file"]);
      expect((client.getInstructions() ?? "").length).toBeGreaterThan(200);
    } finally {
      await client.close();
    }
    expect(statSync(join(project, "node_modules", "trip-agent-mcp", "dist", "index.js")).isFile()).toBe(true);
  }, 180_000);
});

describe("the readme, which npm shows as the package's front page", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");

  it("links to the repository's files by full address, because a relative link does not work on the npm page", () => {
    const relative = [...readme.matchAll(/\]\(([^)#\s]+)[^)]*\)/g)].map((m) => m[1]).filter((target) => !/^(https?:|mailto:)/.test(target));
    expect(relative).toEqual([]);
  });

  it("shows the exported trip in a calendar: an image with a description, stored in the repository and linked by full address, of a sensible size", () => {
    const image = readme.match(/!\[([^\]]+)\]\((https:\/\/raw\.githubusercontent\.com\/yamhochi\/trip-agent-mcp\/main\/(docs\/images\/[^)\s]+))\)/);
    expect(image, "an image linked by its raw GitHub address").not.toBeNull();
    expect(image![1].length).toBeGreaterThan(20);
    const file = join(root, image![3]);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBeLessThan(1_000_000);
    expect(readFileSync(file).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("gives example prompts to ask Claude: build and check a trip, fix a gap, export, update, and paste instead of an email connector", () => {
    const start = readme.indexOf("## Try it");
    expect(start).toBeGreaterThan(0);
    const section = readme.slice(start);
    for (const pattern of [/check the trip for gaps/i, /fix a gap|add that and check again/i, /export it/i, /update the calendar file/i, /paste/i]) expect(section).toMatch(pattern);
  });

  it("does not say which version is the current one, since the page would go stale with the next release", () => {
    const status = readme.split("\n").find((line) => line.startsWith("**Status"))!;
    expect(status).not.toMatch(/\d+\.\d+\.\d+/);
    expect(status).toMatch(/releases/i);
  });
});

describe("the version the server reports", () => {
  it("is the version in package.json, which is also the manifest's", async () => {
    const server = await startServer();
    try {
      expect(server.client.getServerVersion()).toMatchObject({ name: "trip-agent-mcp", version: manifest.version });
      expect(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).version).toBe(manifest.version);
    } finally {
      await server.close();
    }
  });
});

describe("the release workflow", () => {
  const workflowPath = join(root, ".github", "workflows", "release.yml");
  const workflow = () => readFileSync(workflowPath, "utf8");

  it("exists, and runs when a version tag is pushed or when started by hand", () => {
    expect(existsSync(workflowPath)).toBe(true);
    expect(workflow()).toMatch(/tags:\s*\n\s*- ["']?v\*/);
    expect(workflow()).toMatch(/workflow_dispatch:/);
  });

  it("builds, tests and dry-run publishes before anything is published", () => {
    const text = workflow();
    expect(text).toMatch(/npm ci/);
    expect(text).toMatch(/npm test/);
    expect(text).toMatch(/npm publish --dry-run/);
    expect(text.indexOf("npm test")).toBeLessThan(text.indexOf("npm publish --dry-run"));
  });

  it("checks that the tag matches the version in package.json", () => {
    expect(workflow()).toMatch(/GITHUB_REF_NAME/);
    expect(workflow()).toMatch(/package\.json/);
  });

  it("publishes for real only on a tag, only after the dry run, and only when the maintainer has switched it on", () => {
    const text = workflow();
    const publish = text.slice(text.indexOf("\n  publish:"));
    expect(text).toMatch(/needs:\s*\n?\s*-?\s*verify|needs: verify/);
    expect(publish).toMatch(/startsWith\(github\.ref, 'refs\/tags\/v'\)/);
    expect(publish).toMatch(/vars\.PUBLISH_TO_NPM == 'true'/);
    expect(text.match(/npm publish(?! --dry-run)/g) ?? []).toHaveLength(1);
    expect(text).toMatch(/\*-\*\) tag=next/);
  });

  it("publishes with npm's trusted publishing, so no token is stored: GitHub proves its identity and npm is told to trust it", () => {
    const publish = workflow().slice(workflow().indexOf("\n  publish:"));
    expect(publish).toMatch(/id-token: write/);
    expect(publish).toMatch(/npm install -g npm@latest/);
    expect(publish.indexOf("npm install -g npm@latest")).toBeLessThan(publish.indexOf("npm publish"));
    expect(workflow()).not.toMatch(/NPM_TOKEN/);
    expect(workflow()).not.toMatch(/NODE_AUTH_TOKEN/);
  });

  it("runs on a named Ubuntu version, not on ubuntu-latest, so a new runner image cannot change a release by surprise", () => {
    expect(workflow()).not.toMatch(/ubuntu-latest/);
    expect(workflow().match(/runs-on: ubuntu-24\.04/g) ?? []).toHaveLength(3);
  });

  it("never prints or commits a token", () => {
    expect(workflow()).not.toMatch(/npm_[A-Za-z0-9]{20,}/);
  });
});
