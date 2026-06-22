---
name: cybermem
description: Use cybermem for durable, tiered cyber research memory (episodic/semantic/procedural/analogical/principle) plus a first-class finding ledger for primitives and chains. Activate at task start, during investigation, and at milestones. Uses MCP tools (cybermem__*).
when-to-use: Use for red team vulnerability research memory, finding tracking, consolidation of lessons, ACT-R style buffers, and audit. Especially with opengrep pattern work and complex multi-step investigations.
---

# cybermem (Grok)

Provides structured, auditable memory beyond session history:
- Five knowledge levels
- ACT-R working buffers (goal, retrieval, imaginal, tool, action, meta)
- Production rules for orchestration
- Finding ledger (primitive / chain) with evidence, transitions, links, history

Tools are exposed via the `cybermem` MCP server. When MCP is enabled they appear as `cybermem__recall`, `cybermem__remember`, `cybermem__finding_upsert`, etc. Use Grok's `search_tool` / `use_tool` or direct invocation.

## Quick Start (Grok)

1. Enable the MCP (project .grok/config.toml or `grok mcp add`):
   ```toml
   [mcp_servers.cybermem]
   command = "node"
   args = ["path/to/cybermem/mcp/server.js"]
   env = { CYBERMEM_HOME = ".grok/cybermem" }
   enabled = true
   ```

2. (Optional) Load this skill: `/cybermem` or let it activate automatically.

3. At the beginning of a research goal:
   - Set goal buffer
   - Recall relevant prior knowledge + current context (include opengrep patterns)

See the main README and prompts/ for the full research loop.
