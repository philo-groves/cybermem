const els = {
  liveStatus: document.getElementById("liveStatus"),
  liveText: document.getElementById("liveText"),
  workspaceSelect: document.getElementById("workspaceSelect"),
  workspaceInput: document.getElementById("workspaceInput"),
  workspaceOpen: document.getElementById("workspaceOpen"),
  statsGrid: document.getElementById("statsGrid"),
  searchInput: document.getElementById("searchInput"),
  typeStrip: document.getElementById("typeStrip"),
  feed: document.getElementById("feed"),
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
  seen: new Map(),
  firstRender: true,
  debounce: null,
  pollTimer: null
};

function setLive(text, mode) {
  els.liveText.textContent = text;
  els.liveStatus.classList.toggle("is-ok", mode === "ok");
  els.liveStatus.classList.toggle("is-error", mode === "error");
}

function formatType(value) {
  return value.replace(/-/g, " ");
}

function formatTime(value) {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
  els.workspaceInput.value = app.workspace || "";
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

function chip(text, className = "meta-chip") {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
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
  card.classList.add(`type-border-${node.type}`);
  if (changed) card.classList.add("is-changed");

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
  const params = new URLSearchParams();
  params.set("workspace", app.workspace);
  params.set("limit", "100");
  if (app.query) params.set("query", app.query);
  if (app.activeType !== "all") params.set("types", app.activeType);
  try {
    const response = await fetch(`/api/snapshot?${params.toString()}`, { cache: "no-store" });
    const snapshot = await response.json();
    if (!response.ok || snapshot.error) throw new Error(snapshot.error || "snapshot failed");
    renderStats(snapshot);
    renderFeed(snapshot);
    setLive("live", "ok");
  } catch (error) {
    setLive("offline", "error");
  }
}

function bind() {
  els.workspaceSelect.addEventListener("change", () => {
    app.workspace = els.workspaceSelect.value;
    els.workspaceInput.value = app.workspace;
    app.seen.clear();
    app.firstRender = true;
    refresh();
  });

  function openWorkspace() {
    const value = els.workspaceInput.value.trim();
    if (!value) return;
    app.workspace = value;
    app.workspaces = [value, ...app.workspaces.filter((item) => item !== value)];
    app.seen.clear();
    app.firstRender = true;
    renderWorkspaces();
    refresh();
  }

  els.workspaceOpen.addEventListener("click", openWorkspace);
  els.workspaceInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") openWorkspace();
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
      refresh();
    }, 220);
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
}

async function boot() {
  try {
    await loadState();
    bind();
    await refresh();
    app.pollTimer = setInterval(refresh, 1600);
  } catch (error) {
    setLive("offline", "error");
  }
}

boot();
