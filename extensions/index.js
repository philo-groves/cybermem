import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  BUFFER_NAMES,
  FINDING_STATES,
  FINDING_TYPES,
  MEMORY_LEVELS,
  addFindingEvidence,
  auditMemory,
  consolidateMemories,
  ensureStore,
  explainTrace,
  findingSummary,
  fireProductions,
  forgetDecayed,
  getBuffers,
  getFinding,
  linkChunks,
  linkFinding,
  listFindings,
  registerProduction,
  rememberMemory,
  retrieveMemories,
  rewardProduction,
  searchFindings,
  setBuffer,
  stats,
  transitionFinding,
  upsertFinding,
} from "./store.js";

const LevelEnum = StringEnum(MEMORY_LEVELS);
const BufferEnum = StringEnum(BUFFER_NAMES);
const FindingKindEnum = StringEnum(FINDING_TYPES);
const FindingStateEnum = StringEnum(FINDING_STATES);
const StatusEnum = StringEnum(["active", "pinned", "superseded", "rejected", "unsafe"]);

function jsonResult(data, summary = undefined) {
  return {
    content: [
      {
        type: "text",
        text: summary ? `${summary}\n\n${JSON.stringify(data, null, 2)}` : JSON.stringify(data, null, 2),
      },
    ],
    details: data,
  };
}

function objectSchema(description) {
  return Type.Optional(Type.Record(Type.String(), Type.Any(), { description }));
}

function registerCybermemTools(pi) {
  pi.registerTool({
    name: "cybermem_recall",
    label: "Cybermem Recall",
    description:
      "Retrieve cyber research memories with activation-based scoring. Results include a trace id and score components.",
    promptSnippet: "Retrieve durable cyber research memory with cybermem_recall.",
    promptGuidelines: [
      "Use cybermem_recall at the start of vulnerability research tasks with the project, bug class, sanitizer, file format, and current goal.",
      "Use cybermem_explain_trace when a cybermem_recall result looks surprising or too weak.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "Natural-language query, ideally including vulnerability class, sanitizer, format, target project, and current blocker.",
      }),
      level: Type.Optional(LevelEnum),
      levels: Type.Optional(Type.Array(LevelEnum)),
      type: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
      status: Type.Optional(Type.String()),
      topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 5 })),
      explain: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await retrieveMemories(ctx.cwd, params);
      return jsonResult(result, `cybermem_recall returned ${result.hits.length} hit(s).`);
    },
  });

  pi.registerTool({
    name: "cybermem_remember",
    label: "Cybermem Remember",
    description:
      "Store or strengthen a cyber research memory chunk with level, provenance, confidence, tags, and evidence.",
    promptSnippet: "Store durable cyber research lessons with cybermem_remember.",
    promptGuidelines: [
      "Use cybermem_remember at the end of cyber research tasks to record what worked, what failed, evidence, and scope.",
      "Use cybermem_remember for transferable lessons, not raw exploit dumps or secrets.",
    ],
    parameters: Type.Object({
      level: Type.Optional(LevelEnum),
      type: Type.Optional(Type.String({ description: "Chunk type such as finding, artifact, procedure, principle, or tool-run." })),
      title: Type.Optional(Type.String()),
      content: Type.String(),
      tags: Type.Optional(Type.Array(Type.String())),
      context: objectSchema("Structured task context such as project, sanitizer, format, bug class, or target."),
      source: objectSchema("Source metadata such as kind, taskId, operator, repository, or quality."),
      provenance: objectSchema("Provenance metadata such as command, log path, evidence hash, or confidence rationale."),
      evidence: Type.Optional(Type.Array(Type.String())),
      confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      utility: Type.Optional(Type.Number({ minimum: -5, maximum: 5 })),
      status: Type.Optional(StatusEnum),
      canonicalKey: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await rememberMemory(ctx.cwd, params);
      const action = result.created ? "created" : "strengthened";
      return jsonResult(result, `cybermem_remember ${action} ${result.chunk.id}.`);
    },
  });

  pi.registerTool({
    name: "cybermem_consolidate",
    label: "Cybermem Consolidate",
    description:
      "Promote recent episodic memories into semantic, procedural, analogical, or principle knowledge.",
    promptSnippet: "Promote repeated cyber research lessons with cybermem_consolidate.",
    promptGuidelines: [
      "Use cybermem_consolidate after a run of related tasks or when a repeated invariant emerges.",
      "Pass explicit insights to cybermem_consolidate when you can name the procedure or principle directly.",
    ],
    parameters: Type.Object({
      taskId: Type.Optional(Type.String()),
      recentLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 50 })),
      minSupport: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 2 })),
      insights: Type.Optional(
        Type.Array(
          Type.Object({
            level: Type.Optional(LevelEnum),
            type: Type.Optional(Type.String()),
            title: Type.Optional(Type.String()),
            content: Type.String(),
            tags: Type.Optional(Type.Array(Type.String())),
            confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
            sourceEpisodeIds: Type.Optional(Type.Array(Type.String())),
            source: objectSchema("Source metadata for the promoted insight."),
            provenance: objectSchema("Provenance metadata for the promoted insight."),
          }),
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await consolidateMemories(ctx.cwd, params);
      return jsonResult(result, `cybermem_consolidate promoted ${result.promotedCount} memory chunk(s).`);
    },
  });

  pi.registerTool({
    name: "cybermem_stats",
    label: "Cybermem Stats",
    description: "Show cybermem counts, level distribution, top tags, buffers, and store path.",
    promptSnippet: "Inspect cybermem memory counts with cybermem_stats.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const result = await stats(ctx.cwd);
      return jsonResult(result, `cybermem has ${result.counts.chunks} chunk(s).`);
    },
  });

  pi.registerTool({
    name: "cybermem_forget_decayed",
    label: "Cybermem Forget Decayed",
    description:
      "Find or remove stale low-value memories. Defaults to dryRun=true and never removes active or pinned chunks.",
    parameters: Type.Object({
      dryRun: Type.Optional(Type.Boolean({ default: true })),
      olderThanDays: Type.Optional(Type.Number({ minimum: 0, default: 180 })),
      threshold: Type.Optional(Type.Number({ default: 0.2 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await forgetDecayed(ctx.cwd, params);
      return jsonResult(
        result,
        result.dryRun
          ? `cybermem_forget_decayed found ${result.candidateCount} candidate(s).`
          : `cybermem_forget_decayed removed ${result.removedCount} chunk(s).`,
      );
    },
  });

  pi.registerTool({
    name: "cybermem_set_buffer",
    label: "Cybermem Set Buffer",
    description: "Set one ACT-R-style working buffer for the current research session.",
    promptSnippet: "Update bounded cybermem working state with cybermem_set_buffer.",
    promptGuidelines: [
      "Use cybermem_set_buffer to keep the goal, current hypothesis, recent tool output, and action queue concise.",
    ],
    parameters: Type.Object({
      name: BufferEnum,
      value: Type.Any(),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await setBuffer(ctx.cwd, params.name, params.value);
      return jsonResult(result, `cybermem buffer '${params.name}' updated.`);
    },
  });

  pi.registerTool({
    name: "cybermem_get_buffers",
    label: "Cybermem Get Buffers",
    description: "Read all ACT-R-style cybermem working buffers.",
    promptSnippet: "Read bounded cybermem working state with cybermem_get_buffers.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const result = await getBuffers(ctx.cwd);
      return jsonResult(result);
    },
  });

  pi.registerTool({
    name: "cybermem_link",
    label: "Cybermem Link",
    description: "Add a typed relationship between two memory chunks.",
    parameters: Type.Object({
      src: Type.String(),
      relation: Type.String(),
      dst: Type.String(),
      metadata: objectSchema("Optional relationship metadata."),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await linkChunks(ctx.cwd, params);
      return jsonResult(result, result.created ? "cybermem_link created a link." : "cybermem_link already existed.");
    },
  });

  pi.registerTool({
    name: "cybermem_explain_trace",
    label: "Cybermem Explain Trace",
    description: "Explain a prior cybermem_recall decision using its trace id.",
    parameters: Type.Object({
      traceId: Type.String(),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await explainTrace(ctx.cwd, params.traceId);
      return jsonResult(result, `Trace ${params.traceId}`);
    },
  });

  pi.registerTool({
    name: "cybermem_audit",
    label: "Cybermem Audit",
    description:
      "Search memory for contamination patterns such as CyberGym task identifiers. Useful for preseed audits.",
    promptSnippet: "Audit cybermem provenance and benchmark contamination with cybermem_audit.",
    parameters: Type.Object({
      patterns: Type.Optional(Type.Array(Type.String())),
      sourceKind: Type.Optional(Type.String({ description: "Optional source.kind or source.type filter, e.g. preseed." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await auditMemory(ctx.cwd, params);
      return jsonResult(result, `cybermem_audit found ${result.matchCount} match(es).`);
    },
  });

  pi.registerTool({
    name: "cybermem_finding_upsert",
    label: "Cybermem Finding Upsert",
    description:
      "Create or update a first-class finding ledger entry. Findings are also backed by retrievable memory chunks.",
    promptSnippet: "Track vulnerability candidates and chains with cybermem_finding_upsert.",
    promptGuidelines: [
      "Use cybermem_finding_upsert when a branch produces a candidate primitive or chain decision.",
      "Use kind=primitive for individual flaws and kind=chain for composed attack paths.",
      "Do not promote state beyond the available evidence; use evidence and transition tools for milestones.",
    ],
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      kind: Type.Optional(FindingKindEnum),
      title: Type.String(),
      summary: Type.String(),
      target: Type.Optional(Type.Union([Type.String(), Type.Record(Type.String(), Type.Any())])),
      category: Type.Optional(Type.String()),
      locations: Type.Optional(Type.Array(Type.String())),
      state: Type.Optional(FindingStateEnum),
      severity: Type.Optional(Type.String()),
      confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      proofStatus: Type.Optional(Type.String()),
      reportPath: Type.Optional(Type.String()),
      duplicateOf: Type.Optional(Type.String()),
      supersededBy: Type.Optional(Type.String()),
      related: Type.Optional(Type.Array(Type.String())),
      primitives: Type.Optional(Type.Array(Type.String())),
      tags: Type.Optional(Type.Array(Type.String())),
      metadata: objectSchema("Finding metadata such as phase, subsystem, reviewer votes, or scope notes."),
      note: Type.Optional(Type.String()),
      actor: Type.Optional(Type.String()),
      allowDuplicate: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await upsertFinding(ctx.cwd, params);
      if (result.duplicateBlocked) {
        return jsonResult(result, `cybermem_finding_upsert found ${result.candidates.length} likely duplicate(s).`);
      }
      return jsonResult(
        result,
        `${result.created ? "Created" : "Updated"} ${result.finding.kind} finding ${result.finding.id}.`,
      );
    },
  });

  pi.registerTool({
    name: "cybermem_finding_get",
    label: "Cybermem Finding Get",
    description: "Read one finding with evidence, links, history, and backing memory chunk id.",
    parameters: Type.Object({
      id: Type.String(),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await getFinding(ctx.cwd, params.id);
      return jsonResult(result, `${result.kind} finding ${result.id}: ${result.state}`);
    },
  });

  pi.registerTool({
    name: "cybermem_finding_list",
    label: "Cybermem Finding List",
    description: "List findings by kind, state, or active/nonterminal status.",
    parameters: Type.Object({
      kind: Type.Optional(FindingKindEnum),
      state: Type.Optional(FindingStateEnum),
      active: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 50 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await listFindings(ctx.cwd, params);
      return jsonResult(result, `cybermem_finding_list returned ${result.count} finding(s).`);
    },
  });

  pi.registerTool({
    name: "cybermem_finding_search",
    label: "Cybermem Finding Search",
    description: "Search the finding ledger for likely duplicates or related primitives/chains.",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      kind: Type.Optional(FindingKindEnum),
      title: Type.Optional(Type.String()),
      target: Type.Optional(Type.String()),
      category: Type.Optional(Type.String()),
      location: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.String()),
      state: Type.Optional(FindingStateEnum),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 10 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await searchFindings(ctx.cwd, params);
      return jsonResult(result, `cybermem_finding_search returned ${result.results.length} result(s).`);
    },
  });

  pi.registerTool({
    name: "cybermem_finding_add_evidence",
    label: "Cybermem Finding Add Evidence",
    description: "Attach evidence to a finding and create a backing evidence memory chunk.",
    promptSnippet: "Attach proof material with cybermem_finding_add_evidence.",
    parameters: Type.Object({
      findingId: Type.String(),
      kind: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
      artifact: Type.Optional(Type.String()),
      command: Type.Optional(Type.String()),
      hash: Type.Optional(Type.String()),
      metadata: objectSchema("Evidence metadata such as tool version, verifier, or environment."),
      note: Type.Optional(Type.String()),
      actor: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await addFindingEvidence(ctx.cwd, params);
      return jsonResult(result, `Added evidence ${result.evidence.id} to finding ${params.findingId}.`);
    },
  });

  pi.registerTool({
    name: "cybermem_finding_link",
    label: "Cybermem Finding Link",
    description: "Link a finding to another finding or memory chunk, and mirror that relation into memory links when possible.",
    parameters: Type.Object({
      findingId: Type.String(),
      relation: Type.Optional(Type.String()),
      targetType: Type.Optional(StringEnum(["finding", "memory", "artifact"])),
      targetId: Type.Optional(Type.String()),
      targetFindingId: Type.Optional(Type.String()),
      memoryId: Type.Optional(Type.String()),
      metadata: objectSchema("Relationship metadata."),
      note: Type.Optional(Type.String()),
      actor: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await linkFinding(ctx.cwd, params);
      return jsonResult(result, result.created ? "Created finding link." : "Finding link already existed.");
    },
  });

  pi.registerTool({
    name: "cybermem_finding_transition",
    label: "Cybermem Finding Transition",
    description:
      "Record a finding state transition or milestone, updating the backing memory chunk and history.",
    promptSnippet: "Promote, de-escalate, mark duplicate, or record finding milestones with cybermem_finding_transition.",
    parameters: Type.Object({
      findingId: Type.String(),
      state: Type.Optional(FindingStateEnum),
      proofStatus: Type.Optional(Type.String()),
      confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      severity: Type.Optional(Type.String()),
      reportPath: Type.Optional(Type.String()),
      duplicateOf: Type.Optional(Type.String()),
      supersededBy: Type.Optional(Type.String()),
      note: Type.Optional(Type.String()),
      actor: Type.Optional(Type.String()),
      metadata: objectSchema("Transition metadata such as verifier votes or proof packet references."),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await transitionFinding(ctx.cwd, params);
      return jsonResult(result, `Finding ${params.findingId} is now ${result.finding.state}.`);
    },
  });

  pi.registerTool({
    name: "cybermem_finding_summary",
    label: "Cybermem Finding Summary",
    description: "Summarize finding counts by state and active primitive/chain entries.",
    parameters: Type.Object({
      kind: Type.Optional(FindingKindEnum),
      activeLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await findingSummary(ctx.cwd, params);
      return jsonResult(result, `cybermem has ${result.total} finding(s).`);
    },
  });

  pi.registerTool({
    name: "cybermem_register_production",
    label: "Cybermem Register Production",
    description:
      "Create or update a lightweight production rule: conditions over buffers/query/memory, actions to recall/set buffers/remember.",
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      name: Type.String(),
      description: Type.Optional(Type.String()),
      conditions: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Any()))),
      actions: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Any()))),
      utility: Type.Optional(Type.Number({ minimum: -5, maximum: 5 })),
      tags: Type.Optional(Type.Array(Type.String())),
      owner: Type.Optional(Type.String()),
      safetyScope: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await registerProduction(ctx.cwd, params);
      return jsonResult(
        result,
        result.created
          ? `cybermem_register_production created ${result.production.id}.`
          : `cybermem_register_production updated ${result.production.id}.`,
      );
    },
  });

  pi.registerTool({
    name: "cybermem_fire_productions",
    label: "Cybermem Fire Productions",
    description:
      "Run matching production rules for a bounded number of cycles. Rules may recall memory, set buffers, or remember a hint.",
    promptSnippet: "Run cybermem orchestration policies with cybermem_fire_productions.",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      cycleLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 1 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await fireProductions(ctx.cwd, params);
      return jsonResult(result, `cybermem_fire_productions fired ${result.firedCount} production(s).`);
    },
  });

  pi.registerTool({
    name: "cybermem_reward_production",
    label: "Cybermem Reward Production",
    description: "Update a production rule's utility from reward/cost feedback.",
    parameters: Type.Object({
      productionId: Type.String(),
      value: Type.Number({ minimum: -5, maximum: 5 }),
      reason: Type.Optional(Type.String()),
      taskId: Type.Optional(Type.String()),
      learningRate: Type.Optional(Type.Number({ minimum: 0.01, maximum: 1, default: 0.2 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await rewardProduction(ctx.cwd, params);
      return jsonResult(result, `cybermem_reward_production utility is ${result.production.utility}.`);
    },
  });
}

export default function cybermem(pi) {
  registerCybermemTools(pi);

  pi.on("session_start", async (_event, ctx) => {
    const path = await ensureStore(ctx.cwd).catch(() => null);
    if (path && ctx.ui?.setStatus) ctx.ui.setStatus("cybermem", "memory ready");
  });

  pi.registerCommand("cybermem-stats", {
    description: "Show cybermem store statistics for the current project.",
    handler: async (_args, ctx) => {
      const result = await stats(ctx.cwd);
      const lines = [
        `store: ${result.path}`,
        `chunks: ${result.counts.chunks}`,
        `findings: ${result.counts.findings}`,
        `levels: ${Object.entries(result.byLevel)
          .map(([level, count]) => `${level}=${count}`)
          .join(", ")}`,
        `top tags: ${result.topTags
          .slice(0, 8)
          .map((item) => `${item.tag}:${item.count}`)
          .join(", ")}`,
      ];
      if (ctx.ui?.notify) ctx.ui.notify(lines.join("\n"), "info");
      return jsonResult(result);
    },
  });
}
