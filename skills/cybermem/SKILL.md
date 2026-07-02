---
name: cybermem
description: Use Cybermem to persist and retrieve reusable cyber research system knowledge as a lightweight SQLite-backed graph. Use when researching assets, threat models, bug history, vulnerability hypotheses, sources, sinks, mitigations, primitives, chains, or reusable trajectories.
---

# Cybermem

Cybermem is a local memory substrate for cyber research. It stores durable system knowledge as typed graph nodes with lightweight evidence references. It does not store transcripts, task goals, bulk file content, or generated artifacts.

## When To Use

- Search Cybermem before researching an asset, subsystem, vulnerability class, bug history, source, sink, mitigation, primitive, chain, or reusable trajectory that may already have prior knowledge.
- Save new memory only when it is reusable beyond the current conversation or command run.
- Prefer refining an existing node over creating a near-duplicate.
- Link related nodes when the relationship will help future research.
- Export a preseed when memory should travel to another workspace or machine.

## Memory Boundary

Store claims, relationships, and evidence pointers. Keep artifacts on disk.

Good Cybermem content:

- Stable asset descriptions and boundaries.
- Historical bugs, CVEs, patch-diff findings, and security-relevant comments.
- Security invariants expected to hold.
- Custom mitigations and defense assumptions.
- Attacker-controlled sources and sensitive sinks.
- Suspected or confirmed primitives.
- Suspected or confirmed exploit chains.
- Reusable research trajectories.

Do not store:

- Chat transcripts or session narration.
- Current task goals or planning notes.
- Full source files, command output dumps, reports, PoVs, screenshots, or traces.
- Absolute local file paths unless they are intentionally external references.

Evidence references should use paths relative to the workspace, repo, or asset root whenever possible.

## Node Types

- `asset`: An application, system, program, equipment, service, organization, or person in scope.
- `bug`: A historical bug, CVE, patch-diff finding, security-relevant code comment, or prior defect note.
- `invariant`: A security fact that is expected to remain true.
- `mitigation`: A known exploit prevention or hardening measure.
- `source`: An attacker-controlled entrypoint into a system.
- `sink`: A sensitive operation, function, boundary, or code area.
- `primitive`: A suspected or confirmed individual security flaw.
- `chain`: A suspected or confirmed composition of primitives from source to sink.
- `trajectory`: Reusable research steps, heuristics, or analysis routes.

## Tool Use

Use the MCP tools directly and pass the current workspace root when available:

- `cybermem_search`: Search memory by query, type, asset ids, or tags.
- `cybermem_get`: Retrieve a node by id with evidence and links.
- `cybermem_save`: Create or merge a memory node.
- `cybermem_link`: Add a directed relationship between nodes.
- `cybermem_export`: Export a portable JSON preseed.
- `cybermem_import`: Merge a preseed into the current workspace.

Common relations include `belongs_to`, `relates_to`, `violates`, `mitigated_by`, `reachable_from`, `flows_to`, `composes`, `supports`, and `supersedes`. Use another short identifier when the relationship is clearer.

## Save Guidance

Keep nodes concise. Put the durable claim in `summary`; use `body` only for details future research will need. Use `typeData` for structured type-specific state, such as proof state, affected versions, reachable functions, threat assumptions, or report readiness.

Use statuses conservatively:

- `draft`: Incomplete or newly captured.
- `suspected`: Plausible but not confirmed.
- `confirmed`: Supported by strong evidence.
- `rejected`: Investigated and found false or irrelevant.
- `stale`: Previously useful but likely outdated.

Use confidence from `0` to `1`. A high confidence value should usually have evidence.

## Evidence Guidance

Evidence references are lightweight. They should make future research able to find the artifact or code location again without copying the artifact into memory.

Useful evidence examples:

```json
{
  "kind": "code",
  "pathBase": "workspace",
  "path": "src/auth/session.ts",
  "locator": {"lineStart": 42, "lineEnd": 60, "symbol": "validateSession"},
  "summary": "Session validation rejects expired tokens before privilege checks."
}
```

```json
{
  "kind": "artifact",
  "pathBase": "workspace",
  "path": "povs/admin-bypass/README.md",
  "summary": "PoV notes for the suspected admin bypass chain."
}
```

## Workflow

Do not force a fixed cyber methodology. Let the active model or researcher choose the research flow. Cybermem's role is to make durable knowledge searchable, linkable, and portable over time.
