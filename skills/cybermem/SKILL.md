---
name: cybermem
description: Use this skill for memory persistence and orchestration. This skill should trigger during task start and frequently throughout research for alignment and knowledge base growth. Contains memory levels for episodic, semantic, procedural, analogical, and principal. Also contains stateful tracking for all findings.
---

# cybermem

Use this skill when a Pi agent is doing cyber research and should accumulate, retrieve, or audit durable research memory with the `cybermem_*` tools.

## Workflow

1. At task start, call `cybermem_set_buffer` for `goal` with the target, scope, constraints, and success criteria.
2. Call `cybermem_recall` with a query that includes the project, vulnerability class, sanitizer, file format, relevant APIs, and current blocker.
3. Use the recalled memories as hypotheses, not facts. Check provenance, confidence, and evidence.
4. During investigation, keep `imaginal` for the current hypothesis and `tool` for the latest important tool observation.
5. At task end, call `cybermem_remember` for transferable lessons, failed strategies, evidence, and validated procedures.
6. When a branch produces a vulnerability candidate or chain decision, call `cybermem_finding_upsert` rather than storing it only as a loose memory.
7. Attach concrete proof material with `cybermem_finding_add_evidence`, and use `cybermem_finding_transition` for promotion, de-escalation, duplicate marking, or milestones.
8. Call `cybermem_consolidate` when multiple episodes support a general concept, procedure, analogy, or principle.
9. For benchmark or public claims, call `cybermem_audit` on seeded memories and report the audit result.

## Memory Levels

- Use `episodic` for specific task traces, tool runs, failed attempts, and evidence.
- Use `semantic` for concepts, formats, sanitizer behavior, project facts, and vulnerability classes.
- Use `procedural` for reusable action sequences.
- Use `analogical` for mappings between similar APIs, lifecycles, projects, or vulnerability shapes.
- Use `principle` for abstract invariants that should guide future decisions.

## Guardrails

- Do not remember secrets, credentials, private exploit payloads, or out-of-scope target data.
- Prefer concise, sourced memories over transcript dumps.
- Include `source.kind`, `taskId`, and evidence hashes or paths when possible.
- Treat low-confidence memories as prompts for investigation, not authority.
- Treat finding state as ledger-owned. Do not imply a finding is validated, proofed, or reportable unless the finding ledger state and evidence support that claim.
