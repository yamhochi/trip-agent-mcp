import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "trip-agent-package-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** What `npm pack` would put in the tarball. --ignore-scripts keeps it from rebuilding dist while other tests are using it. */
function packedFiles(): string[] {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
  return (JSON.parse(out)[0].files as { path: string }[]).map((f) => f.path).sort();
}

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("the packed package", () => {
  it("contains the built server, the licence and the readme", () => {
    const files = packedFiles();
    expect(files).toContain("package.json");
    expect(files).toContain("LICENSE");
    expect(files).toContain("README.md");
    expect(files).toContain("dist/index.js");
    expect(files).toContain("dist/server.js");
  });

  it("contains only what is needed to run: the build output, the licence, the readme and the manifest", () => {
    const allowed = (path: string) => ["package.json", "LICENSE", "README.md"].includes(path) || (path.startsWith("dist/") && /\.js$/.test(path));
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
    execFileSync("mkdir", ["-p", packDir]);
    const packed = execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir, "--json"], { cwd: root, encoding: "utf8" });
    const tarball = join(packDir, JSON.parse(packed)[0].filename);
    expect(existsSync(tarball)).toBe(true);

    const project = join(scratch, "clean-project");
    execFileSync("mkdir", ["-p", project]);
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "clean-project", version: "1.0.0", private: true }));
    try {
      execFileSync("npm", ["install", tarball, "--no-audit", "--no-fund", "--loglevel=error"], { cwd: project, encoding: "utf8", stdio: "pipe", timeout: 120_000 });
    } catch (err) {
      // The tarball's own dependencies come from the registry; on a machine that cannot reach it there is nothing to start.
      const text = String((err as { stderr?: string }).stderr ?? err);
      if (/ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network|403|proxy|fetch failed/i.test(text)) return ctx.skip();
      throw err;
    }

    const home = join(scratch, "home");
    execFileSync("mkdir", ["-p", home]);
    const client = new Client({ name: "package-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: "npx",
        args: ["--no-install", "trip-agent-mcp"],
        cwd: project,
        env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, TRIP_AGENT_DIR: join(home, "out") },
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
    const publish = text.slice(text.lastIndexOf("npm publish") - 400);
    expect(text).toMatch(/needs:\s*\n?\s*-?\s*verify|needs: verify/);
    expect(publish).toMatch(/startsWith\(github\.ref, 'refs\/tags\/v'\)/);
    expect(publish).toMatch(/vars\.PUBLISH_TO_NPM == 'true'/);
    expect(text).toMatch(/NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    expect(text.match(/npm publish(?! --dry-run)/g) ?? []).toHaveLength(1);
  });

  it("never prints or commits a token", () => {
    expect(workflow()).not.toMatch(/npm_[A-Za-z0-9]{20,}/);
  });
});
