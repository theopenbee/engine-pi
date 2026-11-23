import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (name) => JSON.parse(readFileSync(join(root, name), "utf8"));

test("manifest describes the pi engine", () => {
  assert.deepEqual(readJson("openbee.plugin.json"), {
    protocol_version: 1,
    type: "engine",
    id: "pi",
    name: { en: "Pi", zh: "Pi" },
    description: { en: "Runs tasks with the pi coding agent", zh: "用 pi 编程助手执行任务" },
    command: ["node", "dist/index.js"],
    icon: "icon.svg",
    config: [
      {
        key: "path",
        type: "string",
        label: { en: "pi path", zh: "pi 路径" },
        help: { en: "Leave empty to use pi on PATH", zh: "留空则使用 PATH 里的 pi" },
      },
    ],
  });
});

test("package.json publishes dist, assets and the manifest", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.name, "@theopenbee/engine-pi");
  assert.equal(pkg.version, "0.2.0");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.deepEqual(pkg.files, ["dist", "assets", "icon.svg", "openbee.plugin.json"]);
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.scripts.prepare, "npm run build");
  assert.equal(pkg.dependencies["@theopenbee/engine-sdk"], "^0.2.0");
  assert.deepEqual(pkg.publishConfig, { access: "public", registry: "https://registry.npmjs.org/" });
});

test("the MCP extension asset registers the openbee MCP server", () => {
  const extension = readFileSync(join(root, "assets", "openbee-mcp.js"), "utf8");
  assert.ok(extension.includes("registerMcpServer"));
  assert.ok(extension.includes("OPENBEE_MCP_URL"));
  assert.ok(extension.includes("OPENBEE_API_KEY"));
});

test("the icon is a one-colour SVG", () => {
  const icon = readFileSync(join(root, "icon.svg"), "utf8");
  assert.match(icon, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(icon, /currentColor/);
  assert.ok(icon.length <= 32 * 1024);
});

test("the build output exists", () => {
  assert.ok(existsSync(join(root, "dist", "index.js")));
  assert.ok(existsSync(join(root, "dist", "pi.js")));
});
