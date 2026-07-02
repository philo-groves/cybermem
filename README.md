# Cybermem
An experimental memory system to create advanced software threat models and perform vulnerability research with an evolving knowledge base. This project is available as a Codex plugin.

## Memory Types

- **Asset**: An application, system, program, equipment, or personnel.
- **Invariant**: A security fact which is meant to always be true.
- **Mitigation**: A known exploit prevention measure to be aware of.
- **Source**: An attacker-controlled entrypoint into a system.
- **Sink**: A potentially sensitive function or code area to manipulate.
- **Primitive**: An individual security flaw, such as broken invariant.
- **Chain**: A collection of primitives exploitable from source to sink.
- **Trajectory**: Any set of steps meant to be generally reused.

## Expected Workflow

1. **Identifying Asset(s)**: Every memory record is assigned to at least one asset. The first step is to identify and document relevant assets.
2. **Threat Modeling**: Modeling aligns future cyber research with knowledge of invariants (security facts) and mitigations (custom defenses). Initial sources (asset inputs) and sinks (dangerous code) are also mapped.
3. **Vulnerability Analysis**: Analysis is the agentic vulnerability scanning step, resulting in primitives (single code flaws) and chains (end-to-end flaw combinations). Important research trajectories are memorized as well. Sources and sinks may also be refined during analysis.
4. **Proofing**: Primitives and chains must be proofed before they are fully confirmed. Primitives may be proofed with static analysis, while chains require end-to-end proof-of-vulnerability (PoV) runnables. Each PoV must pass an isolated subagent skeptic gate.
5. **Reporting**: Proofed chains are converted into suybmission-ready reports which include steps to reproduce, impact analysis, and details of the vulnerability.

Assets provide scoped areas of research. Invariants and mitigations provide unique security considerations. Sources and sinks provide security-relevant code locations. Primitives and chains provide tracking of security flaws. Trajectories provide resusable steps to improve over time.