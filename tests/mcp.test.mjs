import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootPath = fileURLToPath(new URL("..", import.meta.url));
const serverPath = join(rootPath, "mcp", "server.js");

async function tempProject() {
  return mkdtemp(join(tmpdir(), "cybermem-mcp-test-"));
}

test("MCP sidecar supports initialize, tools/list, remember, recall, and stats", async (t) => {
  const cwd = await tempProject();
  const child = spawn(process.execPath, [serverPath], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    child.stdin.end();
    child.kill();
    await Promise.race([
      once(child, "close"),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    await rm(cwd, { recursive: true, force: true });
  });

  const pending = new Map();
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const message = JSON.parse(line);
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  let id = 0;
  function request(method, params = {}) {
    id += 1;
    const requestId = id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Timed out waiting for ${method}. stderr=${stderr}`));
      }, 10000);
      pending.set(requestId, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
    });
  }

  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.0" },
  });
  assert.equal(init.result.serverInfo.name, "cybermem");

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const list = await request("tools/list");
  const names = list.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("remember"));
  assert.ok(names.includes("recall"));
  assert.ok(names.includes("finding_upsert"));
  assert.ok(names.includes("finding_add_evidence"));

  const remembered = await request("tools/call", {
    name: "remember",
    arguments: {
      level: "principle",
      type: "principle",
      title: "Checksum gates need valid prefixes",
      content: "Code paths beyond checksum gates require format-correct prefixes before mutation is useful.",
      tags: ["checksum", "fuzzing"],
    },
  });
  assert.equal(remembered.result.isError, false);
  assert.equal(remembered.result.structuredContent.created, true);

  const recalled = await request("tools/call", {
    name: "recall",
    arguments: {
      query: "checksum fuzzing prefix",
      topK: 1,
    },
  });
  assert.equal(recalled.result.isError, false);
  assert.equal(recalled.result.structuredContent.hits.length, 1);

  const stats = await request("tools/call", {
    name: "stats",
    arguments: {},
  });
  assert.equal(stats.result.structuredContent.counts.chunks, 1);

  const finding = await request("tools/call", {
    name: "finding_upsert",
    arguments: {
      kind: "primitive",
      title: "Unchecked parser length",
      summary: "Parser trusts length before copying bytes.",
      target: "parser.c",
      category: "memory-safety",
      state: "discovered",
    },
  });
  assert.equal(finding.result.isError, false);
  const findingId = finding.result.structuredContent.finding.id;
  assert.match(findingId, /^P-\d{4}$/);

  const evidence = await request("tools/call", {
    name: "finding_add_evidence",
    arguments: {
      findingId,
      title: "Bounds trace",
      content: "Length reaches copy without guard.",
    },
  });
  assert.equal(evidence.result.isError, false);

  const summary = await request("tools/call", {
    name: "finding_summary",
    arguments: {},
  });
  assert.equal(summary.result.structuredContent.total, 1);
});
