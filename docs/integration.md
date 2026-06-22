# Integration

## Pi Package

The package follows Pi conventions:

- `package.json` includes `keywords: ["pi-package"]`.
- `package.json.pi.extensions` points at `./extensions/index.js`.
- `package.json.pi.skills` points at `./skills`.
- `package.json.pi.prompts` points at `./prompts`.

Install locally with:

```sh
pi install ./ -l
```

Pi package docs allow package resources to be declared under the `pi` key and loaded from local paths, npm, or git.

## pi-sub-agent

`pi-sub-agent` narrows child tool access from the parent session. To give a subagent memory access, include cybermem tools in the subagent frontmatter:

```yaml
---
name: vuln-verifier
description: Verify a suspected vulnerable path and remember evidence.
tools: read, grep, find, ls, bash, cybermem_recall, cybermem_remember, cybermem_set_buffer, cybermem_get_buffers
---
```

Suggested roles:

- Scout agents: `cybermem_recall`, `cybermem_set_buffer`, `cybermem_get_buffers`, `cybermem_finding_search`.
- Workers: `cybermem_recall`, `cybermem_remember`, `cybermem_link`, `cybermem_finding_upsert`, `cybermem_finding_add_evidence`.
- Verifiers: `cybermem_recall`, `cybermem_remember`, `cybermem_audit`, `cybermem_finding_transition`.
- Goal runners: full set, including production, consolidation, and finding summary tools.

Because memory is keyed by `cwd`, child agents should run in the same project workspace when they are meant to share memory.

## pi-goal

For long-running goals, make memory phases explicit:

1. Set `goal` buffer with scope, target, and success criteria.
2. Recall related memories.
3. Store important tool observations in the `tool` or `imaginal` buffers.
4. Search or upsert findings when the branch produces a primitive or chain decision.
5. Attach evidence and transition findings when proof state changes.
6. Remember successful and failed strategies at task boundaries.
7. Consolidate after related tasks or when a repeated invariant emerges.
8. Audit seeded memories before benchmark submission.

## MCP Sidecar

This package includes a dependency-free stdio MCP sidecar:

```sh
cybermem-mcp
```

From a checkout:

```sh
node ./mcp/server.js
```

The sidecar uses newline-delimited JSON-RPC over stdio and writes logs only to stderr. It stores memory in the current working directory by default at `.pi/cybermem/cybermem.sqlite3`. Use `--cwd <path>` or `--data-dir <path>` when a client launches the server from another location.

The MCP tool surface mirrors the public Crystalline-style operations:

- `recall` -> `cybermem_recall`
- `remember` -> `cybermem_remember`
- `consolidate` -> `cybermem_consolidate`
- `stats` -> `cybermem_stats`
- `forget_decayed` -> `cybermem_forget_decayed`

Additional MCP tools expose buffers, links, trace explanations, audits, production rules, and finding ledgers.

Finding ledger MCP tools:

- `finding_upsert`
- `finding_get`
- `finding_list`
- `finding_search`
- `finding_add_evidence`
- `finding_link`
- `finding_transition`
- `finding_summary`
