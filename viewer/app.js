const TYPE_COLORS = {
  asset: "#6aa7ff",
  bug: "#ff6b6b",
  invariant: "#47d18c",
  mitigation: "#4cc9d8",
  source: "#f0a84b",
  sink: "#f0a84b",
  primitive: "#77869f",
  chain: "#77869f",
  trajectory: "#8ca66e"
};

const GRAPH_TYPE_STYLES = Object.entries(TYPE_COLORS).map(([type, color]) => ({
  selector: `node[type = "${type}"]`,
  style: { "background-color": color }
}));

const GRAPH_LABEL_ZOOM = 2;

const els = {
  catalogMode: document.getElementById("catalogMode"),
  graphMode: document.getElementById("graphMode"),
  workspaceSelect: document.getElementById("workspaceSelect"),
  statsGrid: document.getElementById("statsGrid"),
  searchInput: document.getElementById("searchInput"),
  typeStrip: document.getElementById("typeStrip"),
  feed: document.getElementById("feed"),
  graphPanel: document.getElementById("graphPanel"),
  graphCanvas: document.getElementById("graphCanvas"),
  graphSummary: document.getElementById("graphSummary"),
  graphDetail: document.getElementById("graphDetail"),
  evidenceModal: document.getElementById("evidenceModal"),
  evidenceTitle: document.getElementById("evidenceTitle"),
  evidenceList: document.getElementById("evidenceList"),
  evidenceClose: document.getElementById("evidenceClose")
};

const app = {
  workspace: "",
  workspaces: [],
  nodeTypes: [],
  activeType: "all",
  query: "",
  mode: "catalog",
  seen: new Map(),
  firstRender: true,
  debounce: null,
  pollTimer: null,
  cy: null,
  graphSignature: "",
  graphNodesById: new Map(),
  graphLabelsVisible: false,
  pendingFocusNodeId: "",
  focusedNodeId: "",
  focusClearTimer: null
};

function formatType(value) {
  return value.replace(/-/g, " ");
}

function formatTime(value) {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function shortGraphLabel(value) {
  const words = String(value || "")
    .replace(/[(){}\[\],:;]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "memory";
  const label = words.slice(0, 4).join(" ");
  return label.length > 30 ? `${label.slice(0, 29)}...` : label;
}

function stat(label, value) {
  const node = document.createElement("div");
  node.className = "stat";
  const labelNode = document.createElement("div");
  labelNode.className = "stat-label";
  labelNode.textContent = label;
  const valueNode = document.createElement("div");
  valueNode.className = "stat-value";
  valueNode.textContent = String(value);
  node.append(labelNode, valueNode);
  return node;
}

function chip(text, className = "meta-chip") {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
}

function clearCatalogFocus() {
  app.pendingFocusNodeId = "";
  app.focusedNodeId = "";
  if (app.focusClearTimer) {
    clearTimeout(app.focusClearTimer);
    app.focusClearTimer = null;
  }
}

function renderWorkspaces() {
  els.workspaceSelect.replaceChildren();
  const values = app.workspaces.length ? app.workspaces : [app.workspace];
  for (const workspace of values) {
    const option = document.createElement("option");
    option.value = workspace;
    option.textContent = workspace;
    option.selected = workspace === app.workspace;
    els.workspaceSelect.append(option);
  }
}

function renderTypeButtons() {
  els.typeStrip.replaceChildren();
  const all = ["all", ...app.nodeTypes];
  for (const type of all) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "type-button";
    button.classList.toggle("is-active", type === app.activeType);
    button.textContent = formatType(type);
    button.addEventListener("click", () => {
      app.activeType = type;
      app.seen.clear();
      app.firstRender = true;
      app.graphSignature = "";
      clearCatalogFocus();
      renderTypeButtons();
      refresh();
    });
    els.typeStrip.append(button);
  }
}

function renderStats(snapshot) {
  const counts = snapshot.counts || {};
  const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
  const latest = snapshot.latestUpdatedAt ? formatTime(snapshot.latestUpdatedAt) : "none";
  els.statsGrid.replaceChildren(
    stat("Nodes", total),
    stat("Edges", snapshot.edgeCount || 0),
    stat("Evidence", snapshot.evidenceCount || 0),
    stat("Updated", latest)
  );
}

function setMode(mode) {
  app.mode = mode;
  els.catalogMode.classList.toggle("is-active", mode === "catalog");
  els.graphMode.classList.toggle("is-active", mode === "graph");
  els.feed.hidden = mode !== "catalog";
  els.graphPanel.hidden = mode !== "graph";
  if (mode === "graph" && app.cy) {
    setTimeout(() => {
      app.cy.resize();
      app.cy.fit(undefined, 32);
    }, 0);
  }
  refresh();
}

function evidenceButton(node) {
  const count = (node.evidence || []).length;
  if (!count) return chip("evidence 0");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "meta-chip evidence-open";
  button.textContent = `evidence ${count}`;
  button.addEventListener("click", () => openEvidence(node));
  return button;
}

function renderEvidence(node, card) {
  const evidence = node.evidence || [];
  if (!evidence.length) return;
  const wrap = document.createElement("div");
  wrap.className = "evidence";
  for (const item of evidence.slice(0, 3)) {
    const row = document.createElement("div");
    row.className = "evidence-item";
    const path = document.createElement("div");
    path.className = "evidence-path";
    path.textContent = [item.kind, item.path].filter(Boolean).join(" ");
    const summary = document.createElement("div");
    summary.className = "evidence-summary";
    summary.textContent = item.summary || "";
    row.append(path);
    if (item.summary) row.append(summary);
    wrap.append(row);
  }
  card.append(wrap);
}

function renderNode(node, changed) {
  const card = document.createElement("article");
  card.className = "memory-card";
  card.dataset.nodeId = node.id;
  card.tabIndex = -1;
  card.classList.add(`type-border-${node.type}`);
  if (changed) card.classList.add("is-changed");
  if (app.focusedNodeId === node.id) card.classList.add("is-focused");

  const head = document.createElement("div");
  head.className = "card-head";

  const titleLine = document.createElement("div");
  titleLine.className = "title-line";
  const badgeRow = document.createElement("div");
  badgeRow.className = "badge-row";
  const badge = chip(formatType(node.type), `badge type-${node.type}`);
  badgeRow.append(badge);
  const title = document.createElement("h2");
  title.className = "node-title";
  title.textContent = node.title;
  titleLine.append(badgeRow, title);

  const status = chip(`${node.status} ${Math.round(Number(node.confidence || 0) * 100)}%`, "status-pill");
  head.append(titleLine, status);
  card.append(head);

  if (node.summary) {
    const summary = document.createElement("p");
    summary.className = "summary";
    summary.textContent = node.summary;
    card.append(summary);
  }

  if (node.body) {
    const body = document.createElement("p");
    body.className = "body";
    body.textContent = node.body;
    card.append(body);
  }

  const meta = document.createElement("div");
  meta.className = "meta-row";
  meta.append(
    chip(`updated ${formatTime(node.updatedAt)}`),
    chip(`rev ${node.revision || 1}`),
    evidenceButton(node),
    chip(`links ${(node.links || []).length}`)
  );
  card.append(meta);

  if (node.tags && node.tags.length) {
    const tags = document.createElement("div");
    tags.className = "tag-row";
    for (const tag of node.tags) tags.append(chip(tag, "tag"));
    card.append(tags);
  }

  renderEvidence(node, card);
  return card;
}

function focusPendingNode() {
  if (!app.pendingFocusNodeId) return;
  const nodeId = app.pendingFocusNodeId;
  const card = [...els.feed.querySelectorAll(".memory-card")].find(
    (item) => item.dataset.nodeId === nodeId
  );
  if (!card) return;
  app.pendingFocusNodeId = "";
  app.focusedNodeId = nodeId;
  if (app.focusClearTimer) clearTimeout(app.focusClearTimer);
  app.focusClearTimer = setTimeout(() => {
    app.focusedNodeId = "";
    app.focusClearTimer = null;
    const focused = [...els.feed.querySelectorAll(".memory-card")].find(
      (item) => item.dataset.nodeId === nodeId
    );
    if (focused) focused.classList.remove("is-focused");
  }, 2600);
  card.classList.add("is-focused");
  card.focus({ preventScroll: true });
  card.scrollIntoView({ behavior: "smooth", block: "center" });
}

function detailRow(label, value) {
  if (!value) return null;
  const row = document.createElement("div");
  row.className = "evidence-summary";
  row.textContent = `${label}: ${value}`;
  return row;
}

function locatorBlock(locator) {
  if (!locator || !Object.keys(locator).length) return null;
  const pre = document.createElement("pre");
  pre.className = "evidence-locator";
  pre.textContent = JSON.stringify(locator, null, 2);
  return pre;
}

function openEvidence(node) {
  els.evidenceTitle.textContent = node.title;
  const evidence = node.evidence || [];
  if (!evidence.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No evidence refs.";
    els.evidenceList.replaceChildren(empty);
  } else {
    const rows = evidence.map((item) => {
      const detail = document.createElement("article");
      detail.className = "evidence-detail";

      const head = document.createElement("div");
      head.className = "evidence-detail-head";
      const kind = document.createElement("span");
      kind.className = "evidence-kind";
      kind.textContent = item.kind || "evidence";
      const created = document.createElement("span");
      created.className = "evidence-created";
      created.textContent = item.createdAt ? formatTime(item.createdAt) : "";
      head.append(kind, created);
      detail.append(head);

      for (const row of [
        detailRow("path", item.path),
        detailRow("base", item.pathBase),
        detailRow("summary", item.summary)
      ]) {
        if (row) detail.append(row);
      }

      const locator = locatorBlock(item.locator);
      if (locator) detail.append(locator);
      return detail;
    });
    els.evidenceList.replaceChildren(...rows);
  }
  els.evidenceModal.hidden = false;
  document.body.classList.add("modal-open");
}

function closeEvidence() {
  els.evidenceModal.hidden = true;
  document.body.classList.remove("modal-open");
}

function renderFeed(snapshot) {
  const nodes = snapshot.nodes || [];
  if (!snapshot.dbExists) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No Cybermem database for this workspace yet.";
    els.feed.replaceChildren(empty);
    return;
  }
  if (!nodes.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No matching memory records.";
    els.feed.replaceChildren(empty);
    return;
  }

  const nextSeen = new Map();
  const cards = nodes.map((node) => {
    const previous = app.seen.get(node.id);
    const changed = !app.firstRender && previous !== node.updatedAt;
    nextSeen.set(node.id, node.updatedAt);
    return renderNode(node, changed);
  });
  app.seen = nextSeen;
  app.firstRender = false;
  els.feed.replaceChildren(...cards);
  focusPendingNode();
}

function graphSignature(graph) {
  const nodePart = (graph.nodes || [])
    .map((node) => `${node.id}:${node.updatedAt}`)
    .sort()
    .join("|");
  const edgePart = (graph.edges || [])
    .map((edge) => `${edge.fromId}:${edge.relation}:${edge.toId}:${edge.updatedAt}`)
    .sort()
    .join("|");
  return `${nodePart}::${edgePart}`;
}

function graphIsDense(graph) {
  const nodeCount = (graph.nodes || []).length;
  const edgeCount = (graph.edges || []).length;
  return nodeCount >= 70 || edgeCount / Math.max(nodeCount, 1) > 1.4;
}

function denseGraphPositions(graph) {
  const nodes = graph.nodes || [];
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges || []) {
    degree.set(edge.fromId, (degree.get(edge.fromId) || 0) + 1);
    degree.set(edge.toId, (degree.get(edge.toId) || 0) + 1);
  }

  const sorted = [...nodes].sort((left, right) => {
    const degreeDelta = (degree.get(right.id) || 0) - (degree.get(left.id) || 0);
    if (degreeDelta) return degreeDelta;
    const typeDelta = left.type.localeCompare(right.type);
    if (typeDelta) return typeDelta;
    return left.title.localeCompare(right.title);
  });

  const positions = new Map();
  if (!sorted.length) return positions;
  positions.set(sorted[0].id, { x: 0, y: 0 });

  let index = 1;
  let ring = 1;
  const ringGap = 120;
  while (index < sorted.length) {
    const capacity = 10 + ring * 10;
    const radius = ring * ringGap;
    const angleOffset = ring % 2 ? -Math.PI / 2 : -Math.PI / 2 + Math.PI / capacity;
    for (let slot = 0; slot < capacity && index < sorted.length; slot += 1) {
      const angle = angleOffset + (slot / capacity) * Math.PI * 2;
      positions.set(sorted[index].id, {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius
      });
      index += 1;
    }
    ring += 1;
  }
  return positions;
}

function graphElements(graph) {
  app.graphNodesById = new Map((graph.nodes || []).map((node) => [node.id, node]));
  const densePositions = graphIsDense(graph) ? denseGraphPositions(graph) : new Map();
  const nodes = (graph.nodes || []).map((node) => {
    const element = {
      data: {
        id: node.id,
        label: shortGraphLabel(node.title),
        fullLabel: node.title,
        type: node.type,
        status: node.status,
        confidence: node.confidence,
        summary: node.summary,
        updatedAt: node.updatedAt
      }
    };
    const position = densePositions.get(node.id);
    if (position) element.position = position;
    return element;
  });
  const edges = (graph.edges || []).map((edge, index) => {
    const source = app.graphNodesById.get(edge.fromId);
    const target = app.graphNodesById.get(edge.toId);
    return {
      data: {
        id: `edge-${index}-${edge.fromId}-${edge.relation}-${edge.toId}`,
        source: edge.fromId,
        target: edge.toId,
        label: edge.relation,
        note: edge.note,
        fromTitle: source ? source.title : edge.fromId,
        toTitle: target ? target.title : edge.toId,
        updatedAt: edge.updatedAt
      }
    };
  });
  return [...nodes, ...edges];
}

function renderGraphSummary(graph) {
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const typeText = app.activeType === "all" ? "all types" : formatType(app.activeType);
  const queryText = app.query ? `query ${app.query}` : "no query";
  els.graphSummary.replaceChildren(
    chip(`nodes ${nodes.length}`),
    chip(`relations ${edges.length}`),
    chip(typeText),
    chip(queryText)
  );
}

function renderGraphDetail(data, group) {
  els.graphDetail.hidden = false;
  els.graphDetail.replaceChildren();
  const badgeRow = document.createElement("div");
  badgeRow.className = "badge-row";

  if (group === "nodes") {
    badgeRow.append(chip(formatType(data.type), `badge type-${data.type}`));
    const title = document.createElement("h2");
    title.className = "graph-detail-title";
    title.textContent = data.fullLabel || data.label;
    const body = document.createElement("p");
    body.className = "graph-detail-body";
    body.textContent = data.summary || "";
    const meta = document.createElement("div");
    meta.className = "meta-row";
    meta.append(
      chip(data.status || "draft"),
      chip(`${Math.round(Number(data.confidence || 0) * 100)}%`),
      chip(`updated ${formatTime(data.updatedAt)}`)
    );
    els.graphDetail.append(badgeRow, title, body, meta);
    return;
  }

  badgeRow.append(chip(data.label, "badge"));
  const title = document.createElement("h2");
  title.className = "graph-detail-title";
  title.textContent = `${data.fromTitle} -> ${data.toTitle}`;
  const body = document.createElement("p");
  body.className = "graph-detail-body";
  body.textContent = data.note || "";
  const meta = document.createElement("div");
  meta.className = "meta-row";
  meta.append(chip(`updated ${formatTime(data.updatedAt)}`));
  els.graphDetail.append(badgeRow, title, body, meta);
}

function clearGraph(message) {
  if (app.cy) {
    app.cy.destroy();
    app.cy = null;
  }
  app.graphSignature = "";
  els.graphCanvas.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty graph-empty";
  empty.textContent = message;
  els.graphCanvas.append(empty);
  els.graphDetail.hidden = true;
}

function focusCatalogNode(nodeId) {
  app.pendingFocusNodeId = nodeId;
  els.graphDetail.hidden = true;
  setMode("catalog");
}

function updateGraphLabels() {
  if (!app.cy) return;
  const showLabels = app.cy.zoom() >= GRAPH_LABEL_ZOOM;
  if (showLabels === app.graphLabelsVisible) return;
  app.graphLabelsVisible = showLabels;
  if (showLabels) {
    app.cy.nodes().addClass("show-labels");
  } else {
    app.cy.nodes().removeClass("show-labels");
  }
}

function graphLayoutOptions(graph) {
  const nodeCount = (graph.nodes || []).length;
  const edgeCount = (graph.edges || []).length;
  if (nodeCount < 3) {
    return {
      name: "circle",
      animate: false,
      fit: true,
      padding: 54
    };
  }
  if (nodeCount >= 70 || edgeCount / Math.max(nodeCount, 1) > 1.4) {
    return {
      name: "preset",
      animate: false,
      fit: true,
      padding: 46
    };
  }
  return {
    name: "cose",
    animate: false,
    fit: true,
    padding: 54,
    componentSpacing: 90,
    edgeElasticity: () => 0.03,
    gravity: 0.01,
    idealEdgeLength: () => 240,
    nestingFactor: 1.2,
    nodeOverlap: 40,
    nodeRepulsion: () => 2000000,
    numIter: 3200
  };
}

function renderGraph(graph) {
  renderGraphSummary(graph);
  if (!graph.dbExists) {
    clearGraph("No Cybermem database for this workspace yet.");
    return;
  }
  if (!graph.nodes || !graph.nodes.length) {
    clearGraph("No graph nodes.");
    return;
  }

  const signature = graphSignature(graph);
  if (app.cy && signature === app.graphSignature) return;
  app.graphSignature = signature;
  app.graphLabelsVisible = false;
  if (app.cy) app.cy.destroy();

  app.cy = cytoscape({
    container: els.graphCanvas,
    elements: graphElements(graph),
    minZoom: 0.25,
    maxZoom: 2.4,
    style: [
      {
        selector: "node",
        style: {
          "background-color": "#9aa7b5",
          "border-color": "#0b1017",
          "border-width": 1.5,
          "color": "#edf3fa",
          "font-size": 8,
          "height": 18,
          "label": "",
          "min-zoomed-font-size": 10,
          "overlay-opacity": 0,
          "text-background-color": "#0b1017",
          "text-background-opacity": 0.76,
          "text-background-padding": 2,
          "text-margin-y": -6,
          "text-max-width": 78,
          "text-wrap": "wrap",
          "width": 18
        }
      },
      {
        selector: "node.show-labels",
        style: {
          "label": "data(label)"
        }
      },
      ...GRAPH_TYPE_STYLES,
      {
        selector: "edge",
        style: {
          "curve-style": "bezier",
          "font-size": 9,
          "label": "",
          "line-color": "#526172",
          "opacity": 0.72,
          "target-arrow-color": "#526172",
          "target-arrow-shape": "triangle",
          "text-background-color": "#0b1017",
          "text-background-opacity": 0.8,
          "text-background-padding": 2,
          "text-rotation": "autorotate",
          "width": 1.5
        }
      },
      {
        selector: "node:selected",
        style: {
          "border-color": "#edf3fa",
          "border-width": 3
        }
      },
      {
        selector: "edge:selected",
        style: {
          "label": "data(label)",
          "line-color": "#6aa7ff",
          "opacity": 1,
          "target-arrow-color": "#6aa7ff"
        }
      }
    ]
  });

  app.cy.on("tap", "node", (event) => focusCatalogNode(event.target.id()));
  app.cy.on("tap", "edge", (event) => renderGraphDetail(event.target.data(), "edges"));
  app.cy.on("tap", (event) => {
    if (event.target === app.cy) els.graphDetail.hidden = true;
  });
  app.cy.on("zoom", updateGraphLabels);
  app.cy.on("mouseover", "node, edge", () => {
    els.graphCanvas.style.cursor = "pointer";
  });
  app.cy.on("mouseout", "node, edge", () => {
    els.graphCanvas.style.cursor = "";
  });

  const layout = app.cy.layout(graphLayoutOptions(graph));
  layout.on("layoutstop", updateGraphLabels);
  layout.run();
  updateGraphLabels();
}

function snapshotParams(limit) {
  const params = new URLSearchParams();
  params.set("workspace", app.workspace);
  params.set("limit", String(limit));
  if (app.query) params.set("query", app.query);
  if (app.activeType !== "all") params.set("types", app.activeType);
  return params;
}

async function loadState() {
  const response = await fetch("/api/state", { cache: "no-store" });
  const state = await response.json();
  app.workspace = state.workspace || "";
  app.workspaces = state.workspaces || [];
  app.nodeTypes = state.nodeTypes || [];
  renderWorkspaces();
  renderTypeButtons();
}

async function refresh() {
  if (document.hidden || !app.workspace) return;
  try {
    const catalogLimit = app.pendingFocusNodeId ? 250 : 100;
    const snapshotResponse = await fetch(
      `/api/snapshot?${snapshotParams(catalogLimit).toString()}`,
      { cache: "no-store" }
    );
    const snapshot = await snapshotResponse.json();
    if (!snapshotResponse.ok || snapshot.error) throw new Error(snapshot.error || "snapshot failed");
    renderStats(snapshot);

    if (app.mode === "catalog") {
      renderFeed(snapshot);
      return;
    }

    const graphResponse = await fetch(`/api/graph?${snapshotParams(250).toString()}`, { cache: "no-store" });
    const graph = await graphResponse.json();
    if (!graphResponse.ok || graph.error) throw new Error(graph.error || "graph failed");
    renderGraph(graph);
  } catch (error) {
    if (app.mode === "catalog") {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Viewer is offline.";
      els.feed.replaceChildren(empty);
    } else {
      clearGraph("Viewer is offline.");
    }
  }
}

function bind() {
  els.catalogMode.addEventListener("click", () => setMode("catalog"));
  els.graphMode.addEventListener("click", () => setMode("graph"));

  els.workspaceSelect.addEventListener("change", () => {
    app.workspace = els.workspaceSelect.value;
    app.seen.clear();
    app.firstRender = true;
    app.graphSignature = "";
    clearCatalogFocus();
    refresh();
  });

  els.evidenceClose.addEventListener("click", closeEvidence);
  els.evidenceModal.addEventListener("click", (event) => {
    if (event.target === els.evidenceModal) closeEvidence();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.evidenceModal.hidden) closeEvidence();
  });

  els.searchInput.addEventListener("input", () => {
    app.query = els.searchInput.value.trim();
    clearTimeout(app.debounce);
    app.debounce = setTimeout(() => {
      app.seen.clear();
      app.firstRender = true;
      app.graphSignature = "";
      clearCatalogFocus();
      refresh();
    }, 220);
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });

  window.addEventListener("resize", () => {
    if (app.cy && app.mode === "graph") {
      app.cy.resize();
      app.cy.fit(undefined, 32);
    }
  });
}

async function boot() {
  try {
    await loadState();
    bind();
    await refresh();
    app.pollTimer = setInterval(refresh, 1600);
  } catch (error) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Viewer is offline.";
    els.feed.replaceChildren(empty);
  }
}

boot();
