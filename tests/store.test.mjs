import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  auditMemory,
  addFindingEvidence,
  consolidateMemories,
  explainTrace,
  findingSummary,
  fireProductions,
  getBuffers,
  getFinding,
  linkChunks,
  linkFinding,
  listFindings,
  readStore,
  registerProduction,
  rememberMemory,
  retrieveMemories,
  rewardProduction,
  searchFindings,
  setBuffer,
  stats,
  transitionFinding,
  upsertFinding,
} from "../extensions/store.js";

async function tempProject() {
  return mkdtemp(join(tmpdir(), "cybermem-test-"));
}

test("remember strengthens duplicates and recall records explainable traces", async () => {
  const cwd = await tempProject();
  try {
    const first = await rememberMemory(cwd, {
      level: "principle",
      type: "principle",
      title: "Signed length fields must reject negatives",
      content: "Signed integer parse functions used in size, length, or offset contexts must validate sign.",
      tags: ["signed", "length", "bounds"],
      confidence: 0.9,
    });
    assert.equal(first.created, true);

    const duplicate = await rememberMemory(cwd, {
      level: "principle",
      type: "principle",
      title: "Signed length fields must reject negatives",
      content: "Signed integer parse functions used in size, length, or offset contexts must validate sign.",
      tags: ["signed", "integer"],
      confidence: 0.8,
    });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.strengthened, true);

    await setBuffer(cwd, "goal", {
      task: "Investigate signed integer length overflow in parser code",
      scope: "authorized local benchmark",
    });

    const recall = await retrieveMemories(cwd, {
      query: "signed integer length overflow parser",
      topK: 3,
      explain: true,
    });
    assert.equal(recall.hits.length, 1);
    assert.equal(recall.hits[0].chunk.id, first.chunk.id);
    assert.ok(recall.traceId.startsWith("trace_"));
    assert.ok(recall.hits[0].components.semanticMatch > 0);

    const trace = await explainTrace(cwd, recall.traceId);
    assert.equal(trace.selectedIds[0], first.chunk.id);
    assert.equal(trace.filters.retrieval, "sqlite-indexed-rows-plus-hash-embedding");

    const buffers = await getBuffers(cwd);
    assert.equal(buffers.retrieval.value.traceId, recall.traceId);

    const summary = await stats(cwd);
    assert.match(summary.path, /cybermem\.sqlite3$/);
    assert.equal(summary.storage.engine, "sqlite");
    assert.equal(summary.storage.retrieval, "indexed-rows-plus-hash-embeddings");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("links, consolidation, stats, and audit work together", async () => {
  const cwd = await tempProject();
  try {
    const a = await rememberMemory(cwd, {
      level: "episodic",
      type: "task",
      title: "PDF checksum gate episode",
      content: "Mutation failed until the PDF header and checksum-like prefix were made format-correct.",
      tags: ["checksum", "pdf", "fuzzing"],
      source: { kind: "task", taskId: "local-1" },
    });
    const b = await rememberMemory(cwd, {
      level: "episodic",
      type: "task",
      title: "TIFF checksum gate episode",
      content: "The parser only reached the target branch after a valid TIFF prefix was built.",
      tags: ["checksum", "tiff", "fuzzing"],
      source: { kind: "task", taskId: "local-2" },
    });
    const linked = await linkChunks(cwd, { src: a.chunk.id, relation: "similar_failure_mode", dst: b.chunk.id });
    assert.equal(linked.created, true);

    const consolidated = await consolidateMemories(cwd, {
      taskId: "consolidation-1",
      minSupport: 2,
    });
    assert.ok(consolidated.promotedCount >= 1);
    assert.ok(consolidated.promoted.some((chunk) => chunk.tags.includes("checksum")));

    await rememberMemory(cwd, {
      level: "semantic",
      type: "concept",
      title: "Bad seed",
      content: "This preseed accidentally mentions arvo:12345.",
      source: { kind: "preseed" },
    });
    const audit = await auditMemory(cwd, { sourceKind: "preseed" });
    assert.equal(audit.matchCount, 1);
    assert.equal(audit.matches[0].match, "arvo:12345");

    const summary = await stats(cwd);
    assert.ok(summary.counts.chunks >= 4);
    assert.ok(summary.byLevel.episodic >= 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("production rules can recall into buffers and learn utility", async () => {
  const cwd = await tempProject();
  try {
    await rememberMemory(cwd, {
      level: "principle",
      type: "principle",
      title: "Both-crash basins need alternate access paths",
      content: "When a PoC crashes both binaries, search for a secondary access path with a narrower trigger.",
      tags: ["both-crash", "secondary-access-path"],
      confidence: 0.8,
    });
    await setBuffer(cwd, "goal", "Investigate both-crash sanitizer failure");
    const registered = await registerProduction(cwd, {
      name: "recall-both-crash-principles",
      conditions: [{ type: "buffer_contains", buffer: "goal", text: "both-crash" }],
      actions: [
        {
          type: "recall",
          query: "{query} {goal}",
          level: "principle",
          tags: ["both-crash"],
          topK: 1,
          targetBuffer: "retrieval",
        },
      ],
      utility: 0.1,
    });
    assert.equal(registered.created, true);

    const fired = await fireProductions(cwd, { query: "strict differential validation fails", cycleLimit: 1 });
    assert.equal(fired.firedCount, 1);
    assert.equal(fired.fired[0].actions[0].type, "recall");

    const buffers = await getBuffers(cwd);
    assert.equal(buffers.retrieval.value.hits.length, 1);

    const rewarded = await rewardProduction(cwd, {
      productionId: registered.production.id,
      value: 3,
      reason: "helped avoid duplicate both-crash attempts",
    });
    assert.ok(rewarded.production.utility > 0.1);

    const store = await readStore(cwd);
    assert.equal(store.productions[0].fireCount, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("finding ledger entries are backed by memory and support evidence, transitions, and chains", async () => {
  const cwd = await tempProject();
  try {
    const primitive = await upsertFinding(cwd, {
      kind: "primitive",
      title: "Unchecked IOCTL output length",
      target: { component: "example.sys", entrypoint: "DeviceControl 0x222004" },
      category: "memory-safety",
      locations: ["DeviceControl"],
      summary: "The IOCTL handler trusts a user-controlled output length before copying kernel data.",
      state: "discovered",
      confidence: 0.45,
      tags: ["ioctl", "kernel"],
      note: "Initial candidate from static scan.",
    });
    assert.equal(primitive.created, true);
    assert.equal(primitive.finding.kind, "primitive");
    assert.match(primitive.finding.id, /^P-\d{4}$/);
    assert.ok(primitive.finding.memoryChunkId);

    const evidence = await addFindingEvidence(cwd, {
      findingId: primitive.finding.id,
      kind: "static-analysis",
      title: "Source-to-sink path",
      content: "User length reaches copy without an upper-bound check.",
      artifact: "artifacts/cfg/ioctl-path.md",
      hash: "sha256:test",
    });
    assert.equal(evidence.evidence.findingId, primitive.finding.id);
    assert.ok(evidence.evidence.memoryChunkId);

    const transitioned = await transitionFinding(cwd, {
      findingId: primitive.finding.id,
      state: "confident",
      proofStatus: "evidence-attached",
      confidence: 0.72,
      note: "CFG evidence supports direct reachability.",
    });
    assert.equal(transitioned.finding.state, "confident");
    assert.equal(transitioned.finding.history.at(-1).event, "transition");

    const chain = await upsertFinding(cwd, {
      kind: "chain",
      title: "IOCTL disclosure to ASLR bypass",
      target: "example.sys",
      category: "chain",
      summary: "The output-length primitive can disclose kernel pointers that support a later write primitive.",
      primitives: [primitive.finding.id],
      state: "discovered",
      allowDuplicate: true,
    });
    assert.match(chain.finding.id, /^C-\d{4}$/);
    assert.deepEqual(chain.finding.primitives, [primitive.finding.id]);

    const linked = await linkFinding(cwd, {
      findingId: chain.finding.id,
      relation: "uses_primitive",
      targetFindingId: primitive.finding.id,
    });
    assert.equal(linked.created, true);

    const search = await searchFindings(cwd, {
      query: "IOCTL output length kernel",
      kind: "primitive",
    });
    assert.equal(search.results[0].finding.id, primitive.finding.id);

    const listed = await listFindings(cwd, { active: true });
    assert.equal(listed.count, 2);

    const recalled = await retrieveMemories(cwd, {
      query: "unchecked ioctl output length finding",
      type: "finding",
      topK: 3,
    });
    assert.ok(recalled.hits.some((hit) => hit.chunk.id === primitive.finding.memoryChunkId));

    const details = await getFinding(cwd, primitive.finding.id);
    assert.equal(details.evidence.length, 1);
    assert.ok(details.history.length >= 3);

    const summary = await findingSummary(cwd);
    assert.equal(summary.total, 2);
    assert.equal(summary.byKind.primitive, 1);
    assert.equal(summary.byKind.chain, 1);

    const store = await readStore(cwd);
    assert.equal(store.findings.length, 2);
    assert.equal(store.findingEvidence.length, 1);
    assert.ok(store.links.some((link) => link.relation === "supported_by"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
