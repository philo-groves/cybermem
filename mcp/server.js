#!/usr/bin/env node
import {
  FINDING_STATES,
  FINDING_TYPES,
  MEMORY_LEVELS,
  addFindingEvidence,
  auditMemory,
  consolidateMemories,
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
} from "../extensions/store.js";

const VERSION = "0.1.0";

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    dataDir: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cwd") {
      options.cwd = argv[index + 1] ?? options.cwd;
      index += 1;
    } else if (arg === "--data-dir") {
      options.dataDir = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

const runtime = parseArgs(process.argv.slice(2));

const jsonObject = {
  type: "object",
  additionalProperties: true,
};

const levelSchema = {
  type: "string",
  enum: MEMORY_LEVELS,
};

const findingKindSchema = {
  type: "string",
  enum: FINDING_TYPES,
};

const findingStateSchema = {
  type: "string",
  enum: FINDING_STATES,
};

const tools = {
  recall: {
    description: "Retrieve cyber research memories with activation-based scoring and trace output.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        level: levelSchema,
        levels: { type: "array", items: levelSchema },
        type: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        topK: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        explain: { type: "boolean", default: true },
      },
      required: ["query"],
      additionalProperties: false,
    },
    call: (args) => retrieveMemories(runtime.cwd, args, { dataDir: runtime.dataDir }),
  },
  remember: {
    description: "Store or strengthen a cyber research memory chunk.",
    inputSchema: {
      type: "object",
      properties: {
        level: levelSchema,
        type: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        context: jsonObject,
        source: jsonObject,
        provenance: jsonObject,
        evidence: { type: "array", items: { type: "string" } },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        utility: { type: "number", minimum: -5, maximum: 5 },
        status: { type: "string" },
        canonicalKey: { type: "string" },
      },
      required: ["content"],
      additionalProperties: false,
    },
    call: (args) => rememberMemory(runtime.cwd, args, { dataDir: runtime.dataDir }),
  },
  consolidate: {
    description: "Promote recent episodes or explicit insights into higher-level cyber knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        recentLimit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
        minSupport: { type: "integer", minimum: 1, maximum: 20, default: 2 },
        insights: { type: "array", items: jsonObject },
      },
      additionalProperties: false,
    },
    call: (args) => consolidateMemories(runtime.cwd, args, { dataDir: runtime.dataDir }),
  },
  stats: {
    description: "Show cybermem counts, level distribution, top tags, buffers, and store path.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    call: () => stats(runtime.cwd, { dataDir: runtime.dataDir }),
  },
  forget_decayed: {
    description: "Dry-run or remove stale low-value memories. Defaults to dryRun=true.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", default: true },
        olderThanDays: { type: "number", minimum: 0, default: 180 },
        threshold: { type: "number", default: 0.2 },
      },
      additionalProperties: false,
    },
    call: (args) => forgetDecayed(runtime.cwd, args, { dataDir: runtime.dataDir }),
  },
  set_buffer: {
    description: "Set a bounded ACT-R-style working buffer.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", enum: ["goal", "retrieval", "imaginal", "tool", "action", "meta"] },
        value: {},
      },
      required: ["name", "value"],
      additionalProperties: false,
    },
    call: (args) => setBuffer(runtime.cwd, args.name, args.value, { dataDir: runtime.dataDir }),
  },
  get_buffers: {
    description: "Read all ACT-R-style working buffers.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    call: () => getBuffers(runtime.cwd, { dataDir: runtime.dataDir }),
  },
  link_chunks: {
    description: "Add a typed relationship between two memory chunks.",
    inputSchema: {
      type: "object",
      properties: {
        src: { type: "string" },
        relation: { type: "string" },
        dst: { type: "string" },
        metadata: jsonObject,
      },
      required: ["src", "relation", "dst"],
      additionalProperties: false,
    },
    call: (args) => linkChunks(runtime.cwd, args, { dataDir: runtime.dataDir }),
  },
  explain_trace: {
    description: "Explain a prior recall decision by trace id.",
    inputSchema: {
      type: "object",
      properties: {
        traceId: { type: "string" },
      },
      required: ["traceId"],
      additionalProperties: false,
    },
    call: (args) => explainTrace(runtime.cwd, args.traceId, { dataDir: runtime.dataDir }),
  },
  audit: {
    description: "Search memory for contamination patterns such as benchmark task identifiers.",
    inputSchema: {
      type: "object",
      properties: {
        patterns: { type: "array", items: { type: "string" } },
        sourceKind: { type: "string" },
      },
      additionalProperties: false,
    },
    call: (args) => auditMemory(runtime.cwd, args, { dataDir: runtime.dataDir }),
  },
  finding_upsert: {
    description: "Create or update a primitive or chain finding. Also maintains a backing memory chunk.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        kind: findingKindSchema,
        title: { type: "string" },
        summary: { type: "string" },
        target: {},
        category: { type: "string" },
        locations: { type: "array", items: { type: "string" } },
        state: findingStateSchema,
        severity: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        proofStatus: { type: "string" },
        reportPath: { type: "string" },
        duplicateOf: { type: "string" },
        supersededBy: { type: "string" },
        related: { type: "array", items: { type: "string" } },
        primitives: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
        metadata: jsonObject,
        note: { type: "string" },
        actor: { type: "string" },
        allowDuplicate: { type: "boolean", default: false },
      },
      required: ["title", "summary"],
      additionalProperties: false,
    },
    call: (args) => upsertFinding(runtime.cwd, args, { dataDir: runtime.dataDir }),
  },
  finding_get: {
    description: "Read one finding with evidence, links, history, and backing memory chunk id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    call: (args) => getFinding(runtime.cwd, args.id, { dataDir: runtime.dataDir }),
  },
  finding_list: {
    description: "List findings by kind, state, or active/nonterminal status.",
    inputSchema: {
      type: "object",
      properties: {
        kind: findingKindSchema,
        state: findingStateSchema,
        active: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
      },
      additionalProperties: false,
    },
    call: (args) => listFindings(runtime.cwd, args, { dataDir: runtime.dataDir }),
  },
  finding_search: {
    description: "Search the finding ledger for likely duplicates or related primitives/chains.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: findingKindSchema,
        title: { type: "string" },
        target: { type: "string" },
        category: { type: "string" },
        location: { type: "string" },
        evidence: { type: "string" },
        state: findingStateSchema,
        limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
      },
      additionalProperties: false,
    },
    call: (args) => searchFindings(runtime.cwd, args, { dataDir: runtime.dataDir }),
  },
  finding_add_evidence: {
    description: "Attach evidence to a finding and create a backing evidence memory chunk.",
    inputSchema: {
      type: "object",
      properties: {
        findingId: { type: "string" },
        kind: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        artifact: { type: "string" },
        command: { type: "string" },
        hash: { type: "string" },
        metadata: jsonObject,
        note: { type: "string" },
        actor: { type: "string" },
      },
      required: ["findingId"],
      additionalProperties: false,
    },
    call: (args) => addFindingEvidence(runtime.cwd, args, { dataDir: runtime.dataDir }),
  },
  finding_link: {
    description: "Link a finding to another finding or memory chunk.",
    inputSchema: {
      type: "object",
      properties: {
        findingId: { type: "string" },
        relation: { type: "string" },
        targetType: { type: "string", enum: ["finding", "memory", "artifact"] },
        targetId: { type: "string" },
        targetFindingId: { type: "string" },
        memoryId: { type: "string" },
        metadata: jsonObject,
        note: { type: "string" },
        actor: { type: "string" },
      },
      required: ["findingId"],
      additionalProperties: false,
    },
    call: (args) => linkFinding(runtime.cwd, args, { dataDir: runtime.dataDir }),
  },
  finding_transition: {
    description: "Record a finding state transition or milestone.",
    inputSchema: {
      type: "object",
      properties: {
        findingId: { type: "string" },
        state: findingStateSchema,
        proofStatus: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        severity: { type: "string" },
        reportPath: { type: "string" },
        duplicateOf: { type: "string" },
        supersededBy: { type: "string" },
        note: { type: "string" },
        actor: { type: "string" },
        metadata: jsonObject,
      },
      required: ["findingId"],
      additionalProperties: false,
    },
    call: (args) => transitionFinding(runtime.cwd, args, { dataDir: runtime.dataDir }),
  },
  finding_summary: {
    description: "Summarize finding counts by state and active primitive/chain entries.",
    inputSchema: {
      type: "object",
      properties: {
        kind: findingKindSchema,
        activeLimit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      additionalProperties: false,
    },
    call: (args) => findingSummary(runtime.cwd, args, { dataDir: runtime.dataDir }),
  },
  register_production: {
    description: "Create or update a lightweight production rule.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        conditions: { type: "array", items: jsonObject },
        actions: { type: "array", items: jsonObject },
        utility: { type: "number", minimum: -5, maximum: 5 },
        tags: { type: "array", items: { type: "string" } },
        owner: { type: "string" },
        safetyScope: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    call: (args) => registerProduction(runtime.cwd, args, { dataDir: runtime.dataDir }),
  },
  fire_productions: {
    description: "Run matching production rules for a bounded number of cycles.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        cycleLimit: { type: "integer", minimum: 1, maximum: 10, default: 1 },
      },
      additionalProperties: false,
    },
    call: (args) => fireProductions(runtime.cwd, args, { dataDir: runtime.dataDir }),
  },
  reward_production: {
    description: "Update a production rule's utility from reward/cost feedback.",
    inputSchema: {
      type: "object",
      properties: {
        productionId: { type: "string" },
        value: { type: "number", minimum: -5, maximum: 5 },
        reason: { type: "string" },
        taskId: { type: "string" },
        learningRate: { type: "number", minimum: 0.01, maximum: 1, default: 0.2 },
      },
      required: ["productionId", "value"],
      additionalProperties: false,
    },
    call: (args) => rewardProduction(runtime.cwd, args, { dataDir: runtime.dataDir }),
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message, data = undefined) {
  send({ jsonrpc: "2.0", id, error: { code, message, data } });
}

async function handleRequest(message) {
  const { id, method, params = {} } = message;
  try {
    if (method === "initialize") {
      result(id, {
        protocolVersion: params.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "cybermem", version: VERSION },
      });
      return;
    }
    if (method === "ping") {
      result(id, {});
      return;
    }
    if (method === "tools/list") {
      result(id, {
        tools: Object.entries(tools).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
      return;
    }
    if (method === "tools/call") {
      const tool = tools[params.name];
      if (!tool) {
        result(id, {
          content: [{ type: "text", text: `Unknown cybermem tool: ${params.name}` }],
          isError: true,
        });
        return;
      }
      try {
        const output = await tool.call(params.arguments ?? {});
        result(id, {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
          isError: false,
        });
      } catch (toolError) {
        result(id, {
          content: [{ type: "text", text: toolError.message }],
          isError: true,
        });
      }
      return;
    }
    if (method === "notifications/initialized") return;
    if (id !== undefined) error(id, -32601, `Method not found: ${method}`);
  } catch (requestError) {
    if (id !== undefined) error(id, -32603, requestError.message);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (parseError) {
      console.error(`cybermem MCP parse error: ${parseError.message}`);
      continue;
    }
    if (message.id === undefined && message.method?.startsWith("notifications/")) {
      continue;
    }
    handleRequest(message).catch((unhandled) => {
      if (message.id !== undefined) error(message.id, -32603, unhandled.message);
    });
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
