import json
import tempfile
import unittest
from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "mcp"))

import cybermem_server as cybermem


class CybermemServerTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.workspace = Path(self.tempdir.name)
        self.conn = cybermem.connect(self.workspace)

    def tearDown(self):
        self.conn.close()
        self.tempdir.cleanup()

    def test_save_search_get_link_and_export(self):
        asset = cybermem.save_node(
            self.conn,
            {
                "type": "asset",
                "title": "Example API",
                "summary": "Public API service under review.",
                "tags": ["api", "example"],
            },
        )
        invariant = cybermem.save_node(
            self.conn,
            {
                "type": "invariant",
                "title": "Admin routes require admin role",
                "summary": "Requests to admin routes must be authorized as admin.",
                "status": "suspected",
                "confidence": 0.7,
                "assetIds": [asset["id"]],
                "evidence": [
                    {
                        "kind": "code",
                        "pathBase": "workspace",
                        "path": "src/admin.py",
                        "locator": {"lineStart": 10, "lineEnd": 20},
                        "summary": "Admin route registration is centralized.",
                    }
                ],
            },
        )
        link = cybermem.link_nodes(
            self.conn,
            {
                "fromId": invariant["id"],
                "toId": asset["id"],
                "relation": "belongs_to",
            },
        )

        results = cybermem.search_nodes(
            self.conn,
            {
                "query": "admin",
                "types": ["invariant"],
                "assetIds": [asset["id"]],
                "includeEvidence": True,
            },
        )
        loaded = cybermem.get_node(self.conn, {"id": invariant["id"]})
        exported = cybermem.export_preseed(
            self.conn,
            self.workspace,
            {"path": ".cybermem/exports/test-preseed.json"},
        )

        self.assertEqual(link["relation"], "belongs_to")
        self.assertEqual(results["count"], 1)
        self.assertEqual(loaded["evidence"][0]["path"], "src/admin.py")
        self.assertEqual(exported["nodeCount"], 2)
        self.assertTrue((self.workspace / ".cybermem/exports/test-preseed.json").exists())

    def test_save_merges_by_type_and_title(self):
        first = cybermem.save_node(
            self.conn,
            {
                "type": "mitigation",
                "title": "Strict CSP",
                "summary": "Initial note.",
                "tags": ["browser"],
                "typeData": {"headers": {"csp": "default-src 'self'"}},
            },
        )
        second = cybermem.save_node(
            self.conn,
            {
                "type": "mitigation",
                "title": "Strict CSP",
                "summary": "Refined note.",
                "tags": ["xss"],
                "typeData": {"enforced": True},
            },
        )

        self.assertEqual(first["id"], second["id"])
        self.assertEqual(second["summary"], "Refined note.")
        self.assertEqual(second["tags"], ["browser", "xss"])
        self.assertTrue(second["typeData"]["enforced"])
        self.assertEqual(second["revision"], 2)

    def test_bug_history_node_type(self):
        bug = cybermem.save_node(
            self.conn,
            {
                "type": "bug",
                "title": "CVE-2026-0001 auth bypass",
                "summary": "Historical auth bypass fixed after patch diff review.",
                "status": "confirmed",
                "confidence": 0.9,
                "tags": ["cve", "patch-diff", "auth"],
                "typeData": {
                    "cve": "CVE-2026-0001",
                    "source": "patch-diff",
                    "fixedIn": "1.2.3",
                    "recurrenceRisk": "Check sibling auth middleware for the same missing role guard.",
                },
                "evidence": [
                    {
                        "kind": "code",
                        "pathBase": "workspace",
                        "path": "src/auth/middleware.py",
                        "locator": {"symbol": "require_role"},
                        "summary": "Patch added the missing role guard.",
                    }
                ],
            },
        )
        results = cybermem.search_nodes(
            self.conn,
            {"query": "auth bypass", "types": ["bug"], "includeEvidence": True},
        )

        self.assertEqual(bug["type"], "bug")
        self.assertEqual(results["count"], 1)
        self.assertEqual(results["nodes"][0]["typeData"]["cve"], "CVE-2026-0001")

    def test_viewer_snapshot_reads_memory_without_viewer_tool(self):
        cybermem.save_node(
            self.conn,
            {
                "type": "bug",
                "title": "Patch comment mentions bounds bug",
                "summary": "Security-relevant code comment noted a historical bounds bug.",
                "status": "confirmed",
            },
        )

        snapshot = cybermem.viewer_snapshot(
            self.workspace,
            query="bounds",
            types=["bug"],
            limit=20,
        )
        tool_names = {tool["name"] for tool in cybermem.tool_schema()}

        self.assertTrue(snapshot["dbExists"])
        self.assertEqual(snapshot["counts"]["bug"], 1)
        self.assertEqual(snapshot["nodes"][0]["type"], "bug")
        self.assertNotIn("cybermem_viewer", tool_names)

    def test_viewer_graph_returns_memory_relations(self):
        source = cybermem.save_node(
            self.conn,
            {
                "type": "source",
                "title": "Comment parser",
                "summary": "Attacker-controlled parser entrypoint.",
            },
        )
        sink = cybermem.save_node(
            self.conn,
            {
                "type": "sink",
                "title": "Bounds copy",
                "summary": "Sensitive bounded copy sink.",
            },
        )
        cybermem.link_nodes(
            self.conn,
            {
                "fromId": source["id"],
                "toId": sink["id"],
                "relation": "flows_to",
            },
        )

        graph = cybermem.viewer_graph(self.workspace, query="parser", limit=20)
        full_graph = cybermem.viewer_graph(self.workspace, limit=20)

        self.assertEqual(graph["nodes"][0]["type"], "source")
        self.assertEqual(len(full_graph["edges"]), 1)
        self.assertEqual(full_graph["edges"][0]["relation"], "flows_to")

    def test_viewer_limit_allows_catalog_focus_fetches(self):
        self.assertEqual(cybermem.parse_viewer_limit("250", 80), 250)
        self.assertEqual(cybermem.parse_viewer_limit("900", 80), 500)
        self.assertEqual(cybermem.parse_viewer_limit("not-a-number", 80), 80)

    def test_rejects_absolute_artifact_paths(self):
        with self.assertRaises(ValueError):
            cybermem.save_node(
                self.conn,
                {
                    "type": "primitive",
                    "title": "Absolute path evidence",
                    "evidence": [
                        {
                            "kind": "artifact",
                            "pathBase": "workspace",
                            "path": "/tmp/pov.txt",
                        }
                    ],
                },
            )

    def test_import_preseed_merges_nodes_edges_and_evidence(self):
        preseed = {
            "schemaVersion": cybermem.SCHEMA_VERSION,
            "nodes": [
                {
                    "id": "asset-demo",
                    "type": "asset",
                    "title": "Demo",
                    "summary": "Demo asset.",
                    "status": "confirmed",
                    "confidence": 0.8,
                    "assetIds": [],
                    "tags": ["demo"],
                    "typeData": {},
                },
                {
                    "id": "source-demo-login",
                    "type": "source",
                    "title": "Login request",
                    "summary": "Attacker-controlled login input.",
                    "assetIds": ["asset-demo"],
                    "tags": [],
                    "typeData": {},
                },
            ],
            "evidence": [
                {
                    "id": "evidence-demo",
                    "nodeId": "source-demo-login",
                    "kind": "code",
                    "pathBase": "workspace",
                    "path": "src/login.py",
                    "locator": {"symbol": "login"},
                    "summary": "Login accepts request body parameters.",
                }
            ],
            "edges": [
                {
                    "fromId": "source-demo-login",
                    "toId": "asset-demo",
                    "relation": "belongs_to",
                    "note": "",
                }
            ],
        }
        path = self.workspace / "preseed.json"
        path.write_text(json.dumps(preseed), encoding="utf-8")

        result = cybermem.import_preseed(self.conn, self.workspace, {"path": "preseed.json"})
        loaded = cybermem.get_node(self.conn, {"id": "source-demo-login"})

        self.assertEqual(result["nodeCount"], 2)
        self.assertEqual(result["edgeCount"], 1)
        self.assertEqual(result["evidenceCount"], 1)
        self.assertEqual(loaded["evidence"][0]["id"], "evidence-demo")
        self.assertEqual(loaded["links"][0]["relation"], "belongs_to")


if __name__ == "__main__":
    unittest.main()
