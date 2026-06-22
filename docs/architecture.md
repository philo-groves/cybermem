# Architecture

`cybermem` is an open cyber research memory layer for Pi and MCP clients. It borrows public ideas from Crystalline and ACT-R, but it is deliberately smaller and deterministic in its first version so researchers can inspect the SQLite store and reproduce behavior.

## Knowledge Levels

The store has five levels:

- `episodic`: concrete task experiences, tool runs, failed attempts, PoC observations, and evidence.
- `semantic`: domain concepts, file-format knowledge, sanitizer terms, subsystem facts, and vulnerability classes.
- `procedural`: reusable playbooks and action sequences.
- `analogical`: mappings between projects, APIs, lifecycles, parsers, and vulnerability shapes.
- `principle`: abstract invariants that should guide decisions across tasks.

All memories are typed chunks with slots:

```json
{
  "id": "mem_...",
  "level": "principle",
  "type": "principle",
  "title": "Checksum-gated parsers need format-correct prefixes",
  "content": "...",
  "tags": ["checksum", "parser", "fuzzing"],
  "context": { "format": "png" },
  "source": { "kind": "preseed" },
  "provenance": { "operator": "human" },
  "evidence": ["..."],
  "confidence": 0.8,
  "utility": 0.4,
  "status": "active"
}
```

## Working Buffers

ACT-R's one-chunk buffers become bounded Pi-visible working state:

- `goal`: current objective, scope, and constraints.
- `retrieval`: last recall result and trace id.
- `imaginal`: current synthesized hypothesis or scratch model.
- `tool`: recent tool output or observation.
- `action`: queued next action.
- `meta`: errors, uncertainty, blocked state, or run metadata.

Agents should use buffers for current attention and reserve long-term memory for lessons that should survive the session.

## Retrieval

`cybermem_recall` ranks chunks using deterministic score components. Candidate rows are read from SQLite with level/type/status filters, then reranked in-process with lexical overlap, working-buffer context, activation metadata, and a stored local hash embedding:

```text
score = semantic_match
      + title_boost
      + embedding_match
      + tag_match
      + context_spread_from_buffers
      + base_level_recency_frequency
      + confidence
      + utility
      + source_quality
      - staleness_penalty
      - conflict_penalty
```

Embeddings are dependency-free: cybermem hashes query and chunk terms into a normalized 256-dimensional vector stored as a SQLite BLOB. This is not a hosted model embedding, but it gives a simple semantic-ish similarity signal while keeping the package offline, auditable, and easy to install.

Every recall creates a trace with selected chunk ids, candidate scores, score components, filters, and matched tokens. Use `cybermem_explain_trace` to inspect the decision.

## Consolidation

`cybermem_consolidate` has two paths:

- Explicit insights supplied by the agent or user are promoted directly into the requested level.
- Recent episodic memories are grouped by repeated tags; repeated tags become semantic, procedural, analogical, or principle candidates based on tag names and support.

This is intentionally conservative. It does not make hidden LLM calls from the extension. If you want model-generated consolidation, have the agent synthesize explicit `insights` and pass them to the tool.

## Production Rules

Production rules are structured orchestration policies:

```json
{
  "name": "recall-similar-crashes",
  "conditions": [
    { "type": "buffer_contains", "buffer": "goal", "text": "crash" }
  ],
  "actions": [
    {
      "type": "recall",
      "query": "{query} {goal}",
      "levels": ["episodic", "principle"],
      "topK": 5,
      "targetBuffer": "retrieval"
    }
  ],
  "utility": 0.4
}
```

Supported conditions in v0.1:

- `always`
- `query_contains`
- `buffer_exists`
- `buffer_contains`
- `tag_seen`
- `memory_level_count_at_least`

Supported actions in v0.1:

- `recall`
- `set_buffer`
- `remember`

Use `cybermem_reward_production` to adjust utility when a rule leads to useful evidence, avoids duplicate work, or causes a dead end.

## Finding Ledger

The memory store includes a first-class finding ledger modeled after MaxTAC's split between individual primitives and composed chains.

Finding kinds:

- `primitive`: an individual flaw or exploit primitive.
- `chain`: one or more primitives composed into a reachable impact path.

Finding states:

- `discovered`: plausible candidate but no direct evidence yet.
- `confident`: plausible candidate with direct evidence.
- `validated`: primitive or chain has passed validity/reachability review.
- `proofed`: proof-of-vulnerability or accepted proof packet exists.
- `duplicate`: same root cause or same primitive combination as another finding.
- `limited`: cannot be promoted to proofed, but should not be discarded.
- `de-escalated`: debunked or out of scope.

Ledger tables live beside memory chunks:

- `findings`: canonical primitive/chain state.
- `finding_evidence`: proof material, artifact references, commands, hashes, and backing memory chunks.
- `finding_links`: relationships to other findings, memory chunks, or artifacts.
- `finding_history`: timestamped milestones and state transitions.

Each finding is backed by a normal `type=finding` memory chunk. Evidence rows are backed by `type=finding-evidence` memory chunks. This means the ledger is the single source of truth for state, while normal memory retrieval can still surface relevant findings, supporting evidence, and linked principles.

Use the ledger when a branch produces a finding decision. Use ordinary memory for transferable domain knowledge, negative results, procedures, analogies, and principles.

## Storage and Concurrency

The store is a single SQLite database at `.pi/cybermem/cybermem.sqlite3` by default. SQLite serializes writes so parent Pi processes and `pi-sub-agent` child processes can update one shared project memory.

Set `CYBERMEM_HOME` to route memory elsewhere, for example to a shared mounted research ledger.

The optional `cybermem-mcp` sidecar exposes the same store over stdio JSON-RPC. It does not depend on Pi runtime APIs.

Older `.pi/cybermem/store.json` files are imported once into SQLite for migration compatibility.

## Security and Compliance

The store can contain sensitive research notes. Do not store credentials, live exploit payloads, or data outside your authorization scope. For benchmark work, use `source.kind = "preseed"` on seeded knowledge and run:

```text
cybermem_audit({ "sourceKind": "preseed" })
```

The default audit patterns look for `arvo:*`, `oss-fuzz:*`, and `CyberGym`. Add benchmark-specific patterns for stricter audits.
