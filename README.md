# Cybermem

An experimental memory system for advanced software threat models and vulnerability research with an evolving knowledge base. This project is available as a Codex plugin.

Cybermem is intentionally light. It gives a capable model or human researcher durable access to prior system knowledge without prescribing a rigid cyber workflow.

## Design Principles

- Store reusable system knowledge, not session history.
- Keep artifacts on disk; store only evidence references.
- Use relative paths for code and artifacts whenever possible.
- Model memory as typed graph nodes with typed relationships.
- Let the researcher or active model choose the research flow.
- Keep the MCP tool surface small and composable.

## Memory Types

- **Asset**: An application, system, program, equipment, or personnel.
- **Bug History**: A historical bug, CVE, patch-diff finding, security-relevant code comment, or prior defect note.
- **Invariant**: A security fact which is meant to always be true.
- **Mitigation**: A known exploit prevention measure to be aware of.
- **Source**: An attacker-controlled entrypoint into a system.
- **Sink**: A potentially sensitive function or code area to manipulate.
- **Primitive**: A suspected or confirmed individual security flaw, such as a broken invariant.
- **Chain**: A suspected or confirmed collection of primitives exploitable from source to sink.
- **Trajectory**: Any set of steps meant to be generally reused.

## Storage Model

Cybermem uses SQLite as the primary database. By default, each workspace stores memory at:

```txt
.cybermem/memory.sqlite
```

Every memory record is a typed node with shared fields:

```json
{
  "id": "primitive-example-123",
  "type": "primitive",
  "title": "Example primitive",
  "summary": "Short durable claim.",
  "body": "Optional longer details.",
  "status": "suspected",
  "confidence": 0.7,
  "assetIds": ["asset-example-api"],
  "tags": ["auth", "access-control"],
  "typeData": {},
  "evidence": []
}
```

Relationships are directed graph edges:

```json
{
  "fromId": "primitive-example-123",
  "toId": "invariant-admin-auth-required",
  "relation": "violates",
  "note": "The primitive bypasses the invariant under delegated auth."
}
```

Evidence references are lightweight pointers:

```json
{
  "kind": "code",
  "pathBase": "workspace",
  "path": "src/auth/session.ts",
  "locator": {
    "lineStart": 42,
    "lineEnd": 60,
    "symbol": "validateSession"
  },
  "summary": "Session validation rejects expired tokens before privilege checks."
}
```

Cybermem should not store source files, command output dumps, screenshots, PoVs, reports, or transcripts. Those stay on disk and are referenced by relative path.

## MCP Tools

The plugin exposes a small MCP API:

- `cybermem_search`: Search memory by query, type, asset id, or tag.
- `cybermem_get`: Retrieve a node by id with evidence and links.
- `cybermem_save`: Create or merge a typed memory node.
- `cybermem_link`: Create or update a directed relationship between nodes.
- `cybermem_export`: Export a portable JSON preseed.
- `cybermem_import`: Merge a JSON preseed into the current workspace.

## Viewer

The MCP server also hosts a local read-only viewer for researchers. It is not exposed as a memory tool and is not part of the cyber agent workflow.

By default, the viewer starts with the MCP server at:

```txt
http://127.0.0.1:8765/
```

If the port is busy, Cybermem tries the next available port. The active viewer URL is written to:

```txt
~/.cybermem/viewer.json
```

The viewer tracks recently used workspaces from normal memory tool calls and reads SQLite directly when rendered. It polls only while the browser page is open and visible.

## Local Install

This repository is a Codex plugin root. The plugin manifest lives at:

```txt
.codex-plugin/plugin.json
```

For local development, expose the repository through the personal plugin marketplace by making it available at:

```txt
~/plugins/cybermem
```

For example, from this repository:

```bash
mkdir -p ~/plugins
ln -s "$(pwd)" ~/plugins/cybermem
```

Then add a `cybermem` entry to the local marketplace at `~/.agents/plugins/marketplace.json`:

```json
{
  "name": "cybermem",
  "source": {
    "source": "local",
    "path": "./plugins/cybermem"
  },
  "policy": {
    "installation": "AVAILABLE",
    "authentication": "ON_INSTALL"
  },
  "category": "Security"
}
```

Runtime memory is workspace-local and is created on first use:

```txt
.cybermem/memory.sqlite
```

The runtime database, WAL files, and exported preseeds are intentionally ignored by git.

## Expected Workflow

1. **Identifying Asset(s)**: Every memory record is assigned to at least one asset. The first step is to identify and document relevant assets.
2. **Threat Modeling**: Modeling aligns future cyber research with knowledge of invariants (security facts) and mitigations (custom defenses). Initial sources (asset inputs) and sinks (dangerous code) are also mapped.
3. **Vulnerability Analysis**: Analysis is the agentic vulnerability scanning step, resulting in primitives (single code flaws) and chains (end-to-end flaw combinations). Important research trajectories are memorized as well. Sources and sinks may also be refined during analysis.
4. **Proofing**: Primitives and chains must be proofed before they are fully confirmed. Primitives may be proofed with static analysis, while chains require end-to-end proof-of-vulnerability (PoV) runnables. Each PoV must pass an isolated subagent skeptic gate.
5. **Reporting**: Proofed chains are converted into submission-ready reports which include steps to reproduce, impact analysis, and details of the vulnerability.

Assets provide scoped areas of research. Bug history captures prior defects and recurrence signals. Invariants and mitigations provide unique security considerations. Sources and sinks provide security-relevant code locations. Primitives and chains provide tracking of security flaws. Trajectories provide reusable steps to improve over time.

## Preseeding

Preseeding is taking the memory from one machine and using it as a base for another.

This memory system separates transcripts from system knowledge. That means the persisted memory stores are exceptionally general: cyber research on the same asset(s) can seamlessly be shared in a plug-and-play style.
