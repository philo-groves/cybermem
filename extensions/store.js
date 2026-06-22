import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const STORE_SCHEMA_VERSION = 2;
export const EMBEDDING_MODEL = "cybermem-hash-embedding-v1";
export const EMBEDDING_DIMENSIONS = 256;

export const MEMORY_LEVELS = [
  "episodic",
  "semantic",
  "procedural",
  "analogical",
  "principle",
];

export const BUFFER_NAMES = [
  "goal",
  "retrieval",
  "imaginal",
  "tool",
  "action",
  "meta",
];

export const FINDING_TYPES = ["primitive", "chain"];

export const FINDING_STATES = [
  "discovered",
  "confident",
  "validated",
  "proofed",
  "duplicate",
  "limited",
  "de-escalated",
];

export const TERMINAL_FINDING_STATES = ["duplicate", "de-escalated"];

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "with",
]);

const DEFAULT_PATTERNS = [
  "\\barvo:\\d+\\b",
  "\\boss-fuzz[:#][A-Za-z0-9_.-]+\\b",
  "\\bCyberGym\\b",
];

const MAX_EVENTS = 500;
const MAX_TRACES = 200;
const MAX_TEXT_FIELD = 120_000;

export function dataDirFor(cwd, override = undefined) {
  return resolve(override ?? process.env.CYBERMEM_HOME ?? join(cwd, ".pi", "cybermem"));
}

export function storePathFor(cwd, override = undefined) {
  return join(dataDirFor(cwd, override), "cybermem.sqlite3");
}

function legacyJsonPathFor(cwd, override = undefined) {
  return join(dataDirFor(cwd, override), "store.json");
}

export function nowIso() {
  return new Date().toISOString();
}

export function tokenize(value) {
  const text = String(value ?? "").toLowerCase();
  const tokens = text.match(/[a-z0-9_+.-]{2,}/g) ?? [];
  return tokens.filter((token) => !STOPWORDS.has(token));
}

export function stableHash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function clampNumber(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function truncateText(value, max = MAX_TEXT_FIELD) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[cybermem: truncated ${text.length - max} characters]`;
}

export function normalizeTags(tags) {
  return [...new Set(asArray(tags).map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))];
}

export function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function jsonString(value) {
  return JSON.stringify(value ?? null);
}

function jsonParse(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function emptyBuffers() {
  return Object.fromEntries(
    BUFFER_NAMES.map((name) => [
      name,
      {
        name,
        value: null,
        updatedAt: null,
      },
    ]),
  );
}

function embeddingTerms(text) {
  const tokens = tokenize(text);
  const terms = [...tokens];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    terms.push(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return terms;
}

export function embedText(text, dimensions = EMBEDDING_DIMENSIONS) {
  const vector = new Float32Array(dimensions);
  for (const term of embeddingTerms(text)) {
    const digest = createHash("sha256").update(term).digest();
    const index = digest.readUInt32LE(0) % dimensions;
    const sign = digest[4] & 1 ? 1 : -1;
    const weight = term.includes(" ") ? 0.7 : 1;
    vector[index] += sign * weight;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = vector[index] / norm;
  }
  return vector;
}

function encodeEmbedding(vector) {
  const buffer = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) {
    buffer.writeFloatLE(vector[index], index * 4);
  }
  return buffer;
}

function decodeEmbedding(blob) {
  if (!blob) return new Float32Array(EMBEDDING_DIMENSIONS);
  const buffer = Buffer.from(blob);
  const dimensions = Math.floor(buffer.length / 4);
  const vector = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    vector[index] = buffer.readFloatLE(index * 4);
  }
  return vector;
}

function cosineSimilarity(left, right) {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
  }
  return dot;
}

function chunkEmbeddingText(chunk) {
  return [
    chunk.title,
    chunk.title,
    chunk.content,
    chunk.type,
    ...(chunk.tags ?? []),
    ...(chunk.tags ?? []),
    JSON.stringify(chunk.context ?? {}),
  ].join("\n");
}

function openDatabase(cwd, options = {}) {
  const dir = dataDirFor(cwd, options.dataDir);
  if (process.env.CYBERMEM_DEBUG_SQLITE) console.error("[cybermem] mkdir", dir);
  mkdirSync(dir, { recursive: true });
  const path = storePathFor(cwd, options.dataDir);
  if (process.env.CYBERMEM_DEBUG_SQLITE) console.error("[cybermem] open", path);
  const db = new DatabaseSync(path);
  if (process.env.CYBERMEM_DEBUG_SQLITE) console.error("[cybermem] pragma foreign_keys");
  db.exec("PRAGMA foreign_keys = ON");
  if (process.env.CYBERMEM_DEBUG_SQLITE) console.error("[cybermem] pragma busy_timeout");
  db.exec("PRAGMA busy_timeout = 2500");
  if (needsSchemaInitialization(db)) {
    if (process.env.CYBERMEM_DEBUG_SQLITE) console.error("[cybermem] schema");
    initializeSchema(db);
  } else {
    ensureLedgerSchema(db);
  }
  if (process.env.CYBERMEM_DEBUG_SQLITE) console.error("[cybermem] migrate");
  migrateLegacyJsonIfNeeded(db, cwd, options);
  if (process.env.CYBERMEM_DEBUG_SQLITE) console.error("[cybermem] ready");
  return db;
}

function needsSchemaInitialization(db) {
  return !db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
}

function ensureLedgerSchema(db) {
  const hasFindings = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'findings'").get();
  if (hasFindings) return;
  if (process.env.CYBERMEM_DEBUG_SQLITE) console.error("[cybermem] ledger schema");
  const previousVersion = getMeta(db, "schema_version") ?? String(STORE_SCHEMA_VERSION);
  initializeSchema(db);
  setMeta(db, "previous_schema_version", previousVersion);
  setMeta(db, "schema_version", String(STORE_SCHEMA_VERSION));
}

function withDatabase(cwd, fn, options = {}) {
  const db = openDatabase(cwd, options);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function withTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function initializeSchema(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      context_json TEXT NOT NULL,
      source_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      confidence REAL NOT NULL,
      utility REAL NOT NULL,
      status TEXT NOT NULL,
      canonical_key TEXT NOT NULL UNIQUE,
      access_count INTEGER NOT NULL,
      reinforcement_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_accessed_at TEXT,
      consolidated_at TEXT,
      embedding_model TEXT NOT NULL,
      embedding BLOB NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_chunks_level ON chunks(level)",
    "CREATE INDEX IF NOT EXISTS idx_chunks_type ON chunks(type)",
    "CREATE INDEX IF NOT EXISTS idx_chunks_status ON chunks(status)",
    "CREATE INDEX IF NOT EXISTS idx_chunks_updated ON chunks(updated_at)",
    `CREATE TABLE IF NOT EXISTS links (
      id TEXT PRIMARY KEY,
      src TEXT NOT NULL,
      relation TEXT NOT NULL,
      dst TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(src, relation, dst)
    )`,
    `CREATE TABLE IF NOT EXISTS buffers (
      name TEXT PRIMARY KEY,
      value_json TEXT,
      updated_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS productions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      conditions_json TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      utility REAL NOT NULL,
      tags_json TEXT NOT NULL,
      owner TEXT,
      safety_scope TEXT,
      fire_count INTEGER NOT NULL,
      reward_history_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_fired_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS traces (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      query TEXT NOT NULL,
      filters_json TEXT NOT NULL,
      selected_ids_json TEXT NOT NULL,
      candidates_json TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      data_json TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS audits (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      patterns_json TEXT NOT NULL,
      source_kind TEXT,
      match_count INTEGER NOT NULL,
      matches_json TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      target_json TEXT NOT NULL,
      category TEXT NOT NULL,
      locations_json TEXT NOT NULL,
      state TEXT NOT NULL,
      severity TEXT,
      confidence REAL NOT NULL,
      proof_status TEXT NOT NULL,
      report_path TEXT,
      duplicate_of TEXT,
      superseded_by TEXT,
      related_json TEXT NOT NULL,
      primitives_json TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      memory_chunk_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_milestone_at TEXT
    )`,
    "CREATE INDEX IF NOT EXISTS idx_findings_kind ON findings(kind)",
    "CREATE INDEX IF NOT EXISTS idx_findings_state ON findings(state)",
    "CREATE INDEX IF NOT EXISTS idx_findings_category ON findings(category)",
    "CREATE INDEX IF NOT EXISTS idx_findings_updated ON findings(updated_at)",
    `CREATE TABLE IF NOT EXISTS finding_evidence (
      id TEXT PRIMARY KEY,
      finding_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      artifact TEXT,
      command TEXT,
      hash TEXT,
      metadata_json TEXT NOT NULL,
      memory_chunk_id TEXT,
      created_at TEXT NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_finding_evidence_finding ON finding_evidence(finding_id)",
    `CREATE TABLE IF NOT EXISTS finding_links (
      id TEXT PRIMARY KEY,
      finding_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(finding_id, relation, target_type, target_id)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_finding_links_finding ON finding_links(finding_id)",
    "CREATE INDEX IF NOT EXISTS idx_finding_links_target ON finding_links(target_type, target_id)",
    `CREATE TABLE IF NOT EXISTS finding_history (
      id TEXT PRIMARY KEY,
      finding_id TEXT NOT NULL,
      at TEXT NOT NULL,
      event TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT,
      note TEXT NOT NULL,
      actor TEXT,
      metadata_json TEXT NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_finding_history_finding ON finding_history(finding_id)",
  ];

  db.exec("BEGIN");
  try {
    for (const [index, statement] of statements.entries()) {
      if (process.env.CYBERMEM_DEBUG_SQLITE) console.error("[cybermem] ddl", index);
      db.exec(statement);
    }

    if (process.env.CYBERMEM_DEBUG_SQLITE) console.error("[cybermem] meta rows");
    setMeta(db, "schema_version", String(STORE_SCHEMA_VERSION));
    if (!getMeta(db, "created_at")) setMeta(db, "created_at", nowIso());
    setMeta(db, "package", "cybermem");
    for (const name of BUFFER_NAMES) {
      db.prepare("INSERT OR IGNORE INTO buffers (name, value_json, updated_at) VALUES (?, NULL, NULL)").run(name);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function getMeta(db, key) {
  return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

function setMeta(db, key, value) {
  db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function touchUpdated(db) {
  setMeta(db, "updated_at", nowIso());
}

function migrateLegacyJsonIfNeeded(db, cwd, options) {
  if (getMeta(db, "legacy_json_imported") === "true") return;
  const legacyPath = legacyJsonPathFor(cwd, options.dataDir);
  if (!existsSync(legacyPath)) {
    setMeta(db, "legacy_json_imported", "true");
    return;
  }
  let legacy;
  try {
    legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
  } catch {
    setMeta(db, "legacy_json_imported", "failed");
    return;
  }

  withTransaction(db, () => {
    for (const chunk of asArray(legacy.chunks)) {
      const normalized = {
        id: chunk.id,
        level: chunk.level,
        type: chunk.type,
        title: chunk.title,
        content: chunk.content,
        tags: chunk.tags,
        context: chunk.context,
        source: chunk.source,
        provenance: chunk.provenance,
        evidence: chunk.evidence,
        confidence: chunk.confidence,
        status: chunk.status,
        canonicalKey: chunk.canonicalKey,
      };
      const stored = {
        ...normalizeMemoryInput(normalized),
        id: chunk.id,
        utility: clampNumber(chunk.utility ?? 0, -5, 5, 0),
        accessCount: Number(chunk.accessCount ?? 0),
        reinforcementCount: Number(chunk.reinforcementCount ?? 0),
        createdAt: chunk.createdAt ?? nowIso(),
        updatedAt: chunk.updatedAt ?? chunk.createdAt ?? nowIso(),
        lastAccessedAt: chunk.lastAccessedAt ?? null,
        consolidatedAt: chunk.consolidatedAt ?? null,
      };
      saveChunk(db, stored);
    }
    for (const link of asArray(legacy.links)) {
      db.prepare(`
        INSERT OR IGNORE INTO links (id, src, relation, dst, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        link.id ?? `link_${randomUUID()}`,
        link.src,
        link.relation ?? "related",
        link.dst,
        jsonString(link.metadata ?? {}),
        link.createdAt ?? nowIso(),
      );
    }
    for (const [name, buffer] of Object.entries(legacy.buffers ?? {})) {
      if (!BUFFER_NAMES.includes(name)) continue;
      db.prepare(`
        INSERT INTO buffers (name, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(name, jsonString(buffer.value ?? null), buffer.updatedAt ?? null);
    }
    for (const production of asArray(legacy.productions)) {
      saveProduction(db, productionFromObject(production));
    }
    for (const trace of asArray(legacy.traces)) {
      saveTrace(db, trace);
    }
    for (const event of asArray(legacy.events)) {
      appendEvent(db, event);
    }
    for (const audit of asArray(legacy.audits)) {
      saveAudit(db, audit);
    }
    setMeta(db, "legacy_json_imported", "true");
    touchUpdated(db);
  });
}

function rowToChunk(row) {
  if (!row) return null;
  return {
    id: row.id,
    level: row.level,
    type: row.type,
    title: row.title,
    content: row.content,
    tags: jsonParse(row.tags_json, []),
    context: jsonParse(row.context_json, {}),
    source: jsonParse(row.source_json, {}),
    provenance: jsonParse(row.provenance_json, {}),
    evidence: jsonParse(row.evidence_json, []),
    confidence: row.confidence,
    utility: row.utility,
    status: row.status,
    canonicalKey: row.canonical_key,
    accessCount: row.access_count,
    reinforcementCount: row.reinforcement_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
    consolidatedAt: row.consolidated_at,
    embeddingModel: row.embedding_model,
    embedding: row.embedding,
  };
}

function rowToProduction(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    conditions: jsonParse(row.conditions_json, []),
    actions: jsonParse(row.actions_json, []),
    utility: row.utility,
    tags: jsonParse(row.tags_json, []),
    owner: row.owner,
    safetyScope: row.safety_scope,
    fireCount: row.fire_count,
    rewardHistory: jsonParse(row.reward_history_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastFiredAt: row.last_fired_at,
  };
}

function rowToTrace(row) {
  return {
    id: row.id,
    at: row.at,
    query: row.query,
    filters: jsonParse(row.filters_json, {}),
    selectedIds: jsonParse(row.selected_ids_json, []),
    candidates: jsonParse(row.candidates_json, []),
  };
}

function rowToAudit(row) {
  return {
    id: row.id,
    at: row.at,
    patterns: jsonParse(row.patterns_json, []),
    sourceKind: row.source_kind,
    matchCount: row.match_count,
    matches: jsonParse(row.matches_json, []),
  };
}

function rowToFinding(row, details = {}) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    target: jsonParse(row.target_json, {}),
    category: row.category,
    locations: jsonParse(row.locations_json, []),
    state: row.state,
    severity: row.severity,
    confidence: row.confidence,
    proofStatus: row.proof_status,
    reportPath: row.report_path,
    duplicateOf: row.duplicate_of,
    supersededBy: row.superseded_by,
    related: jsonParse(row.related_json, []),
    primitives: jsonParse(row.primitives_json, []),
    tags: jsonParse(row.tags_json, []),
    metadata: jsonParse(row.metadata_json, {}),
    memoryChunkId: row.memory_chunk_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMilestoneAt: row.last_milestone_at,
    ...details,
  };
}

function rowToFindingEvidence(row) {
  return {
    id: row.id,
    findingId: row.finding_id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    artifact: row.artifact,
    command: row.command,
    hash: row.hash,
    metadata: jsonParse(row.metadata_json, {}),
    memoryChunkId: row.memory_chunk_id,
    createdAt: row.created_at,
  };
}

function rowToFindingLink(row) {
  return {
    id: row.id,
    findingId: row.finding_id,
    relation: row.relation,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: jsonParse(row.metadata_json, {}),
    createdAt: row.created_at,
  };
}

function rowToFindingHistory(row) {
  return {
    id: row.id,
    findingId: row.finding_id,
    at: row.at,
    event: row.event,
    fromState: row.from_state,
    toState: row.to_state,
    note: row.note,
    actor: row.actor,
    metadata: jsonParse(row.metadata_json, {}),
  };
}

function allFindings(db) {
  return db.prepare("SELECT * FROM findings ORDER BY updated_at DESC").all().map((row) => rowToFinding(row));
}

function allChunks(db) {
  return db.prepare("SELECT * FROM chunks ORDER BY created_at ASC").all().map(rowToChunk);
}

function saveChunk(db, chunk) {
  const embedding = encodeEmbedding(embedText(chunkEmbeddingText(chunk)));
  db.prepare(`
    INSERT INTO chunks (
      id, level, type, title, content, tags_json, context_json, source_json,
      provenance_json, evidence_json, confidence, utility, status, canonical_key,
      access_count, reinforcement_count, created_at, updated_at, last_accessed_at,
      consolidated_at, embedding_model, embedding
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      level = excluded.level,
      type = excluded.type,
      title = excluded.title,
      content = excluded.content,
      tags_json = excluded.tags_json,
      context_json = excluded.context_json,
      source_json = excluded.source_json,
      provenance_json = excluded.provenance_json,
      evidence_json = excluded.evidence_json,
      confidence = excluded.confidence,
      utility = excluded.utility,
      status = excluded.status,
      canonical_key = excluded.canonical_key,
      access_count = excluded.access_count,
      reinforcement_count = excluded.reinforcement_count,
      updated_at = excluded.updated_at,
      last_accessed_at = excluded.last_accessed_at,
      consolidated_at = excluded.consolidated_at,
      embedding_model = excluded.embedding_model,
      embedding = excluded.embedding
  `).run(
    chunk.id,
    chunk.level,
    chunk.type,
    chunk.title,
    chunk.content,
    jsonString(chunk.tags ?? []),
    jsonString(chunk.context ?? {}),
    jsonString(chunk.source ?? {}),
    jsonString(chunk.provenance ?? {}),
    jsonString(chunk.evidence ?? []),
    chunk.confidence,
    chunk.utility,
    chunk.status,
    chunk.canonicalKey,
    Number(chunk.accessCount ?? 0),
    Number(chunk.reinforcementCount ?? 0),
    chunk.createdAt,
    chunk.updatedAt,
    chunk.lastAccessedAt,
    chunk.consolidatedAt,
    EMBEDDING_MODEL,
    embedding,
  );
  syncSearchIndexes(db, chunk);
}

function syncSearchIndexes(db, chunk) {
  // Reserved for future auxiliary search indexes. Retrieval currently uses
  // indexed SQLite rows plus stored local embeddings to stay dependency-free.
  void db;
  void chunk;
}

function deleteChunk(db, id) {
  db.prepare("DELETE FROM chunks WHERE id = ?").run(id);
  db.prepare("DELETE FROM links WHERE src = ? OR dst = ?").run(id, id);
}

function saveProduction(db, production) {
  db.prepare(`
    INSERT INTO productions (
      id, name, description, conditions_json, actions_json, utility, tags_json,
      owner, safety_scope, fire_count, reward_history_json, created_at, updated_at,
      last_fired_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      conditions_json = excluded.conditions_json,
      actions_json = excluded.actions_json,
      utility = excluded.utility,
      tags_json = excluded.tags_json,
      owner = excluded.owner,
      safety_scope = excluded.safety_scope,
      fire_count = excluded.fire_count,
      reward_history_json = excluded.reward_history_json,
      updated_at = excluded.updated_at,
      last_fired_at = excluded.last_fired_at
  `).run(
    production.id,
    production.name,
    production.description,
    jsonString(production.conditions ?? []),
    jsonString(production.actions ?? []),
    production.utility,
    jsonString(production.tags ?? []),
    production.owner,
    production.safetyScope,
    Number(production.fireCount ?? 0),
    jsonString(production.rewardHistory ?? []),
    production.createdAt,
    production.updatedAt,
    production.lastFiredAt,
  );
}

function productionFromObject(input) {
  const name = String(input.name ?? input.id ?? "").trim();
  const id = input.id ? String(input.id) : `prod_${stableHash(name).slice(0, 16)}`;
  const ts = nowIso();
  return {
    id,
    name,
    description: truncateText(input.description ?? "", 1000),
    conditions: asArray(input.conditions),
    actions: asArray(input.actions),
    utility: clampNumber(input.utility ?? 0, -5, 5, 0),
    tags: normalizeTags(input.tags),
    owner: input.owner ?? null,
    safetyScope: input.safetyScope ?? input.safety_scope ?? null,
    fireCount: Number(input.fireCount ?? input.fire_count ?? 0),
    rewardHistory: asArray(input.rewardHistory ?? input.reward_history),
    createdAt: input.createdAt ?? input.created_at ?? ts,
    updatedAt: input.updatedAt ?? input.updated_at ?? ts,
    lastFiredAt: input.lastFiredAt ?? input.last_fired_at ?? null,
  };
}

function saveTrace(db, trace) {
  db.prepare(`
    INSERT OR REPLACE INTO traces (id, at, query, filters_json, selected_ids_json, candidates_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    trace.id,
    trace.at,
    trace.query ?? "",
    jsonString(trace.filters ?? {}),
    jsonString(trace.selectedIds ?? []),
    jsonString(trace.candidates ?? []),
  );
  db.prepare(`
    DELETE FROM traces
    WHERE rowid NOT IN (SELECT rowid FROM traces ORDER BY at DESC LIMIT ?)
  `).run(MAX_TRACES);
}

function saveAudit(db, audit) {
  db.prepare(`
    INSERT OR REPLACE INTO audits (id, at, patterns_json, source_kind, match_count, matches_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    audit.id,
    audit.at,
    jsonString(audit.patterns ?? []),
    audit.sourceKind ?? audit.source_kind ?? null,
    Number(audit.matchCount ?? audit.match_count ?? 0),
    jsonString(audit.matches ?? []),
  );
}

function appendEvent(db, event) {
  const type = event.type ?? "event";
  const data = { ...event };
  delete data.id;
  delete data.at;
  delete data.type;
  db.prepare("INSERT INTO events (id, at, type, data_json) VALUES (?, ?, ?, ?)").run(
    event.id ?? `evt_${randomUUID()}`,
    event.at ?? nowIso(),
    type,
    jsonString(data),
  );
  db.prepare(`
    DELETE FROM events
    WHERE rowid NOT IN (SELECT rowid FROM events ORDER BY at DESC LIMIT ?)
  `).run(MAX_EVENTS);
}

export async function readStore(cwd, options = {}) {
  return withDatabase(cwd, (db) => ({
    schemaVersion: STORE_SCHEMA_VERSION,
    package: getMeta(db, "package") ?? "cybermem",
    createdAt: getMeta(db, "created_at"),
    updatedAt: getMeta(db, "updated_at") ?? getMeta(db, "created_at"),
    path: storePathFor(cwd, options.dataDir),
    chunks: allChunks(db),
    links: db.prepare("SELECT * FROM links ORDER BY created_at ASC").all().map((row) => ({
      id: row.id,
      src: row.src,
      relation: row.relation,
      dst: row.dst,
      metadata: jsonParse(row.metadata_json, {}),
      createdAt: row.created_at,
    })),
    buffers: readBuffersFromDb(db),
    productions: db.prepare("SELECT * FROM productions ORDER BY created_at ASC").all().map(rowToProduction),
    traces: db.prepare("SELECT * FROM traces ORDER BY at ASC").all().map(rowToTrace),
    events: db.prepare("SELECT * FROM events ORDER BY at ASC").all().map((row) => ({
      id: row.id,
      at: row.at,
      type: row.type,
      ...jsonParse(row.data_json, {}),
    })),
    audits: db.prepare("SELECT * FROM audits ORDER BY at ASC").all().map(rowToAudit),
    findings: allFindings(db),
    findingEvidence: db.prepare("SELECT * FROM finding_evidence ORDER BY created_at ASC").all().map(rowToFindingEvidence),
    findingLinks: db.prepare("SELECT * FROM finding_links ORDER BY created_at ASC").all().map(rowToFindingLink),
    findingHistory: db.prepare("SELECT * FROM finding_history ORDER BY at ASC").all().map(rowToFindingHistory),
  }), options);
}

function readBuffersFromDb(db) {
  const buffers = emptyBuffers();
  for (const row of db.prepare("SELECT * FROM buffers").all()) {
    buffers[row.name] = {
      name: row.name,
      value: jsonParse(row.value_json, null),
      updatedAt: row.updated_at,
    };
  }
  return buffers;
}

function canonicalMemoryKey(input) {
  if (input.canonicalKey) return String(input.canonicalKey);
  const level = input.level ?? "episodic";
  const type = input.type ?? "observation";
  const title = String(input.title ?? "").trim().toLowerCase();
  const content = String(input.content ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return stableHash(`${level}\n${type}\n${title}\n${content.slice(0, 4000)}`);
}

function inferTitle(content) {
  const text = String(content ?? "").trim().replace(/\s+/g, " ");
  return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
}

function normalizeMemoryInput(input) {
  if (!input || typeof input !== "object") {
    throw new Error("memory input must be an object");
  }
  const level = input.level ?? "episodic";
  if (!MEMORY_LEVELS.includes(level)) {
    throw new Error(`Invalid memory level '${level}'. Expected one of: ${MEMORY_LEVELS.join(", ")}`);
  }
  const content = truncateText(input.content ?? "");
  if (!content.trim()) throw new Error("content is required");
  const title = truncateText(input.title ?? inferTitle(content), 240);
  const type = truncateText(input.type ?? "observation", 80);
  const tags = normalizeTags(input.tags);
  const context = input.context && typeof input.context === "object" ? input.context : {};
  const source = input.source && typeof input.source === "object" ? input.source : {};
  const provenance = input.provenance && typeof input.provenance === "object" ? input.provenance : {};
  const evidence = asArray(input.evidence).map((item) => truncateText(item, 4000));
  const confidence = clampNumber(input.confidence ?? 0.6, 0, 1, 0.6);
  const status = truncateText(input.status ?? "active", 40);
  return {
    level,
    type,
    title,
    content,
    tags,
    context,
    source,
    provenance,
    evidence,
    confidence,
    status,
    canonicalKey: canonicalMemoryKey({ ...input, level, type, title, content }),
  };
}

function jaccard(a, b) {
  const aSet = new Set(tokenize(a));
  const bSet = new Set(tokenize(b));
  if (aSet.size === 0 && bSet.size === 0) return 1;
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) intersection += 1;
  }
  return intersection / (aSet.size + bSet.size - intersection);
}

function mergeObjects(left, right) {
  return {
    ...(left && typeof left === "object" ? left : {}),
    ...(right && typeof right === "object" ? right : {}),
  };
}

function mergeArray(left, right, limit = 50) {
  const values = [...asArray(left), ...asArray(right)];
  const seen = new Set();
  const merged = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(value);
    if (merged.length >= limit) break;
  }
  return merged;
}

function findDuplicate(db, normalized) {
  const exactRow = db.prepare("SELECT * FROM chunks WHERE canonical_key = ?").get(normalized.canonicalKey);
  if (exactRow) return { chunk: rowToChunk(exactRow), reason: "canonical" };
  const near = allChunks(db).find((chunk) => {
    if (chunk.level !== normalized.level || chunk.type !== normalized.type) return false;
    return jaccard(`${chunk.title}\n${chunk.content}`, `${normalized.title}\n${normalized.content}`) >= 0.92;
  });
  return near ? { chunk: near, reason: "near-duplicate" } : null;
}

export async function rememberMemory(cwd, input, options = {}) {
  const normalized = normalizeMemoryInput(input);
  return withDatabase(cwd, (db) => withTransaction(db, () => {
    const duplicate = findDuplicate(db, normalized);
    const ts = nowIso();
    if (duplicate) {
      const chunk = duplicate.chunk;
      chunk.title = chunk.title || normalized.title;
      chunk.content = chunk.content.length >= normalized.content.length ? chunk.content : normalized.content;
      chunk.tags = normalizeTags([...asArray(chunk.tags), ...normalized.tags]);
      chunk.context = mergeObjects(chunk.context, normalized.context);
      chunk.source = mergeObjects(chunk.source, normalized.source);
      chunk.provenance = mergeObjects(chunk.provenance, normalized.provenance);
      chunk.evidence = mergeArray(chunk.evidence, normalized.evidence);
      chunk.confidence = Math.max(Number(chunk.confidence ?? 0), normalized.confidence);
      chunk.accessCount = Number(chunk.accessCount ?? 0) + 1;
      chunk.reinforcementCount = Number(chunk.reinforcementCount ?? 0) + 1;
      chunk.updatedAt = ts;
      chunk.lastAccessedAt = ts;
      saveChunk(db, chunk);
      appendEvent(db, {
        type: "memory_strengthened",
        chunkId: chunk.id,
        level: chunk.level,
        reason: duplicate.reason,
      });
      touchUpdated(db);
      return {
        created: false,
        strengthened: true,
        duplicateReason: duplicate.reason,
        chunk: publicChunk(chunk),
      };
    }

    const chunk = {
      id: input.id ? String(input.id) : `mem_${stableHash(`${normalized.canonicalKey}\n${ts}`).slice(0, 16)}`,
      ...normalized,
      utility: clampNumber(input.utility ?? 0, -5, 5, 0),
      accessCount: 0,
      reinforcementCount: 0,
      createdAt: ts,
      updatedAt: ts,
      lastAccessedAt: null,
      consolidatedAt: null,
    };
    saveChunk(db, chunk);
    appendEvent(db, {
      type: "memory_created",
      chunkId: chunk.id,
      level: chunk.level,
      memoryType: chunk.type,
      tags: chunk.tags,
    });
    touchUpdated(db);
    return {
      created: true,
      strengthened: false,
      chunk: publicChunk(chunk),
    };
  }), options);
}

function bufferCorpus(buffers) {
  return Object.values(buffers ?? {})
    .map((buffer) => JSON.stringify(buffer?.value ?? ""))
    .join("\n");
}

function requestedLevelSet(params) {
  const levels = [...asArray(params.level), ...asArray(params.levels)].filter(Boolean);
  if (levels.length === 0) return null;
  const normalized = new Set();
  for (const level of levels) {
    if (!MEMORY_LEVELS.includes(level)) {
      throw new Error(`Invalid memory level '${level}'. Expected one of: ${MEMORY_LEVELS.join(", ")}`);
    }
    normalized.add(level);
  }
  return normalized;
}

function candidateRows(db, params, levels) {
  const clauses = [];
  const values = [];
  if (levels) {
    clauses.push(`level IN (${[...levels].map(() => "?").join(", ")})`);
    values.push(...levels);
  }
  if (params.type) {
    clauses.push("type = ?");
    values.push(params.type);
  }
  if (params.status) {
    clauses.push("status = ?");
    values.push(params.status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM chunks ${where} ORDER BY updated_at DESC LIMIT 2000`).all(...values);
}

function candidateChunks(db, params, levels) {
  const requestedTags = normalizeTags(params.tags);
  return candidateRows(db, params, levels)
    .map((row) => ({ chunk: rowToChunk(row) }))
    .filter((item) => {
      if (requestedTags.length === 0) return true;
      const chunkTags = new Set(normalizeTags(item.chunk.tags));
      return requestedTags.some((tag) => chunkTags.has(tag));
    });
}

function scoreChunk(chunk, params, buffers, queryEmbedding) {
  const queryTokens = new Set(tokenize(params.query));
  const bufferTokens = new Set(tokenize(bufferCorpus(buffers)));
  const docText = [
    chunk.title,
    chunk.content,
    chunk.type,
    ...(chunk.tags ?? []),
    JSON.stringify(chunk.context ?? {}),
  ].join("\n");
  const docTokens = new Set(tokenize(docText));
  let queryOverlap = 0;
  for (const token of queryTokens) {
    if (docTokens.has(token)) queryOverlap += 1;
  }
  let bufferOverlap = 0;
  for (const token of bufferTokens) {
    if (docTokens.has(token)) bufferOverlap += 1;
  }

  const semanticMatch =
    queryTokens.size === 0
      ? 0
      : queryOverlap / Math.sqrt(Math.max(1, queryTokens.size * docTokens.size));
  const titleBoost = [...queryTokens].some((token) => tokenize(chunk.title).includes(token)) ? 0.15 : 0;
  const requestedTags = normalizeTags(params.tags);
  const chunkTags = new Set(normalizeTags(chunk.tags));
  const tagHits = requestedTags.filter((tag) => chunkTags.has(tag)).length;
  const tagMatch = requestedTags.length === 0 ? 0 : tagHits / requestedTags.length;
  const contextSpread =
    bufferTokens.size === 0
      ? 0
      : Math.min(0.5, bufferOverlap / Math.sqrt(Math.max(1, bufferTokens.size * docTokens.size)));

  const embeddingMatch = Math.max(0, cosineSimilarity(queryEmbedding, decodeEmbedding(chunk.embedding)));
  const ageDays = Math.max(0, (Date.now() - Date.parse(chunk.updatedAt ?? chunk.createdAt ?? nowIso())) / 86_400_000);
  const accessCount = Number(chunk.accessCount ?? 0);
  const reinforcementCount = Number(chunk.reinforcementCount ?? 0);
  const baseLevel = Math.log1p(accessCount + reinforcementCount) * 0.14 + 0.35 / (1 + ageDays / 14);
  const confidence = clampNumber(chunk.confidence ?? 0.5, 0, 1, 0.5) * 0.18;
  const utility = clampNumber(chunk.utility ?? 0, -5, 5, 0) * 0.08;
  const sourceQuality = clampNumber(chunk.source?.quality ?? chunk.provenance?.quality ?? 0, -1, 1, 0) * 0.1;
  const stalenessPenalty = ageDays > 180 ? Math.min(0.4, (ageDays - 180) / 900) : 0;
  const conflictPenalty = ["rejected", "superseded", "unsafe"].includes(chunk.status) ? 0.35 : 0;

  const total =
    semanticMatch +
    titleBoost +
    embeddingMatch * 0.55 +
    tagMatch * 0.35 +
    contextSpread +
    baseLevel +
    confidence +
    utility +
    sourceQuality -
    stalenessPenalty -
    conflictPenalty;

  return {
    total,
    components: {
      semanticMatch,
      titleBoost,
      embeddingMatch,
      tagMatch,
      contextSpread,
      baseLevel,
      confidence,
      utility,
      sourceQuality,
      stalenessPenalty,
      conflictPenalty,
    },
    matchedTokens: [...queryTokens].filter((token) => docTokens.has(token)).slice(0, 30),
  };
}

export async function retrieveMemories(cwd, params = {}, options = {}) {
  const topK = clampNumber(params.topK ?? params.k ?? 5, 1, 20, 5);
  const levels = requestedLevelSet(params);
  const explain = params.explain ?? true;
  return withDatabase(cwd, (db) => withTransaction(db, () => {
    const buffers = readBuffersFromDb(db);
    const queryEmbedding = embedText([params.query ?? "", bufferCorpus(buffers)].join("\n"));
    const scored = candidateChunks(db, params, levels)
      .map((item) => ({
        chunk: item.chunk,
        ...scoreChunk(item.chunk, params, buffers, queryEmbedding),
      }))
      .sort((left, right) => right.total - left.total);
    const selected = scored.slice(0, topK);
    const ts = nowIso();
    for (const item of selected) {
      item.chunk.accessCount = Number(item.chunk.accessCount ?? 0) + 1;
      item.chunk.lastAccessedAt = ts;
      saveChunk(db, item.chunk);
    }

    const requestedTags = normalizeTags(params.tags);
    const trace = {
      id: `trace_${randomUUID()}`,
      at: ts,
      query: params.query ?? "",
      filters: {
        levels: levels ? [...levels] : null,
        tags: requestedTags,
        type: params.type ?? null,
        status: params.status ?? null,
        retrieval: "sqlite-indexed-rows-plus-hash-embedding",
        embeddingModel: EMBEDDING_MODEL,
      },
      selectedIds: selected.map((item) => item.chunk.id),
      candidates: scored.slice(0, Math.max(topK, 10)).map((item) => ({
        chunkId: item.chunk.id,
        title: item.chunk.title,
        level: item.chunk.level,
        type: item.chunk.type,
        score: round(item.total),
        components: Object.fromEntries(
          Object.entries(item.components).map(([key, value]) => [key, round(value)]),
        ),
        matchedTokens: item.matchedTokens,
      })),
    };
    saveTrace(db, trace);
    setBufferInDb(db, "retrieval", {
      traceId: trace.id,
      query: params.query ?? "",
      hits: selected.map((item) => ({
        id: item.chunk.id,
        level: item.chunk.level,
        type: item.chunk.type,
        title: item.chunk.title,
        score: round(item.total),
      })),
    }, ts);

    appendEvent(db, {
      type: "memory_retrieved",
      traceId: trace.id,
      query: params.query ?? "",
      hitCount: selected.length,
    });
    touchUpdated(db);

    return {
      traceId: trace.id,
      hits: selected.map((item) => ({
        score: round(item.total),
        components: explain
          ? Object.fromEntries(Object.entries(item.components).map(([key, value]) => [key, round(value)]))
          : undefined,
        matchedTokens: explain ? item.matchedTokens : undefined,
        chunk: publicChunk(item.chunk),
      })),
    };
  }), options);
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

export function publicChunk(chunk) {
  return {
    id: chunk.id,
    level: chunk.level,
    type: chunk.type,
    title: chunk.title,
    content: chunk.content,
    tags: chunk.tags ?? [],
    context: chunk.context ?? {},
    source: chunk.source ?? {},
    provenance: chunk.provenance ?? {},
    evidence: chunk.evidence ?? [],
    confidence: chunk.confidence,
    utility: chunk.utility,
    status: chunk.status,
    accessCount: chunk.accessCount ?? 0,
    reinforcementCount: chunk.reinforcementCount ?? 0,
    createdAt: chunk.createdAt,
    updatedAt: chunk.updatedAt,
    lastAccessedAt: chunk.lastAccessedAt,
    consolidatedAt: chunk.consolidatedAt,
    embeddingModel: chunk.embeddingModel ?? EMBEDDING_MODEL,
  };
}

function normalizeFindingKind(kind = "primitive") {
  if (!FINDING_TYPES.includes(kind)) {
    throw new Error(`Invalid finding kind '${kind}'. Expected one of: ${FINDING_TYPES.join(", ")}`);
  }
  return kind;
}

function normalizeFindingState(state = "discovered") {
  if (!FINDING_STATES.includes(state)) {
    throw new Error(`Invalid finding state '${state}'. Expected one of: ${FINDING_STATES.join(", ")}`);
  }
  return state;
}

function normalizeTarget(target) {
  if (target && typeof target === "object") return target;
  if (target === undefined || target === null || target === "") return {};
  return { name: String(target) };
}

function nextFindingId(db, kind) {
  const prefix = kind === "chain" ? "C" : "P";
  let highest = 0;
  for (const row of db.prepare("SELECT id FROM findings WHERE kind = ?").all(kind)) {
    const match = String(row.id).match(new RegExp(`^${prefix}-(\\d{4})$`, "i"));
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}-${String(highest + 1).padStart(4, "0")}`;
}

function findingSearchText(finding) {
  return [
    finding.id,
    finding.kind,
    finding.title,
    finding.summary,
    finding.category,
    finding.state,
    finding.proofStatus,
    JSON.stringify(finding.target ?? {}),
    ...(finding.locations ?? []),
    ...(finding.related ?? []),
    ...(finding.primitives ?? []),
    ...(finding.tags ?? []),
  ].join("\n");
}

function findingMemoryContent(finding) {
  return [
    `Finding: ${finding.id}`,
    `Kind: ${finding.kind}`,
    `State: ${finding.state}`,
    `Proof status: ${finding.proofStatus}`,
    `Category: ${finding.category}`,
    `Target: ${JSON.stringify(finding.target ?? {})}`,
    `Locations: ${(finding.locations ?? []).join(", ") || "none"}`,
    `Severity: ${finding.severity ?? "unspecified"}`,
    `Confidence: ${finding.confidence}`,
    finding.duplicateOf ? `Duplicate of: ${finding.duplicateOf}` : null,
    finding.supersededBy ? `Superseded by: ${finding.supersededBy}` : null,
    finding.reportPath ? `Report: ${finding.reportPath}` : null,
    "",
    finding.summary,
  ].filter((line) => line !== null).join("\n");
}

function normalizeFindingInput(input = {}, existing = null) {
  const kind = normalizeFindingKind(input.kind ?? input.type ?? existing?.kind ?? "primitive");
  const state = normalizeFindingState(input.state ?? existing?.state ?? "discovered");
  const title = truncateText(input.title ?? existing?.title ?? "", 300);
  const summary = truncateText(input.summary ?? input.content ?? existing?.summary ?? "", MAX_TEXT_FIELD);
  if (!title.trim()) throw new Error("finding title is required");
  if (!summary.trim()) throw new Error("finding summary is required");
  return {
    id: input.id ? String(input.id) : existing?.id ?? null,
    kind,
    title,
    summary,
    target: normalizeTarget(input.target ?? existing?.target),
    category: truncateText(input.category ?? input.bugClass ?? existing?.category ?? "uncategorized", 120),
    locations: mergeArray(existing?.locations ?? [], asArray(input.locations ?? input.location), 100),
    state,
    severity: input.severity ?? existing?.severity ?? null,
    confidence: clampNumber(input.confidence ?? existing?.confidence ?? 0.4, 0, 1, 0.4),
    proofStatus: truncateText(input.proofStatus ?? input.proof_status ?? existing?.proofStatus ?? "none", 80),
    reportPath: input.reportPath ?? input.report_path ?? existing?.reportPath ?? null,
    duplicateOf: input.duplicateOf ?? input.duplicate_of ?? existing?.duplicateOf ?? null,
    supersededBy: input.supersededBy ?? input.superseded_by ?? existing?.supersededBy ?? null,
    related: mergeArray(existing?.related ?? [], asArray(input.related), 100),
    primitives: mergeArray(existing?.primitives ?? [], asArray(input.primitives ?? input.primitive), 100),
    tags: normalizeTags([
      ...(existing?.tags ?? []),
      ...asArray(input.tags),
      "finding",
      kind,
      state,
      input.category ?? input.bugClass ?? existing?.category ?? "uncategorized",
    ]),
    metadata: mergeObjects(existing?.metadata ?? {}, input.metadata ?? {}),
    memoryChunkId: existing?.memoryChunkId ?? input.memoryChunkId ?? input.memory_chunk_id ?? null,
    createdAt: existing?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    lastMilestoneAt: existing?.lastMilestoneAt ?? null,
  };
}

function likelyFindingDuplicates(db, finding, limit = 5) {
  const queryTokens = new Set(tokenize(findingSearchText(finding)));
  if (queryTokens.size === 0) return [];
  const rows = db.prepare("SELECT * FROM findings WHERE kind = ?").all(finding.kind);
  const results = [];
  for (const row of rows) {
    const candidate = rowToFinding(row);
    if (candidate.id === finding.id) continue;
    const candidateTokens = new Set(tokenize(findingSearchText(candidate)));
    let overlap = 0;
    for (const token of queryTokens) {
      if (candidateTokens.has(token)) overlap += 1;
    }
    if (overlap > 0) {
      results.push({
        score: overlap,
        finding: candidate,
      });
    }
  }
  return results.sort((left, right) => right.score - left.score).slice(0, limit);
}

function saveFindingMemory(db, finding) {
  const existingChunk = finding.memoryChunkId
    ? rowToChunk(db.prepare("SELECT * FROM chunks WHERE id = ?").get(finding.memoryChunkId))
    : null;
  const chunk = {
    id: existingChunk?.id ?? `mem_${stableHash(`finding:${finding.id}`).slice(0, 16)}`,
    level: "episodic",
    type: "finding",
    title: `${finding.id} ${finding.title}`,
    content: findingMemoryContent(finding),
    tags: finding.tags,
    context: {
      findingId: finding.id,
      findingKind: finding.kind,
      state: finding.state,
      category: finding.category,
      target: finding.target,
      locations: finding.locations,
    },
    source: {
      kind: "finding-ledger",
      findingId: finding.id,
      findingKind: finding.kind,
    },
    provenance: {
      generatedBy: "cybermem.finding",
      updatedAt: finding.updatedAt,
    },
    evidence: [],
    confidence: finding.confidence,
    utility: existingChunk?.utility ?? 0,
    status: TERMINAL_FINDING_STATES.includes(finding.state) ? "superseded" : "active",
    canonicalKey: `finding:${finding.id}`,
    accessCount: existingChunk?.accessCount ?? 0,
    reinforcementCount: existingChunk?.reinforcementCount ?? 0,
    createdAt: existingChunk?.createdAt ?? finding.createdAt,
    updatedAt: finding.updatedAt,
    lastAccessedAt: existingChunk?.lastAccessedAt ?? null,
    consolidatedAt: existingChunk?.consolidatedAt ?? null,
  };
  saveChunk(db, chunk);
  return chunk.id;
}

function saveFinding(db, finding) {
  db.prepare(`
    INSERT INTO findings (
      id, kind, title, summary, target_json, category, locations_json, state,
      severity, confidence, proof_status, report_path, duplicate_of,
      superseded_by, related_json, primitives_json, tags_json, metadata_json,
      memory_chunk_id, created_at, updated_at, last_milestone_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      title = excluded.title,
      summary = excluded.summary,
      target_json = excluded.target_json,
      category = excluded.category,
      locations_json = excluded.locations_json,
      state = excluded.state,
      severity = excluded.severity,
      confidence = excluded.confidence,
      proof_status = excluded.proof_status,
      report_path = excluded.report_path,
      duplicate_of = excluded.duplicate_of,
      superseded_by = excluded.superseded_by,
      related_json = excluded.related_json,
      primitives_json = excluded.primitives_json,
      tags_json = excluded.tags_json,
      metadata_json = excluded.metadata_json,
      memory_chunk_id = excluded.memory_chunk_id,
      updated_at = excluded.updated_at,
      last_milestone_at = excluded.last_milestone_at
  `).run(
    finding.id,
    finding.kind,
    finding.title,
    finding.summary,
    jsonString(finding.target),
    finding.category,
    jsonString(finding.locations),
    finding.state,
    finding.severity,
    finding.confidence,
    finding.proofStatus,
    finding.reportPath,
    finding.duplicateOf,
    finding.supersededBy,
    jsonString(finding.related),
    jsonString(finding.primitives),
    jsonString(finding.tags),
    jsonString(finding.metadata),
    finding.memoryChunkId,
    finding.createdAt,
    finding.updatedAt,
    finding.lastMilestoneAt,
  );
}

function appendFindingHistory(db, input) {
  const entry = {
    id: `fh_${randomUUID()}`,
    at: input.at ?? nowIso(),
    findingId: input.findingId,
    event: input.event,
    fromState: input.fromState ?? null,
    toState: input.toState ?? null,
    note: truncateText(input.note ?? "", 4000),
    actor: input.actor ?? null,
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
  };
  db.prepare(`
    INSERT INTO finding_history (id, finding_id, at, event, from_state, to_state, note, actor, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.id,
    entry.findingId,
    entry.at,
    entry.event,
    entry.fromState,
    entry.toState,
    entry.note,
    entry.actor,
    jsonString(entry.metadata),
  );
  return entry;
}

function findingDetails(db, finding) {
  const evidence = db.prepare("SELECT * FROM finding_evidence WHERE finding_id = ? ORDER BY created_at ASC")
    .all(finding.id)
    .map(rowToFindingEvidence);
  const links = db.prepare("SELECT * FROM finding_links WHERE finding_id = ? ORDER BY created_at ASC")
    .all(finding.id)
    .map(rowToFindingLink);
  const history = db.prepare("SELECT * FROM finding_history WHERE finding_id = ? ORDER BY at ASC")
    .all(finding.id)
    .map(rowToFindingHistory);
  return rowToFinding(findingToRow(finding), { evidence, links, history });
}

function findingToRow(finding) {
  return {
    id: finding.id,
    kind: finding.kind,
    title: finding.title,
    summary: finding.summary,
    target_json: jsonString(finding.target),
    category: finding.category,
    locations_json: jsonString(finding.locations),
    state: finding.state,
    severity: finding.severity,
    confidence: finding.confidence,
    proof_status: finding.proofStatus,
    report_path: finding.reportPath,
    duplicate_of: finding.duplicateOf,
    superseded_by: finding.supersededBy,
    related_json: jsonString(finding.related),
    primitives_json: jsonString(finding.primitives),
    tags_json: jsonString(finding.tags),
    metadata_json: jsonString(finding.metadata),
    memory_chunk_id: finding.memoryChunkId,
    created_at: finding.createdAt,
    updated_at: finding.updatedAt,
    last_milestone_at: finding.lastMilestoneAt,
  };
}

export async function upsertFinding(cwd, input = {}, options = {}) {
  return withDatabase(cwd, (db) => withTransaction(db, () => {
    const existingRow = input.id ? db.prepare("SELECT * FROM findings WHERE id = ?").get(String(input.id)) : null;
    const existing = existingRow ? rowToFinding(existingRow) : null;
    const finding = normalizeFindingInput(input, existing);
    finding.id = finding.id ?? nextFindingId(db, finding.kind);

    const duplicates = existing || input.allowDuplicate
      ? []
      : likelyFindingDuplicates(db, finding, 5).filter((item) => item.score >= 4);
    if (duplicates.length > 0) {
      return {
        created: false,
        duplicateBlocked: true,
        candidates: duplicates.map((item) => ({ score: item.score, finding: item.finding })),
      };
    }

    const oldState = existing?.state ?? null;
    finding.memoryChunkId = saveFindingMemory(db, finding);
    saveFinding(db, finding);
    appendFindingHistory(db, {
      findingId: finding.id,
      event: existing ? "updated" : "created",
      fromState: oldState,
      toState: finding.state,
      note: input.note ?? (existing ? "Finding updated." : "Finding created."),
      actor: input.actor,
      metadata: { source: "upsertFinding" },
    });
    appendEvent(db, {
      type: existing ? "finding_updated" : "finding_created",
      findingId: finding.id,
      findingKind: finding.kind,
      state: finding.state,
      memoryChunkId: finding.memoryChunkId,
    });
    touchUpdated(db);
    return {
      created: !existing,
      duplicateBlocked: false,
      finding: getFindingById(db, finding.id, true),
    };
  }), options);
}

function getFindingById(db, id, includeDetails = true) {
  const row = db.prepare("SELECT * FROM findings WHERE id = ?").get(String(id));
  if (!row) throw new Error(`Finding not found: ${id}`);
  const finding = rowToFinding(row);
  return includeDetails ? findingDetails(db, finding) : finding;
}

export async function getFinding(cwd, id, options = {}) {
  return withDatabase(cwd, (db) => getFindingById(db, id, true), options);
}

export async function listFindings(cwd, params = {}, options = {}) {
  return withDatabase(cwd, (db) => {
    const clauses = [];
    const values = [];
    if (params.kind || params.type) {
      clauses.push("kind = ?");
      values.push(normalizeFindingKind(params.kind ?? params.type));
    }
    if (params.state) {
      clauses.push("state = ?");
      values.push(normalizeFindingState(params.state));
    }
    if (params.active) {
      clauses.push(`state NOT IN (${TERMINAL_FINDING_STATES.map(() => "?").join(", ")})`);
      values.push(...TERMINAL_FINDING_STATES);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = clampNumber(params.limit ?? 50, 1, 500, 50);
    const findings = db.prepare(`SELECT * FROM findings ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...values, limit)
      .map((row) => rowToFinding(row));
    return { findings, count: findings.length };
  }, options);
}

export async function searchFindings(cwd, params = {}, options = {}) {
  return withDatabase(cwd, (db) => {
    const query = [
      params.query,
      params.title,
      params.target,
      params.category,
      params.location,
      params.evidence,
      params.state,
    ].join(" ");
    const queryTokens = new Set(tokenize(query));
    const kind = params.kind || params.type ? normalizeFindingKind(params.kind ?? params.type) : null;
    const rows = kind
      ? db.prepare("SELECT * FROM findings WHERE kind = ?").all(kind)
      : db.prepare("SELECT * FROM findings").all();
    const results = [];
    for (const row of rows) {
      const finding = rowToFinding(row);
      const findingTokens = new Set(tokenize(findingSearchText(finding)));
      let overlap = 0;
      for (const token of queryTokens) {
        if (findingTokens.has(token)) overlap += 1;
      }
      if (overlap > 0 || queryTokens.size === 0) {
        results.push({ score: overlap, finding });
      }
    }
    const limit = clampNumber(params.limit ?? 10, 1, 100, 10);
    results.sort((left, right) => right.score - left.score || right.finding.updatedAt.localeCompare(left.finding.updatedAt));
    return { results: results.slice(0, limit) };
  }, options);
}

export async function addFindingEvidence(cwd, input = {}, options = {}) {
  if (!input.findingId) throw new Error("findingId is required");
  return withDatabase(cwd, (db) => withTransaction(db, () => {
    const finding = getFindingById(db, input.findingId, false);
    const ts = nowIso();
    const evidence = {
      id: input.id ? String(input.id) : `fe_${randomUUID()}`,
      findingId: finding.id,
      kind: truncateText(input.kind ?? "evidence", 80),
      title: truncateText(input.title ?? `${finding.id} evidence`, 240),
      content: truncateText(input.content ?? input.summary ?? "", MAX_TEXT_FIELD),
      artifact: input.artifact ?? input.path ?? null,
      command: input.command ?? null,
      hash: input.hash ?? input.sha256 ?? null,
      metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
      createdAt: ts,
    };
    if (!evidence.content.trim() && !evidence.artifact) {
      throw new Error("evidence content or artifact is required");
    }
    const existingChunk = input.memoryChunkId
      ? rowToChunk(db.prepare("SELECT * FROM chunks WHERE id = ?").get(input.memoryChunkId))
      : null;
    const chunk = {
      id: existingChunk?.id ?? `mem_${stableHash(`finding-evidence:${evidence.id}`).slice(0, 16)}`,
      level: "episodic",
      type: "finding-evidence",
      title: `${finding.id} evidence: ${evidence.title}`,
      content: [
        `Evidence for finding: ${finding.id}`,
        `Kind: ${evidence.kind}`,
        evidence.artifact ? `Artifact: ${evidence.artifact}` : null,
        evidence.command ? `Command: ${evidence.command}` : null,
        evidence.hash ? `Hash: ${evidence.hash}` : null,
        "",
        evidence.content,
      ].filter((line) => line !== null).join("\n"),
      tags: normalizeTags([...finding.tags, "finding-evidence", evidence.kind]),
      context: {
        findingId: finding.id,
        evidenceId: evidence.id,
        findingKind: finding.kind,
        state: finding.state,
      },
      source: {
        kind: "finding-ledger",
        findingId: finding.id,
        evidenceId: evidence.id,
      },
      provenance: {
        generatedBy: "cybermem.finding.evidence",
        artifact: evidence.artifact,
        hash: evidence.hash,
      },
      evidence: evidence.artifact ? [evidence.artifact] : [],
      confidence: finding.confidence,
      utility: existingChunk?.utility ?? 0,
      status: "active",
      canonicalKey: `finding-evidence:${evidence.id}`,
      accessCount: existingChunk?.accessCount ?? 0,
      reinforcementCount: existingChunk?.reinforcementCount ?? 0,
      createdAt: existingChunk?.createdAt ?? ts,
      updatedAt: ts,
      lastAccessedAt: existingChunk?.lastAccessedAt ?? null,
      consolidatedAt: existingChunk?.consolidatedAt ?? null,
    };
    saveChunk(db, chunk);
    evidence.memoryChunkId = chunk.id;
    db.prepare(`
      INSERT INTO finding_evidence (
        id, finding_id, kind, title, content, artifact, command, hash,
        metadata_json, memory_chunk_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      evidence.id,
      evidence.findingId,
      evidence.kind,
      evidence.title,
      evidence.content,
      evidence.artifact,
      evidence.command,
      evidence.hash,
      jsonString(evidence.metadata),
      evidence.memoryChunkId,
      evidence.createdAt,
    );
    db.prepare(`
      INSERT OR IGNORE INTO links (id, src, relation, dst, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(`link_${randomUUID()}`, finding.memoryChunkId, "supported_by", evidence.memoryChunkId, jsonString({ findingId: finding.id }), ts);
    appendFindingHistory(db, {
      findingId: finding.id,
      event: "evidence_added",
      note: input.note ?? `Evidence added: ${evidence.title}`,
      actor: input.actor,
      metadata: { evidenceId: evidence.id, memoryChunkId: evidence.memoryChunkId },
    });
    finding.updatedAt = ts;
    finding.lastMilestoneAt = ts;
    finding.memoryChunkId = saveFindingMemory(db, finding);
    saveFinding(db, finding);
    appendEvent(db, {
      type: "finding_evidence_added",
      findingId: finding.id,
      evidenceId: evidence.id,
      memoryChunkId: evidence.memoryChunkId,
    });
    touchUpdated(db);
    return { evidence: rowToFindingEvidence({
      id: evidence.id,
      finding_id: evidence.findingId,
      kind: evidence.kind,
      title: evidence.title,
      content: evidence.content,
      artifact: evidence.artifact,
      command: evidence.command,
      hash: evidence.hash,
      metadata_json: jsonString(evidence.metadata),
      memory_chunk_id: evidence.memoryChunkId,
      created_at: evidence.createdAt,
    }), finding: getFindingById(db, finding.id, true) };
  }), options);
}

export async function linkFinding(cwd, input = {}, options = {}) {
  if (!input.findingId) throw new Error("findingId is required");
  const targetType = input.targetType ?? (input.memoryId ? "memory" : "finding");
  const targetId = input.targetId ?? input.targetFindingId ?? input.memoryId;
  if (!targetId) throw new Error("targetId, targetFindingId, or memoryId is required");
  const relation = input.relation ?? "related";
  return withDatabase(cwd, (db) => withTransaction(db, () => {
    const finding = getFindingById(db, input.findingId, false);
    const ts = nowIso();
    const existing = db.prepare(`
      SELECT * FROM finding_links
      WHERE finding_id = ? AND relation = ? AND target_type = ? AND target_id = ?
    `).get(finding.id, relation, targetType, targetId);
    if (existing) return { created: false, link: rowToFindingLink(existing), finding };

    const link = {
      id: `fl_${randomUUID()}`,
      findingId: finding.id,
      relation,
      targetType,
      targetId: String(targetId),
      metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
      createdAt: ts,
    };
    db.prepare(`
      INSERT INTO finding_links (id, finding_id, relation, target_type, target_id, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(link.id, link.findingId, link.relation, link.targetType, link.targetId, jsonString(link.metadata), link.createdAt);

    if (targetType === "finding") {
      const target = getFindingById(db, targetId, false);
      if (finding.memoryChunkId && target.memoryChunkId) {
        db.prepare(`
          INSERT OR IGNORE INTO links (id, src, relation, dst, metadata_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(`link_${randomUUID()}`, finding.memoryChunkId, relation, target.memoryChunkId, jsonString({ findingId: finding.id, targetFindingId: target.id }), ts);
      }
    } else if (targetType === "memory" && finding.memoryChunkId) {
      db.prepare(`
        INSERT OR IGNORE INTO links (id, src, relation, dst, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`link_${randomUUID()}`, finding.memoryChunkId, relation, targetId, jsonString({ findingId: finding.id }), ts);
    }

    appendFindingHistory(db, {
      findingId: finding.id,
      event: "linked",
      note: input.note ?? `Linked ${relation} ${targetType}:${targetId}`,
      actor: input.actor,
      metadata: { relation, targetType, targetId },
    });
    appendEvent(db, {
      type: "finding_linked",
      findingId: finding.id,
      relation,
      targetType,
      targetId,
    });
    touchUpdated(db);
    return { created: true, link, finding: getFindingById(db, finding.id, true) };
  }), options);
}

export async function transitionFinding(cwd, input = {}, options = {}) {
  if (!input.findingId) throw new Error("findingId is required");
  return withDatabase(cwd, (db) => withTransaction(db, () => {
    const finding = getFindingById(db, input.findingId, false);
    const oldState = finding.state;
    if (input.state) finding.state = normalizeFindingState(input.state);
    if (input.proofStatus ?? input.proof_status) finding.proofStatus = truncateText(input.proofStatus ?? input.proof_status, 80);
    if (input.confidence !== undefined) finding.confidence = clampNumber(input.confidence, 0, 1, finding.confidence);
    if (input.severity !== undefined) finding.severity = input.severity;
    if (input.reportPath ?? input.report_path) finding.reportPath = input.reportPath ?? input.report_path;
    if (input.duplicateOf ?? input.duplicate_of) finding.duplicateOf = input.duplicateOf ?? input.duplicate_of;
    if (input.supersededBy ?? input.superseded_by) finding.supersededBy = input.supersededBy ?? input.superseded_by;
    const ts = nowIso();
    finding.updatedAt = ts;
    finding.lastMilestoneAt = ts;
    finding.tags = normalizeTags([...finding.tags, finding.state]);
    finding.memoryChunkId = saveFindingMemory(db, finding);
    saveFinding(db, finding);
    appendFindingHistory(db, {
      findingId: finding.id,
      event: oldState === finding.state ? "milestone" : "transition",
      fromState: oldState,
      toState: finding.state,
      note: input.note ?? `Finding ${oldState === finding.state ? "milestone" : `transitioned from ${oldState} to ${finding.state}`}.`,
      actor: input.actor,
      metadata: input.metadata,
    });
    appendEvent(db, {
      type: "finding_transitioned",
      findingId: finding.id,
      fromState: oldState,
      toState: finding.state,
      proofStatus: finding.proofStatus,
    });
    touchUpdated(db);
    return { finding: getFindingById(db, finding.id, true) };
  }), options);
}

export async function findingSummary(cwd, params = {}, options = {}) {
  return withDatabase(cwd, (db) => {
    const kind = params.kind || params.type ? normalizeFindingKind(params.kind ?? params.type) : null;
    const rows = kind
      ? db.prepare("SELECT * FROM findings WHERE kind = ?").all(kind)
      : db.prepare("SELECT * FROM findings").all();
    const counts = {};
    const byKind = Object.fromEntries(FINDING_TYPES.map((item) => [item, 0]));
    for (const row of rows) {
      const finding = rowToFinding(row);
      counts[finding.state] = (counts[finding.state] ?? 0) + 1;
      byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1;
    }
    const active = rows
      .map(rowToFinding)
      .filter((finding) => !TERMINAL_FINDING_STATES.includes(finding.state))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, clampNumber(params.activeLimit ?? 20, 1, 100, 20));
    return {
      counts,
      byKind,
      total: rows.length,
      active,
    };
  }, options);
}

function setBufferInDb(db, name, value, updatedAt = nowIso()) {
  db.prepare(`
    INSERT INTO buffers (name, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(name, jsonString(value), updatedAt);
  return { name, value, updatedAt };
}

export async function setBuffer(cwd, name, value, options = {}) {
  if (!BUFFER_NAMES.includes(name)) {
    throw new Error(`Invalid buffer '${name}'. Expected one of: ${BUFFER_NAMES.join(", ")}`);
  }
  return withDatabase(cwd, (db) => withTransaction(db, () => {
    const buffer = setBufferInDb(db, name, value);
    appendEvent(db, {
      type: "buffer_set",
      buffer: name,
    });
    touchUpdated(db);
    return buffer;
  }), options);
}

export async function getBuffers(cwd, options = {}) {
  return withDatabase(cwd, (db) => readBuffersFromDb(db), options);
}

export async function linkChunks(cwd, input = {}, options = {}) {
  const src = input.src ?? input.source ?? input.from;
  const dst = input.dst ?? input.target ?? input.to;
  const relation = input.relation ?? "related";
  if (!src || !dst) throw new Error("src and dst chunk ids are required");
  return withDatabase(cwd, (db) => withTransaction(db, () => {
    const srcExists = Boolean(db.prepare("SELECT 1 FROM chunks WHERE id = ?").get(src));
    const dstExists = Boolean(db.prepare("SELECT 1 FROM chunks WHERE id = ?").get(dst));
    if (!srcExists || !dstExists) {
      throw new Error(`Cannot link missing chunks: src exists=${srcExists}, dst exists=${dstExists}`);
    }
    const existing = db.prepare("SELECT * FROM links WHERE src = ? AND relation = ? AND dst = ?").get(src, relation, dst);
    if (existing) {
      return {
        created: false,
        link: {
          id: existing.id,
          src: existing.src,
          relation: existing.relation,
          dst: existing.dst,
          metadata: jsonParse(existing.metadata_json, {}),
          createdAt: existing.created_at,
        },
      };
    }
    const link = {
      id: `link_${randomUUID()}`,
      src,
      dst,
      relation,
      metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
      createdAt: nowIso(),
    };
    db.prepare("INSERT INTO links (id, src, relation, dst, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      link.id,
      link.src,
      link.relation,
      link.dst,
      jsonString(link.metadata),
      link.createdAt,
    );
    appendEvent(db, {
      type: "chunks_linked",
      linkId: link.id,
      src,
      dst,
      relation,
    });
    touchUpdated(db);
    return { created: true, link };
  }), options);
}

function generatedConsolidationLevel(tag) {
  if (/(principle|invariant|checksum|signed|bounds|both-crash|secondary|root-cause)/.test(tag)) {
    return "principle";
  }
  if (/(procedure|recipe|steps|craft|fuzz|validate|submit)/.test(tag)) return "procedural";
  if (/(analogy|similar|mapping|lifecycle)/.test(tag)) return "analogical";
  return "semantic";
}

export async function consolidateMemories(cwd, params = {}, options = {}) {
  const store = await readStore(cwd, options);
  const recentLimit = clampNumber(params.recentLimit ?? 50, 1, 500, 50);
  const minSupport = clampNumber(params.minSupport ?? 2, 1, 20, 2);
  const episodes = store.chunks
    .filter((chunk) => chunk.level === "episodic" && !chunk.consolidatedAt)
    .slice(-recentLimit);

  const planned = [];
  for (const insight of asArray(params.insights)) {
    if (!insight?.content) continue;
    planned.push({
      ...insight,
      level: insight.level ?? "principle",
      sourceEpisodeIds: asArray(insight.sourceEpisodeIds),
      source: {
        kind: "explicit-consolidation",
        taskId: params.taskId ?? null,
        ...(insight.source ?? {}),
      },
    });
  }

  const groups = new Map();
  for (const episode of episodes) {
    for (const tag of normalizeTags(episode.tags)) {
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push(episode);
    }
  }

  for (const [tag, taggedEpisodes] of groups.entries()) {
    if (taggedEpisodes.length < minSupport) continue;
    const level = generatedConsolidationLevel(tag);
    const titles = taggedEpisodes.slice(0, 5).map((episode) => `- ${episode.title}`).join("\n");
    planned.push({
      level,
      type: level === "procedural" ? "procedure" : level === "principle" ? "principle" : "concept",
      title: `Consolidated ${tag} pattern`,
      content: `Repeated cyber research pattern tagged '${tag}' appeared in ${taggedEpisodes.length} episodes.\n${titles}`,
      tags: [tag, "consolidated"],
      confidence: Math.min(0.95, 0.45 + taggedEpisodes.length * 0.08),
      sourceEpisodeIds: taggedEpisodes.map((episode) => episode.id),
      source: {
        kind: "heuristic-consolidation",
        taskId: params.taskId ?? null,
      },
    });
  }

  const created = [];
  for (const insight of planned) {
    const remembered = await rememberMemory(
      cwd,
      {
        ...insight,
        provenance: {
          consolidationTaskId: params.taskId ?? null,
          sourceEpisodeIds: asArray(insight.sourceEpisodeIds),
          generatedBy: "cybermem.consolidate",
          ...(insight.provenance ?? {}),
        },
      },
      options,
    );
    created.push(remembered.chunk);
    for (const episodeId of asArray(insight.sourceEpisodeIds)) {
      await linkChunks(
        cwd,
        { src: episodeId, relation: "consolidated_into", dst: remembered.chunk.id },
        options,
      ).catch(() => undefined);
    }
  }

  const episodeIds = new Set(episodes.map((episode) => episode.id));
  withDatabase(cwd, (db) => withTransaction(db, () => {
    const ts = nowIso();
    for (const episodeId of episodeIds) {
      const row = db.prepare("SELECT * FROM chunks WHERE id = ?").get(episodeId);
      if (!row) continue;
      const chunk = rowToChunk(row);
      chunk.consolidatedAt = ts;
      saveChunk(db, chunk);
    }
    appendEvent(db, {
      type: "consolidated",
      taskId: params.taskId ?? null,
      episodeCount: episodeIds.size,
      promotedCount: created.length,
    });
    touchUpdated(db);
  }), options);

  return {
    taskId: params.taskId ?? null,
    episodeCount: episodes.length,
    promotedCount: created.length,
    promoted: created,
  };
}

function decayScore(chunk) {
  const ageDays = Math.max(0, (Date.now() - Date.parse(chunk.updatedAt ?? chunk.createdAt ?? nowIso())) / 86_400_000);
  const access = Number(chunk.accessCount ?? 0) + Number(chunk.reinforcementCount ?? 0);
  const confidence = clampNumber(chunk.confidence ?? 0.5, 0, 1, 0.5);
  const utility = clampNumber(chunk.utility ?? 0, -5, 5, 0);
  return confidence + Math.log1p(access) * 0.2 + utility * 0.08 - Math.log1p(ageDays) * 0.12;
}

export async function forgetDecayed(cwd, params = {}, options = {}) {
  const dryRun = params.dryRun ?? true;
  const olderThanDays = clampNumber(params.olderThanDays ?? 180, 0, 10_000, 180);
  const threshold = clampNumber(params.threshold ?? 0.2, -10, 10, 0.2);
  const store = await readStore(cwd, options);
  const candidates = store.chunks
    .map((chunk) => {
      const ageDays = Math.max(0, (Date.now() - Date.parse(chunk.updatedAt ?? chunk.createdAt ?? nowIso())) / 86_400_000);
      return {
        chunk,
        ageDays,
        decayScore: decayScore(chunk),
      };
    })
    .filter(
      (item) =>
        item.ageDays >= olderThanDays &&
        item.decayScore < threshold &&
        !["pinned", "active"].includes(item.chunk.status),
    )
    .sort((left, right) => left.decayScore - right.decayScore);

  if (dryRun) {
    return {
      dryRun: true,
      candidateCount: candidates.length,
      candidates: candidates.slice(0, 50).map((item) => ({
        id: item.chunk.id,
        title: item.chunk.title,
        level: item.chunk.level,
        ageDays: round(item.ageDays),
        decayScore: round(item.decayScore),
      })),
    };
  }

  return withDatabase(cwd, (db) => withTransaction(db, () => {
    for (const item of candidates) {
      deleteChunk(db, item.chunk.id);
    }
    appendEvent(db, {
      type: "forgot_decayed",
      removedCount: candidates.length,
      olderThanDays,
      threshold,
    });
    touchUpdated(db);
    return {
      dryRun: false,
      removedCount: candidates.length,
    };
  }), options);
}

export async function stats(cwd, options = {}) {
  return withDatabase(cwd, (db) => {
    const chunks = allChunks(db);
    const byLevel = Object.fromEntries(MEMORY_LEVELS.map((level) => [level, 0]));
    const byType = {};
    const byStatus = {};
    const tagCounts = {};
    for (const chunk of chunks) {
      byLevel[chunk.level] = (byLevel[chunk.level] ?? 0) + 1;
      byType[chunk.type] = (byType[chunk.type] ?? 0) + 1;
      byStatus[chunk.status] = (byStatus[chunk.status] ?? 0) + 1;
      for (const tag of normalizeTags(chunk.tags)) {
        tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
      }
    }
    const topTags = Object.entries(tagCounts)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 20)
      .map(([tag, count]) => ({ tag, count }));
    const buffers = readBuffersFromDb(db);
    return {
      path: storePathFor(cwd, options.dataDir),
      schemaVersion: STORE_SCHEMA_VERSION,
      storage: {
        engine: "sqlite",
        retrieval: "indexed-rows-plus-hash-embeddings",
        embeddingModel: EMBEDDING_MODEL,
        embeddingDimensions: EMBEDDING_DIMENSIONS,
      },
      createdAt: getMeta(db, "created_at"),
      updatedAt: getMeta(db, "updated_at") ?? getMeta(db, "created_at"),
      counts: {
        chunks: chunks.length,
        links: db.prepare("SELECT COUNT(*) AS count FROM links").get().count,
        productions: db.prepare("SELECT COUNT(*) AS count FROM productions").get().count,
        traces: db.prepare("SELECT COUNT(*) AS count FROM traces").get().count,
        events: db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
        findings: db.prepare("SELECT COUNT(*) AS count FROM findings").get().count,
        findingEvidence: db.prepare("SELECT COUNT(*) AS count FROM finding_evidence").get().count,
      },
      byLevel,
      byType,
      byStatus,
      topTags,
      buffers: Object.fromEntries(
        Object.entries(buffers).map(([name, buffer]) => [name, { updatedAt: buffer.updatedAt, hasValue: buffer.value !== null }]),
      ),
    };
  }, options);
}

export async function explainTrace(cwd, traceId, options = {}) {
  if (!traceId) throw new Error("traceId is required");
  return withDatabase(cwd, (db) => {
    const row = db.prepare("SELECT * FROM traces WHERE id = ?").get(traceId);
    if (!row) throw new Error(`No retrieval trace found for ${traceId}`);
    return rowToTrace(row);
  }, options);
}

export async function auditMemory(cwd, params = {}, options = {}) {
  const patterns = asArray(params.patterns).length > 0 ? asArray(params.patterns) : DEFAULT_PATTERNS;
  const regexes = patterns.map((pattern) => new RegExp(pattern, "i"));
  const sourceKind = params.sourceKind ? String(params.sourceKind) : null;
  return withDatabase(cwd, (db) => withTransaction(db, () => {
    const matches = [];
    for (const chunk of allChunks(db)) {
      if (sourceKind && chunk.source?.kind !== sourceKind && chunk.source?.type !== sourceKind) continue;
      const haystack = JSON.stringify({
        title: chunk.title,
        content: chunk.content,
        tags: chunk.tags,
        context: chunk.context,
        source: chunk.source,
        provenance: chunk.provenance,
        evidence: chunk.evidence,
      });
      for (const regex of regexes) {
        const match = haystack.match(regex);
        if (match) {
          matches.push({
            chunkId: chunk.id,
            title: chunk.title,
            level: chunk.level,
            pattern: regex.source,
            match: match[0],
          });
        }
      }
    }
    const audit = {
      id: `audit_${randomUUID()}`,
      at: nowIso(),
      patterns,
      sourceKind,
      matchCount: matches.length,
      matches: matches.slice(0, 100),
    };
    saveAudit(db, audit);
    appendEvent(db, {
      type: "audit",
      auditId: audit.id,
      matchCount: audit.matchCount,
    });
    touchUpdated(db);
    return audit;
  }), options);
}

export async function registerProduction(cwd, input = {}, options = {}) {
  const name = String(input.name ?? input.id ?? "").trim();
  if (!name) throw new Error("production name is required");
  return withDatabase(cwd, (db) => withTransaction(db, () => {
    const existing = db.prepare("SELECT * FROM productions WHERE id = ? OR name = ?").get(input.id ?? "", name);
    const production = productionFromObject({
      ...input,
      id: input.id ? String(input.id) : existing?.id ?? `prod_${stableHash(name).slice(0, 16)}`,
      createdAt: existing?.created_at ?? nowIso(),
      fireCount: existing?.fire_count ?? 0,
      rewardHistory: existing ? jsonParse(existing.reward_history_json, []) : [],
      updatedAt: nowIso(),
    });
    saveProduction(db, production);
    appendEvent(db, { type: existing ? "production_updated" : "production_created", productionId: production.id });
    touchUpdated(db);
    return { created: !existing, production };
  }), options);
}

function bufferText(buffers, name) {
  return JSON.stringify(buffers?.[name]?.value ?? "");
}

function conditionMatches(condition, store, params) {
  if (!condition || typeof condition !== "object") return false;
  switch (condition.type) {
    case "always":
      return true;
    case "query_contains":
      return String(params.query ?? "").toLowerCase().includes(String(condition.text ?? "").toLowerCase());
    case "buffer_exists":
      return store.buffers?.[condition.buffer]?.value !== null && store.buffers?.[condition.buffer]?.value !== undefined;
    case "buffer_contains":
      return bufferText(store.buffers, condition.buffer).toLowerCase().includes(String(condition.text ?? "").toLowerCase());
    case "tag_seen": {
      const tag = String(condition.tag ?? "").toLowerCase();
      return store.chunks.some((chunk) => normalizeTags(chunk.tags).includes(tag));
    }
    case "memory_level_count_at_least": {
      const level = condition.level;
      const count = clampNumber(condition.count ?? 1, 1, 1_000_000, 1);
      const tag = condition.tag ? String(condition.tag).toLowerCase() : null;
      return (
        store.chunks.filter((chunk) => {
          if (level && chunk.level !== level) return false;
          if (tag && !normalizeTags(chunk.tags).includes(tag)) return false;
          return true;
        }).length >= count
      );
    }
    default:
      return false;
  }
}

function interpolateTemplate(template, store, params) {
  return String(template ?? "")
    .replaceAll("{query}", String(params.query ?? ""))
    .replaceAll("{goal}", bufferText(store.buffers, "goal"))
    .replaceAll("{tool}", bufferText(store.buffers, "tool"))
    .replaceAll("{imaginal}", bufferText(store.buffers, "imaginal"))
    .replaceAll("{retrieval}", bufferText(store.buffers, "retrieval"));
}

export async function fireProductions(cwd, params = {}, options = {}) {
  const cycleLimit = clampNumber(params.cycleLimit ?? 1, 1, 10, 1);
  const fired = [];
  for (let cycle = 0; cycle < cycleLimit; cycle += 1) {
    const store = await readStore(cwd, options);
    const matching = store.productions
      .filter((production) => {
        const conditions = asArray(production.conditions);
        return conditions.length === 0 || conditions.every((condition) => conditionMatches(condition, store, params));
      })
      .sort((left, right) => Number(right.utility ?? 0) - Number(left.utility ?? 0));
    const production = matching[0];
    if (!production) break;
    const actionResults = [];
    for (const action of asArray(production.actions)) {
      if (!action || typeof action !== "object") continue;
      if (action.type === "recall") {
        const query = interpolateTemplate(action.query ?? "{query}", store, params);
        const result = await retrieveMemories(
          cwd,
          {
            query,
            level: action.level,
            levels: action.levels,
            tags: action.tags,
            topK: action.topK ?? 3,
            explain: true,
          },
          options,
        );
        if (action.targetBuffer) await setBuffer(cwd, action.targetBuffer, result, options);
        actionResults.push({ type: "recall", traceId: result.traceId, hitCount: result.hits.length });
      } else if (action.type === "set_buffer") {
        const value =
          typeof action.value === "string" ? interpolateTemplate(action.value, store, params) : action.value;
        const buffer = await setBuffer(cwd, action.buffer, value, options);
        actionResults.push({ type: "set_buffer", buffer: buffer.name });
      } else if (action.type === "remember") {
        const remembered = await rememberMemory(
          cwd,
          {
            ...action.memory,
            content: interpolateTemplate(action.memory?.content ?? action.content ?? "", store, params),
            title: action.memory?.title ?? action.title,
          },
          options,
        );
        actionResults.push({ type: "remember", chunkId: remembered.chunk.id, created: remembered.created });
      }
    }
    withDatabase(cwd, (db) => withTransaction(db, () => {
      const row = db.prepare("SELECT * FROM productions WHERE id = ?").get(production.id);
      if (row) {
        const updated = rowToProduction(row);
        updated.fireCount = Number(updated.fireCount ?? 0) + 1;
        updated.lastFiredAt = nowIso();
        updated.updatedAt = nowIso();
        saveProduction(db, updated);
      }
      appendEvent(db, {
        type: "production_fired",
        productionId: production.id,
        actionCount: actionResults.length,
      });
      touchUpdated(db);
    }), options);
    fired.push({
      productionId: production.id,
      name: production.name,
      utility: production.utility,
      actions: actionResults,
    });
  }
  return { firedCount: fired.length, fired };
}

export async function rewardProduction(cwd, input = {}, options = {}) {
  const id = input.id ?? input.productionId;
  if (!id) throw new Error("production id is required");
  const value = clampNumber(input.value ?? input.reward ?? 0, -5, 5, 0);
  const learningRate = clampNumber(input.learningRate ?? 0.2, 0.01, 1, 0.2);
  return withDatabase(cwd, (db) => withTransaction(db, () => {
    const row = db.prepare("SELECT * FROM productions WHERE id = ? OR name = ?").get(id, id);
    if (!row) throw new Error(`No production found for ${id}`);
    const production = rowToProduction(row);
    const oldUtility = Number(production.utility ?? 0);
    const newUtility = oldUtility + learningRate * (value - oldUtility);
    production.utility = round(clampNumber(newUtility, -5, 5, 0));
    production.updatedAt = nowIso();
    production.rewardHistory = [
      ...(production.rewardHistory ?? []),
      {
        at: nowIso(),
        value,
        reason: input.reason ?? "",
        taskId: input.taskId ?? null,
        oldUtility: round(oldUtility),
        newUtility: production.utility,
      },
    ].slice(-100);
    saveProduction(db, production);
    appendEvent(db, {
      type: "production_rewarded",
      productionId: production.id,
      value,
      utility: production.utility,
    });
    touchUpdated(db);
    return { production };
  }), options);
}

export async function ensureStore(cwd, options = {}) {
  const path = storePathFor(cwd, options.dataDir);
  withDatabase(cwd, () => null, options);
  await access(path, fsConstants.R_OK);
  return path;
}
