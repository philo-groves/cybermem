import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url);
const rootPath = fileURLToPath(root);

test("package exposes explicit Pi resources", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(pkg.type, "module");
  assert.ok(pkg.keywords.includes("pi-package"));
  assert.deepEqual(pkg.pi.extensions, ["./extensions/index.js"]);
  assert.deepEqual(pkg.pi.skills, ["./skills"]);
  assert.deepEqual(pkg.pi.prompts, ["./prompts"]);
  assert.equal(pkg.peerDependencies["@earendil-works/pi-coding-agent"], "*");
});

test("docs state provenance and integration caveats", async () => {
  const readme = await readFile(join(rootPath, "README.md"), "utf8");
  assert.match(readme, /Crystalline itself is closed source/);
  assert.match(readme, /pi-sub-agent/);
  assert.match(readme, /CYBERMEM_HOME/);
});
