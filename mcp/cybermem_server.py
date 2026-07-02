#!/usr/bin/env python3
"""SQLite-backed MCP server for Cybermem.

The server intentionally exposes a small set of graph-memory tools. It stores
durable system knowledge and lightweight evidence references, not artifacts or
session transcripts.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from hashlib import sha1
from pathlib import Path
from typing import Any


SERVER_NAME = "cybermem"
SERVER_VERSION = "0.1.0"
SCHEMA_VERSION = 1

NODE_TYPES = {
    "asset",
    "invariant",
    "mitigation",
    "source",
    "sink",
    "primitive",
    "chain",
    "trajectory",
}

STATUSES = {"draft", "suspected", "confirmed", "rejected", "stale"}
EVIDENCE_KINDS = {"code", "artifact", "command", "url", "human-note"}
PATH_BASES = {"workspace", "repo", "asset-root", "external"}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def slugify(value: str, fallback: str = "memory") -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or fallback


def normalize_title(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def stable_node_id(node_type: str, title: str) -> str:
    title_norm = normalize_title(title)
    digest = sha1(f"{node_type}:{title_norm}".encode("utf-8")).hexdigest()[:10]
    return f"{node_type}-{slugify(title_norm)[:48]}-{digest}"


def stable_evidence_id(node_id: str, evidence: dict[str, Any]) -> str:
    payload = {
        "nodeId": node_id,
        "kind": evidence.get("kind"),
        "pathBase": evidence.get("pathBase"),
        "path": evidence.get("path"),
        "locator": evidence.get("locator", {}),
        "summary": evidence.get("summary", ""),
    }
    digest = sha1(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()[:16]
    return f"evidence-{digest}"


def validate_id(value: str, field: str = "id") -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string.")
    if re.search(r"[^A-Za-z0-9._:-]", value):
        raise ValueError(f"{field} may only contain letters, digits, '.', '_', ':', and '-'.")


def resolve_workspace(args: dict[str, Any] | None = None) -> Path:
    args = args or {}
    raw = args.get("workspace")
    if raw is None:
        raw = (
            os.environ.get("CYBERMEM_WORKSPACE")
            or os.environ.get("CODEX_WORKSPACE")
            or os.environ.get("WORKSPACE_ROOT")
            or os.getcwd()
        )
    workspace = Path(str(raw)).expanduser()
    return workspace.resolve()


def resolve_db_path(workspace: Path) -> Path:
    override = os.environ.get("CYBERMEM_DB")
    if override:
        return Path(override).expanduser().resolve()
    return workspace / ".cybermem" / "memory.sqlite"


def connect(workspace: Path) -> sqlite3.Connection:
    db_path = resolve_db_path(workspace)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    ensure_schema(conn)
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS nodes (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          title_norm TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          body TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft',
          confidence REAL NOT NULL DEFAULT 0.5,
          type_data_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          UNIQUE(type, title_norm)
        );

        CREATE TABLE IF NOT EXISTS node_assets (
          node_id TEXT NOT NULL,
          asset_id TEXT NOT NULL,
          PRIMARY KEY (node_id, asset_id),
          FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS node_tags (
          node_id TEXT NOT NULL,
          tag TEXT NOT NULL,
          PRIMARY KEY (node_id, tag),
          FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS edges (
          from_id TEXT NOT NULL,
          to_id TEXT NOT NULL,
          relation TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (from_id, to_id, relation),
          FOREIGN KEY (from_id) REFERENCES nodes(id) ON DELETE CASCADE,
          FOREIGN KEY (to_id) REFERENCES nodes(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS evidence_refs (
          id TEXT PRIMARY KEY,
          node_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          path_base TEXT,
          path TEXT,
          locator_json TEXT NOT NULL DEFAULT '{}',
          summary TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
        );
        """
    )
    try:
        conn.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts
            USING fts5(id UNINDEXED, title, summary, body, tags, evidence)
            """
        )
    except sqlite3.OperationalError:
        pass
    conn.execute(
        "INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)",
        ("schemaVersion", str(SCHEMA_VERSION)),
    )
    conn.commit()


def fts_available(conn: sqlite3.Connection) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nodes_fts'"
    ).fetchone()
    return row is not None


def json_loads_object(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    value = json.loads(raw)
    return value if isinstance(value, dict) else {}


def merge_dicts(base: dict[str, Any], update: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in update.items():
        if (
            isinstance(value, dict)
            and isinstance(merged.get(key), dict)
        ):
            merged[key] = merge_dicts(merged[key], value)
        else:
            merged[key] = value
    return merged


def clean_string_list(values: Any, field: str) -> list[str]:
    if values is None:
        return []
    if not isinstance(values, list):
        raise ValueError(f"{field} must be an array of strings.")
    cleaned: list[str] = []
    for value in values:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{field} entries must be non-empty strings.")
        cleaned.append(value.strip())
    return cleaned


def normalize_tags(values: Any) -> list[str]:
    return sorted({slugify(value) for value in clean_string_list(values, "tags") if slugify(value)})


def validate_evidence(evidence: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(evidence, dict):
        raise ValueError("evidence entries must be objects.")
    kind = evidence.get("kind")
    if kind not in EVIDENCE_KINDS:
        raise ValueError(f"evidence.kind must be one of: {', '.join(sorted(EVIDENCE_KINDS))}.")

    path_base = evidence.get("pathBase")
    if path_base is not None and path_base not in PATH_BASES:
        raise ValueError(f"evidence.pathBase must be one of: {', '.join(sorted(PATH_BASES))}.")

    path = evidence.get("path")
    if path is not None:
        if not isinstance(path, str) or not path.strip():
            raise ValueError("evidence.path must be a non-empty string when provided.")
        if kind != "url" and Path(path).expanduser().is_absolute():
            raise ValueError("evidence.path must be relative to the workspace, repo, or asset root.")

    locator = evidence.get("locator", {})
    if locator is None:
        locator = {}
    if not isinstance(locator, dict):
        raise ValueError("evidence.locator must be an object when provided.")

    summary = evidence.get("summary", "")
    if not isinstance(summary, str):
        raise ValueError("evidence.summary must be a string.")

    cleaned = {
        "kind": kind,
        "pathBase": path_base,
        "path": path.strip() if isinstance(path, str) else None,
        "locator": locator,
        "summary": summary.strip(),
    }
    if "id" in evidence and evidence["id"] is not None:
        validate_id(str(evidence["id"]), "evidence.id")
        cleaned["id"] = str(evidence["id"])
    return cleaned


def refresh_fts(conn: sqlite3.Connection, node_id: str) -> None:
    if not fts_available(conn):
        return
    node = conn.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
    if node is None:
        conn.execute("DELETE FROM nodes_fts WHERE id = ?", (node_id,))
        return
    tags = " ".join(
        row["tag"]
        for row in conn.execute("SELECT tag FROM node_tags WHERE node_id = ?", (node_id,))
    )
    evidence = " ".join(
        row["summary"]
        for row in conn.execute("SELECT summary FROM evidence_refs WHERE node_id = ?", (node_id,))
    )
    conn.execute("DELETE FROM nodes_fts WHERE id = ?", (node_id,))
    conn.execute(
        """
        INSERT INTO nodes_fts(id, title, summary, body, tags, evidence)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (node_id, node["title"], node["summary"], node["body"], tags, evidence),
    )


def evidence_for_node(conn: sqlite3.Connection, node_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, kind, path_base, path, locator_json, summary, created_at
        FROM evidence_refs
        WHERE node_id = ?
        ORDER BY created_at, id
        """,
        (node_id,),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "kind": row["kind"],
            "pathBase": row["path_base"],
            "path": row["path"],
            "locator": json_loads_object(row["locator_json"]),
            "summary": row["summary"],
            "createdAt": row["created_at"],
        }
        for row in rows
    ]


def edges_for_node(conn: sqlite3.Connection, node_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT from_id, to_id, relation, note, created_at, updated_at
        FROM edges
        WHERE from_id = ? OR to_id = ?
        ORDER BY updated_at DESC, relation
        """,
        (node_id, node_id),
    ).fetchall()
    return [
        {
            "fromId": row["from_id"],
            "toId": row["to_id"],
            "relation": row["relation"],
            "note": row["note"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }
        for row in rows
    ]


def node_to_dict(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    *,
    include_evidence: bool = True,
    include_edges: bool = False,
) -> dict[str, Any]:
    node_id = row["id"]
    asset_ids = [
        asset_row["asset_id"]
        for asset_row in conn.execute(
            "SELECT asset_id FROM node_assets WHERE node_id = ? ORDER BY asset_id",
            (node_id,),
        )
    ]
    tags = [
        tag_row["tag"]
        for tag_row in conn.execute(
            "SELECT tag FROM node_tags WHERE node_id = ? ORDER BY tag",
            (node_id,),
        )
    ]
    result = {
        "id": node_id,
        "type": row["type"],
        "title": row["title"],
        "summary": row["summary"],
        "body": row["body"],
        "status": row["status"],
        "confidence": row["confidence"],
        "assetIds": asset_ids,
        "tags": tags,
        "typeData": json_loads_object(row["type_data_json"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "revision": row["revision"],
    }
    if include_evidence:
        result["evidence"] = evidence_for_node(conn, node_id)
    if include_edges:
        result["links"] = edges_for_node(conn, node_id)
    return result


def save_node(conn: sqlite3.Connection, args: dict[str, Any]) -> dict[str, Any]:
    node_type = args.get("type")
    if node_type not in NODE_TYPES:
        raise ValueError(f"type must be one of: {', '.join(sorted(NODE_TYPES))}.")

    title = args.get("title")
    if not isinstance(title, str) or not title.strip():
        raise ValueError("title must be a non-empty string.")
    title = title.strip()
    title_norm = normalize_title(title)

    node_id = args.get("id")
    if node_id is not None:
        node_id = str(node_id).strip()
        validate_id(node_id)
    else:
        node_id = stable_node_id(node_type, title)

    existing = conn.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
    if existing is None:
        existing = conn.execute(
            "SELECT * FROM nodes WHERE type = ? AND title_norm = ?",
            (node_type, title_norm),
        ).fetchone()
        if existing is not None:
            node_id = existing["id"]

    now = utc_now()
    if existing is None:
        summary = args.get("summary", "")
        body = args.get("body", "")
        status = args.get("status", "draft")
        confidence = args.get("confidence", 0.5)
        type_data = args.get("typeData", {})
        created_at = now
        revision = 1
    else:
        summary = args.get("summary", existing["summary"])
        body = args.get("body", existing["body"])
        status = args.get("status", existing["status"])
        confidence = args.get("confidence", existing["confidence"])
        type_data = merge_dicts(json_loads_object(existing["type_data_json"]), args.get("typeData", {}))
        created_at = existing["created_at"]
        revision = int(existing["revision"]) + 1

    if not isinstance(summary, str):
        raise ValueError("summary must be a string.")
    if not isinstance(body, str):
        raise ValueError("body must be a string.")
    if status not in STATUSES:
        raise ValueError(f"status must be one of: {', '.join(sorted(STATUSES))}.")
    if not isinstance(confidence, (int, float)) or not 0 <= float(confidence) <= 1:
        raise ValueError("confidence must be a number between 0 and 1.")
    if not isinstance(type_data, dict):
        raise ValueError("typeData must be an object.")

    with conn:
        conn.execute(
            """
            INSERT INTO nodes(
              id, type, title, title_norm, summary, body, status, confidence,
              type_data_json, created_at, updated_at, revision
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              title_norm = excluded.title_norm,
              summary = excluded.summary,
              body = excluded.body,
              status = excluded.status,
              confidence = excluded.confidence,
              type_data_json = excluded.type_data_json,
              updated_at = excluded.updated_at,
              revision = excluded.revision
            """,
            (
                node_id,
                node_type,
                title,
                title_norm,
                summary.strip(),
                body.strip(),
                status,
                float(confidence),
                json.dumps(type_data, sort_keys=True),
                created_at,
                now,
                revision,
            ),
        )

        for asset_id in clean_string_list(args.get("assetIds"), "assetIds"):
            validate_id(asset_id, "assetIds entry")
            conn.execute(
                "INSERT OR IGNORE INTO node_assets(node_id, asset_id) VALUES (?, ?)",
                (node_id, asset_id),
            )

        for tag in normalize_tags(args.get("tags")):
            conn.execute(
                "INSERT OR IGNORE INTO node_tags(node_id, tag) VALUES (?, ?)",
                (node_id, tag),
            )

        evidence_entries = args.get("evidence", [])
        if evidence_entries is None:
            evidence_entries = []
        if not isinstance(evidence_entries, list):
            raise ValueError("evidence must be an array of objects.")
        for evidence in evidence_entries:
            cleaned = validate_evidence(evidence)
            evidence_id = cleaned.get("id") or stable_evidence_id(node_id, cleaned)
            conn.execute(
                """
                INSERT OR IGNORE INTO evidence_refs(
                  id, node_id, kind, path_base, path, locator_json, summary, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    evidence_id,
                    node_id,
                    cleaned["kind"],
                    cleaned.get("pathBase"),
                    cleaned.get("path"),
                    json.dumps(cleaned.get("locator", {}), sort_keys=True),
                    cleaned.get("summary", ""),
                    now,
                ),
            )

        refresh_fts(conn, node_id)

    row = conn.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
    return node_to_dict(conn, row, include_evidence=True, include_edges=True)


def parse_limit(value: Any, default: int = 10) -> int:
    if value is None:
        return default
    if not isinstance(value, int):
        raise ValueError("limit must be an integer.")
    return max(1, min(value, 100))


def fts_query(value: str) -> str:
    terms = re.findall(r"[A-Za-z0-9_]+", value)
    return " OR ".join(f'"{term}"' for term in terms)


def search_nodes(
    conn: sqlite3.Connection,
    args: dict[str, Any],
    *,
    allow_fts: bool = True,
) -> dict[str, Any]:
    query = args.get("query", "")
    if query is not None and not isinstance(query, str):
        raise ValueError("query must be a string.")
    query = (query or "").strip()
    types = clean_string_list(args.get("types"), "types")
    for node_type in types:
        if node_type not in NODE_TYPES:
            raise ValueError(f"Unknown node type: {node_type}")
    asset_ids = clean_string_list(args.get("assetIds"), "assetIds")
    tags = normalize_tags(args.get("tags"))
    limit = parse_limit(args.get("limit"), 10)
    include_evidence = bool(args.get("includeEvidence", False))
    include_edges = bool(args.get("includeEdges", False))

    where: list[str] = []
    params: list[Any] = []
    from_clause = "nodes n"

    use_fts = bool(allow_fts and query and fts_available(conn) and fts_query(query))
    if use_fts:
        from_clause = "nodes n JOIN nodes_fts f ON f.id = n.id"
        where.append("nodes_fts MATCH ?")
        params.append(fts_query(query))
    elif query:
        like = f"%{query.lower()}%"
        where.append(
            "(lower(n.title) LIKE ? OR lower(n.summary) LIKE ? OR lower(n.body) LIKE ?)"
        )
        params.extend([like, like, like])

    if types:
        where.append(f"n.type IN ({','.join('?' for _ in types)})")
        params.extend(types)

    for asset_id in asset_ids:
        validate_id(asset_id, "assetIds entry")
        where.append(
            "EXISTS (SELECT 1 FROM node_assets na WHERE na.node_id = n.id AND na.asset_id = ?)"
        )
        params.append(asset_id)

    for tag in tags:
        where.append(
            "EXISTS (SELECT 1 FROM node_tags nt WHERE nt.node_id = n.id AND nt.tag = ?)"
        )
        params.append(tag)

    sql = f"SELECT n.* FROM {from_clause}"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY n.updated_at DESC, n.title LIMIT ?"
    params.append(limit)

    try:
        rows = conn.execute(sql, params).fetchall()
    except sqlite3.OperationalError:
        if not use_fts:
            raise
        return search_nodes(conn, args, allow_fts=False)

    return {
        "count": len(rows),
        "nodes": [
            node_to_dict(
                conn,
                row,
                include_evidence=include_evidence,
                include_edges=include_edges,
            )
            for row in rows
        ],
    }


def get_node(conn: sqlite3.Connection, args: dict[str, Any]) -> dict[str, Any]:
    node_id = args.get("id")
    validate_id(str(node_id), "id")
    row = conn.execute("SELECT * FROM nodes WHERE id = ?", (str(node_id),)).fetchone()
    if row is None:
        raise ValueError(f"No Cybermem node found for id: {node_id}")
    return node_to_dict(
        conn,
        row,
        include_evidence=bool(args.get("includeEvidence", True)),
        include_edges=bool(args.get("includeEdges", True)),
    )


def link_nodes(conn: sqlite3.Connection, args: dict[str, Any]) -> dict[str, Any]:
    from_id = str(args.get("fromId", "")).strip()
    to_id = str(args.get("toId", "")).strip()
    relation = str(args.get("relation", "")).strip()
    note = args.get("note", "")
    validate_id(from_id, "fromId")
    validate_id(to_id, "toId")
    if not relation or re.search(r"[^A-Za-z0-9._:-]", relation):
        raise ValueError("relation must be a non-empty identifier string.")
    if not isinstance(note, str):
        raise ValueError("note must be a string.")

    now = utc_now()
    with conn:
        if conn.execute("SELECT 1 FROM nodes WHERE id = ?", (from_id,)).fetchone() is None:
            raise ValueError(f"fromId does not exist: {from_id}")
        if conn.execute("SELECT 1 FROM nodes WHERE id = ?", (to_id,)).fetchone() is None:
            raise ValueError(f"toId does not exist: {to_id}")
        conn.execute(
            """
            INSERT INTO edges(from_id, to_id, relation, note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(from_id, to_id, relation) DO UPDATE SET
              note = excluded.note,
              updated_at = excluded.updated_at
            """,
            (from_id, to_id, relation, note.strip(), now, now),
        )
    return {
        "fromId": from_id,
        "toId": to_id,
        "relation": relation,
        "note": note.strip(),
        "updatedAt": now,
    }


def export_preseed(conn: sqlite3.Connection, workspace: Path, args: dict[str, Any]) -> dict[str, Any]:
    include_rejected = bool(args.get("includeRejected", False))
    where = "" if include_rejected else "WHERE status != 'rejected'"
    nodes = [
        node_to_dict(conn, row, include_evidence=False, include_edges=False)
        for row in conn.execute(f"SELECT * FROM nodes {where} ORDER BY type, title")
    ]
    node_ids = {node["id"] for node in nodes}
    evidence = [
        {
            "id": row["id"],
            "nodeId": row["node_id"],
            "kind": row["kind"],
            "pathBase": row["path_base"],
            "path": row["path"],
            "locator": json_loads_object(row["locator_json"]),
            "summary": row["summary"],
            "createdAt": row["created_at"],
        }
        for row in conn.execute(
            "SELECT * FROM evidence_refs ORDER BY node_id, created_at, id"
        )
        if row["node_id"] in node_ids
    ]
    edges = [
        {
            "fromId": row["from_id"],
            "toId": row["to_id"],
            "relation": row["relation"],
            "note": row["note"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }
        for row in conn.execute(
            "SELECT * FROM edges ORDER BY from_id, relation, to_id"
        )
        if row["from_id"] in node_ids and row["to_id"] in node_ids
    ]

    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "exportedAt": utc_now(),
        "nodes": nodes,
        "evidence": evidence,
        "edges": edges,
    }

    output_path = args.get("path")
    if output_path:
        path = Path(str(output_path)).expanduser()
        if not path.is_absolute():
            path = workspace / path
    else:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        path = workspace / ".cybermem" / "exports" / f"preseed-{stamp}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {
        "path": str(path),
        "schemaVersion": SCHEMA_VERSION,
        "nodeCount": len(nodes),
        "edgeCount": len(edges),
        "evidenceCount": len(evidence),
    }


def import_preseed(conn: sqlite3.Connection, workspace: Path, args: dict[str, Any]) -> dict[str, Any]:
    raw_path = args.get("path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError("path must be a non-empty string.")
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = workspace / path
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("preseed file must contain a JSON object.")
    if int(payload.get("schemaVersion", 0)) > SCHEMA_VERSION:
        raise ValueError("preseed schemaVersion is newer than this Cybermem server supports.")

    nodes = payload.get("nodes", [])
    evidence = payload.get("evidence", [])
    edges = payload.get("edges", [])
    if not isinstance(nodes, list) or not isinstance(evidence, list) or not isinstance(edges, list):
        raise ValueError("preseed nodes, evidence, and edges must be arrays.")

    imported_nodes = 0
    imported_evidence = 0
    imported_edges = 0
    node_ids: set[str] = set()

    for node in nodes:
        if not isinstance(node, dict):
            raise ValueError("preseed node entries must be objects.")
        save_args = {
            "id": node.get("id"),
            "type": node.get("type"),
            "title": node.get("title"),
            "summary": node.get("summary", ""),
            "body": node.get("body", ""),
            "status": node.get("status", "draft"),
            "confidence": node.get("confidence", 0.5),
            "assetIds": node.get("assetIds", []),
            "tags": node.get("tags", []),
            "typeData": node.get("typeData", {}),
        }
        saved = save_node(conn, save_args)
        node_ids.add(saved["id"])
        imported_nodes += 1

    for item in evidence:
        if not isinstance(item, dict):
            raise ValueError("preseed evidence entries must be objects.")
        node_id = item.get("nodeId")
        if node_id not in node_ids:
            continue
        existing = get_node(
            conn,
            {"id": node_id, "includeEvidence": False, "includeEdges": False},
        )
        save_node(
            conn,
            {
                "id": node_id,
                "type": existing["type"],
                "title": existing["title"],
                "evidence": [
                    {
                        "id": item.get("id"),
                        "kind": item.get("kind"),
                        "pathBase": item.get("pathBase"),
                        "path": item.get("path"),
                        "locator": item.get("locator", {}),
                        "summary": item.get("summary", ""),
                    }
                ],
            },
        )
        imported_evidence += 1

    for edge in edges:
        if not isinstance(edge, dict):
            raise ValueError("preseed edge entries must be objects.")
        if edge.get("fromId") in node_ids and edge.get("toId") in node_ids:
            link_nodes(
                conn,
                {
                    "fromId": edge.get("fromId"),
                    "toId": edge.get("toId"),
                    "relation": edge.get("relation"),
                    "note": edge.get("note", ""),
                },
            )
            imported_edges += 1

    return {
        "path": str(path),
        "nodeCount": imported_nodes,
        "edgeCount": imported_edges,
        "evidenceCount": imported_evidence,
    }


def tool_workspace_result(workspace: Path) -> dict[str, str]:
    return {
        "workspace": str(workspace),
        "database": str(resolve_db_path(workspace)),
    }


def call_tool(name: str, arguments: dict[str, Any] | None) -> dict[str, Any]:
    args = arguments or {}
    workspace = resolve_workspace(args)
    conn = connect(workspace)
    try:
        if name == "cybermem_search":
            result = search_nodes(conn, args)
        elif name == "cybermem_get":
            result = get_node(conn, args)
        elif name == "cybermem_save":
            result = save_node(conn, args)
        elif name == "cybermem_link":
            result = link_nodes(conn, args)
        elif name == "cybermem_export":
            result = export_preseed(conn, workspace, args)
        elif name == "cybermem_import":
            result = import_preseed(conn, workspace, args)
        else:
            raise ValueError(f"Unknown tool: {name}")
    finally:
        conn.close()
    if isinstance(result, dict):
        result.setdefault("_cybermem", tool_workspace_result(workspace))
    return result


def tool_schema() -> list[dict[str, Any]]:
    node_type_enum = sorted(NODE_TYPES)
    return [
        {
            "name": "cybermem_search",
            "description": "Search reusable cyber research memory nodes in the workspace Cybermem graph.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace": {"type": "string", "description": "Workspace root. Defaults to the server workspace."},
                    "query": {"type": "string", "description": "Keyword query over titles, summaries, bodies, tags, and evidence summaries."},
                    "types": {"type": "array", "items": {"type": "string", "enum": node_type_enum}},
                    "assetIds": {"type": "array", "items": {"type": "string"}},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 10},
                    "includeEvidence": {"type": "boolean", "default": False},
                    "includeEdges": {"type": "boolean", "default": False}
                },
                "additionalProperties": False
            }
        },
        {
            "name": "cybermem_get",
            "description": "Get one Cybermem node by id, including evidence and graph links by default.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace": {"type": "string"},
                    "id": {"type": "string"},
                    "includeEvidence": {"type": "boolean", "default": True},
                    "includeEdges": {"type": "boolean", "default": True}
                },
                "required": ["id"],
                "additionalProperties": False
            }
        },
        {
            "name": "cybermem_save",
            "description": "Create or update a typed Cybermem memory node. Existing nodes are merged by id or by type plus normalized title.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace": {"type": "string"},
                    "id": {"type": "string"},
                    "type": {"type": "string", "enum": node_type_enum},
                    "title": {"type": "string"},
                    "summary": {"type": "string"},
                    "body": {"type": "string"},
                    "status": {"type": "string", "enum": sorted(STATUSES), "default": "draft"},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.5},
                    "assetIds": {"type": "array", "items": {"type": "string"}},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "typeData": {"type": "object"},
                    "evidence": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "kind": {"type": "string", "enum": sorted(EVIDENCE_KINDS)},
                                "pathBase": {"type": "string", "enum": sorted(PATH_BASES)},
                                "path": {"type": "string"},
                                "locator": {"type": "object"},
                                "summary": {"type": "string"}
                            },
                            "required": ["kind"],
                            "additionalProperties": False
                        }
                    }
                },
                "required": ["type", "title"],
                "additionalProperties": False
            }
        },
        {
            "name": "cybermem_link",
            "description": "Create or update a directed relation between two Cybermem nodes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace": {"type": "string"},
                    "fromId": {"type": "string"},
                    "toId": {"type": "string"},
                    "relation": {"type": "string", "description": "Identifier such as violates, mitigated_by, reachable_from, flows_to, composes, supports, or supersedes."},
                    "note": {"type": "string"}
                },
                "required": ["fromId", "toId", "relation"],
                "additionalProperties": False
            }
        },
        {
            "name": "cybermem_export",
            "description": "Export workspace memory to a portable JSON preseed file. Artifacts remain on disk and are referenced only by path.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace": {"type": "string"},
                    "path": {"type": "string", "description": "Output path, relative to workspace unless absolute. Defaults to .cybermem/exports/preseed-<timestamp>.json."},
                    "includeRejected": {"type": "boolean", "default": False}
                },
                "additionalProperties": False
            }
        },
        {
            "name": "cybermem_import",
            "description": "Merge a JSON preseed file into the workspace Cybermem graph.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace": {"type": "string"},
                    "path": {"type": "string", "description": "Input path, relative to workspace unless absolute."}
                },
                "required": ["path"],
                "additionalProperties": False
            }
        }
    ]


def write_response(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def handle_request(message: dict[str, Any]) -> None:
    request_id = message.get("id")
    method = message.get("method")
    try:
        if method == "initialize":
            result = {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            }
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": tool_schema()}
        elif method == "tools/call":
            params = message.get("params") or {}
            result_payload = call_tool(params.get("name"), params.get("arguments") or {})
            result = {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(result_payload, indent=2, sort_keys=True),
                    }
                ]
            }
        elif method and method.startswith("notifications/"):
            return
        else:
            raise ValueError(f"Unknown method: {method}")
        if request_id is not None:
            write_response({"jsonrpc": "2.0", "id": request_id, "result": result})
    except Exception as exc:  # MCP wants tool errors as JSON-RPC errors.
        if request_id is not None:
            write_response(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {
                        "code": -32000,
                        "message": str(exc),
                    },
                }
            )


def main() -> None:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            write_response(
                {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32700, "message": f"Parse error: {exc}"},
                }
            )
            continue
        if isinstance(message, dict):
            handle_request(message)


if __name__ == "__main__":
    main()
