# cybermem

`cybermem` is a Pi package that adds an auditable cyber research memory layer to Pi agents. It is inspired by public descriptions of Crystalline and ACT-R, but it is an independent open implementation: Crystalline itself is closed source, and its CyberGym score is currently a self-published submission claim rather than a reproducible implementation.

The package registers Pi tools for durable recall, learning, consolidation, ACT-R-style working buffers, and lightweight production rules. It also includes an optional stdio MCP sidecar (`cybermem-mcp`) over the same store. Memory is stored per project in `.pi/cybermem/cybermem.sqlite3`, so `pi-sub-agent` child processes, `pi-goal` runs, and MCP clients can share the same accumulated expertise when they run in the same workspace.

## Setup

### Install cybermem
From a local checkout:

```sh
pi install ./ -l
```

For one-off testing:

```sh
pi -e ./extensions/index.js
```

### Install Pi Resources
Several related Pi resources are expected for cyber agents to work well with this package:
```
pi install npm:pi-subagents
pi install npm:pi-codex-goal
pi install npm:pi-web-access
```

### Replace System Prompt
Pi ships with a lightweight system prompt for coding workflows. Replace it with a cyber-focused prompt in your workspace by writing the following to `.pi/SYSTEM.md`:
```
You are an expert cyber assistant operating inside Pi, a coding agent harness. You help users by inspecting files, executing commands, editing files, reverse engineering code, and running proof-of-vulnerability (PoV) scenarios.
```

### Add AGENTS.md
Define a custom AGENTS.md to guide Pi with how to work with your project. A definition of done and environment-specific details are recommended.
```
Authorized vulnerability research for <company>.

## Definition of Done

### Findings
A finding is not done (proven) until it is confirmed attacker reachable and exploitable. The finding must not be a documented accepted risk or expected behavior.

- **Finding Created**: Memorize its hypothetical reachability and exploitability.
- **Proof Gate**: Spawn 3 subagents using gpt-5.4-mini to vote on the validity of a realistic proof-of-vulnerability (PoV) scenario. Each subagent responds with `valid` or `invalid`, a 0-100 vote confidence score, and reasoning for their vote. A majority must vote `valid` before a finding is marked proven.

### Goals
A vulnerability research goal is not complete until there is a newly proofed finding. A proofed finding must be newer than the goal unless there is new impact. Use `get_goal().goal.createdAt` as the goal start timestamp.

- **Goal Started**: Create a novelty baseline of all findings from the ledger, stored in `scratch/goal-baseline-<goal-start-timestamp>.json` and using the copied fields/values from the finding tracker.
- **Completion Gate**: Compare the potential goal-completing finding to the goal baseline. If the proof is older than the goal, it must have a materially new impact or chain.

## Environment
- OS: Windows 11 Pro Insider Edition (inside Hyper-V)

### Workspace Structure
'''
ast-grep/    # OpenGrep/SemGrep rules and artifacts
reports/     # Submission-ready markdown reports
scratch/     # Miscellaneous files
audits/      # Bug class specialist subagent results
tools/       # Scripts, test files, and CLI tools
repo/        # Target source code clone
'''

Avoid persisting files to the top-level directory. When in doubt, use `scratch/`.
```

## What It Provides

- Five knowledge levels: `episodic`, `semantic`, `procedural`, `analogical`, and `principle`.
- ACT-R-style bounded buffers: `goal`, `retrieval`, `imaginal`, `tool`, `action`, and `meta`.
- Activation-based retrieval with traceable score components and local hash embeddings.
- Durable `remember` writes with duplicate strengthening instead of blind append.
- Deterministic consolidation from episodes and explicit promoted insights.
- Production-rule utilities for orchestration policies such as "if triaging a crash, recall similar crashes."
- First-class primitive/chain finding ledger with evidence, links, transitions, history, and backing memory chunks.
- Provenance and audit tools, including preseed contamination checks for CyberGym-like task identifiers.

## Main Tools

- `cybermem_recall`: Retrieve relevant memories and record a retrieval trace.
- `cybermem_remember`: Store or strengthen a typed memory chunk.
- `cybermem_consolidate`: Promote recent experiences into semantic, procedural, analogical, or principle memories.
- `cybermem_stats`: Show store counts, top tags, and storage location.
- `cybermem_forget_decayed`: Dry-run or apply decay pruning for stale low-value memories.
- `cybermem_set_buffer` / `cybermem_get_buffers`: Manage bounded working state.
- `cybermem_register_production`, `cybermem_fire_productions`, `cybermem_reward_production`: Store, run, and tune orchestration policies.
- `cybermem_link`: Add typed links between chunks.
- `cybermem_explain_trace`: Inspect why a recall returned what it returned.
- `cybermem_audit`: Search memory for benchmark contamination patterns.
- `cybermem_finding_upsert`: Create or update primitive/chain findings with backing memory chunks.
- `cybermem_finding_add_evidence`: Attach proof material and create evidence memory chunks.
- `cybermem_finding_transition`: Promote, de-escalate, mark duplicate, or record milestones.
- `cybermem_finding_link`: Connect findings to other findings, memory chunks, or artifacts.
- `cybermem_finding_search`, `cybermem_finding_list`, `cybermem_finding_get`, `cybermem_finding_summary`: Inspect the finding ledger.

## Optional MCP Server

Run the sidecar from a project directory:

```sh
cybermem-mcp
```

Or directly from a checkout:

```sh
node ./mcp/server.js
```

The MCP tool names mirror the Crystalline-style operations: `recall`, `remember`, `consolidate`, `stats`, `forget_decayed`, `set_buffer`, `get_buffers`, `link_chunks`, `explain_trace`, `audit`, `register_production`, `fire_productions`, and `reward_production`. Finding ledger tools are exposed as `finding_upsert`, `finding_get`, `finding_list`, `finding_search`, `finding_add_evidence`, `finding_link`, `finding_transition`, and `finding_summary`.

## Cyber Workflow

Use the package with this loop:

```text
Recall -> Understand -> Craft/Fuzz -> Validate -> Submit -> Remember -> Consolidate
```

At task start, call `cybermem_set_buffer` with the goal and scope, then call `cybermem_recall` using the vulnerability description, sanitizer output, project name, and file format. At task end, call `cybermem_remember` with what worked, what failed, evidence, and tags. Periodically call `cybermem_consolidate` to promote repeated lessons into procedures and principles.

When a branch produces a vulnerability candidate, create or update a finding with `cybermem_finding_upsert`. Use `kind=primitive` for an individual flaw and `kind=chain` for a composed attack path. Attach evidence with `cybermem_finding_add_evidence` and move state with `cybermem_finding_transition`; the backed memory chunks make findings retrievable through ordinary `cybermem_recall`.

For `pi-subagents`, include cybermem tools in agent frontmatter when the subagent should use shared memory:

```yaml
---
name: vuln-scout
description: Find relevant bug patterns and code paths.
tools: read, grep, find, ls, cybermem_recall, cybermem_remember, cybermem_set_buffer, cybermem_get_buffers
---
```

For `pi-goal`, make recall, finding summary, remember, and consolidate explicit goal phases. Run `cybermem_finding_summary`, `cybermem_stats`, or `cybermem_audit` at milestones.

## Storage

By default, the store lives in:

```text
<project>/.pi/cybermem/cybermem.sqlite3
```

If an older `store.json` exists, cybermem imports it once into SQLite. Set `CYBERMEM_HOME` to override the storage directory. SQLite serializes writes across parent and subagent Pi processes.

## Research Provenance

This package was planned from:

- Public Crystalline/CyberGym materials in `synchopate/cybergym-logos`.
- ACT-R ideas: declarative chunks, procedural rules, bounded buffers, activation retrieval, and utility learning.
- Pi package, extension, and MCP stdio conventions from `pi.dev` and the Model Context Protocol transport spec.

See [docs/architecture.md](docs/architecture.md) and [docs/integration.md](docs/integration.md) for the detailed design.

## Example Prompt
```
First, create a full ledger at method_ledger.json (base of this workspace) of all public Java methods within <project>. Each ledger item contains the class, function, and state: untouched, partial, completed. After ledger creation, systematically walk over each function for vulnerabilities, frequently building and using the knowledge base via cybermem. For each function, use existing knowledge to spawn at least two subagents to act as isolated advanced bug class specialists. Use opengrep for code pattern matching across the large source code. Goal completion: identify and proof a vulnerability that is end-to-end reachable by an attacker with an elevation of priveleges or remote security impact. Other findings may be proofed, but will not complete the goal.
```

## Grok

`cybermem` works with Grok via its stdio MCP server (no Pi required).

### Setup with Grok
```sh
# One-time (or per project)
grok mcp add cybermem -- node ./mcp/server.js
```

Or commit a project-scoped config:

```toml
# .grok/config.toml
[mcp_servers.cybermem]
command = "node"
args = ["path/to/cybermem/mcp/server.js"]
env = { CYBERMEM_HOME = ".grok/cybermem" }
enabled = true
```

MCP tools are namespaced: `cybermem__recall`, `cybermem__finding_upsert`, etc.

Use `search_tool` + `use_tool` or load the Grok skill at `grok/SKILL.md` (copied into your `.grok/skills/cybermem/`).

Recommended storage for Grok workspaces:
```
<grok-workspace>/.grok/cybermem/cybermem.sqlite3
```

The same tiered memory, buffers, finding ledger, and production rules are available. See `grok/SKILL.md` and the main Cyber Workflow section above.

The MCP server is the portable integration point for Grok, Claude, Cursor, and other MCP clients.
