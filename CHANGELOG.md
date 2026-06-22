# Changelog

## 0.1.0

- Initial Pi package scaffold.
- Added `cybermem_*` Pi tools for recall, remember, buffers, consolidation, production rules, rewards, links, stats, decay, trace explanation, and benchmark-contamination audit.
- Added optional `cybermem-mcp` stdio sidecar exposing the same store through MCP-style tool names.
- Added deterministic local SQLite store with per-project persistence, stored local hash embeddings, activation scoring, and retrieval traces.
- Legacy `store.json` files are imported once when present.
- Added first-class SQLite finding ledger tables and Pi/MCP tools for primitives, chains, evidence, links, state transitions, summaries, and backing memory chunks.
- Added CyberGym/Crystalline-informed documentation, a cyber memory skill, and a reusable prompt template.
