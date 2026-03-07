(function () {
  "use strict";

  const BLOCK = 18;
  const CELL = 7;
  const SLOT = CELL * BLOCK;
  const BOX = 5 * BLOCK;
  const LINE_LEN = 2 * BLOCK;

  /** Base URL for API (e.g. "" for same origin, or "/taleshed" if behind a path proxy). Set window.TALESHED_API_BASE if needed. */
  function getApiBase() {
    return (typeof window !== "undefined" && window.TALESHED_API_BASE) || "";
  }

  function getApiKey() {
    const params = new URLSearchParams(window.location.search);
    return params.get("api") || "";
  }

  function apiUrl(path) {
    const base = getApiBase();
    const key = getApiKey();
    const sep = path.includes("?") ? "&" : "?";
    return base + path + (key ? sep + "api=" + encodeURIComponent(key) : "");
  }

  let allNodes = [];
  let locations = [];
  let minGridX = 0;
  let minGridY = 0;
  let skipNextClick = false;
  let panState = null;
  let dragState = null;

  function showApiMessage(message) {
    var warn = document.getElementById("api-warn");
    if (warn) {
      warn.textContent = message;
      warn.classList.remove("hidden");
    }
  }
  function hideApiMessage() {
    var warn = document.getElementById("api-warn");
    if (warn) warn.classList.add("hidden");
  }

  function fetchGraph() {
    const key = getApiKey();
    if (!key) {
      showApiMessage("No API key given. Add ?api=YOUR_KEY to the URL to load data.");
      return;
    }
    hideApiMessage();
    fetch(apiUrl("/api/world-graph"))
      .then((r) => {
        if (r.status === 401) {
          showApiMessage("Invalid or incorrect API key. Use ?api=YOUR_KEY in the URL.");
          throw new Error("Unauthorized");
        }
        return r.json();
      })
      .then((rows) => {
        allNodes = rows;
        locations = rows.filter((n) => n.node_type === "location");
        // Default grid position for locations without one
        locations.forEach((loc, i) => {
          if (loc.grid_x == null && loc.grid_x !== 0) loc.grid_x = i;
          if (loc.grid_y == null && loc.grid_y !== 0) loc.grid_y = 0;
        });
        render();
        var nodesPanel = document.getElementById("panel-nodes");
        if (nodesPanel && nodesPanel.classList.contains("active")) renderNodes();
      })
      .catch((e) => {
        if (e.message !== "Unauthorized") console.error(e);
      });
  }

  function parseExits(str) {
    if (!str || !str.trim()) return [];
    try {
      const arr = JSON.parse(str);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function eventToSlot(wrap, clientX, clientY) {
    const rect = wrap.getBoundingClientRect();
    const layerX = wrap.scrollLeft + (clientX - rect.left);
    const layerY = wrap.scrollTop + (clientY - rect.top);
    const sx = minGridX + Math.floor(layerX / SLOT);
    const sy = minGridY + Math.floor(layerY / SLOT);
    return { gx: sx, gy: sy };
  }

  function render() {
    const wrap = document.getElementById("grid-wrap");
    const content = document.getElementById("grid-content");
    const svg = document.getElementById("exit-lines");
    const layer = document.getElementById("locations-layer");
    if (!content || !layer) return;

    const minX = Math.min(0, ...locations.map((l) => l.grid_x ?? 0));
    const minY = Math.min(0, ...locations.map((l) => l.grid_y ?? 0));
    minGridX = minX;
    minGridY = minY;
    const maxX = Math.max(0, ...locations.map((l) => (l.grid_x ?? 0) + 1));
    const maxY = Math.max(0, ...locations.map((l) => (l.grid_y ?? 0) + 1));
    const width = (maxX - minX + 1) * SLOT + BOX;
    const height = (maxY - minY + 1) * SLOT + BOX;

    content.style.width = width + "px";
    content.style.height = height + "px";
    layer.innerHTML = "";

    // Exit lines (2 blocks from edge of box)
    const pathParts = [];
    locations.forEach((loc) => {
      const gx = loc.grid_x ?? 0;
      const gy = loc.grid_y ?? 0;
      const exits = parseExits(loc.exits);
      const baseX = (gx - minX) * SLOT;
      const baseY = (gy - minY) * SLOT;
      const centerX = baseX + BOX / 2;
      const centerY = baseY + BOX / 2;

      exits.forEach((e) => {
        const dir = (e.direction || "").toLowerCase();
        let x1, y1, x2, y2;
        if (dir === "north") {
          x1 = centerX; y1 = baseY;
          x2 = centerX; y2 = y1 - LINE_LEN;
        } else if (dir === "south") {
          x1 = centerX; y1 = baseY + BOX;
          x2 = centerX; y2 = y1 + LINE_LEN;
        } else if (dir === "east") {
          x1 = baseX + BOX; y1 = centerY;
          x2 = x1 + LINE_LEN; y2 = centerY;
        } else if (dir === "west") {
          x1 = baseX; y1 = centerY;
          x2 = x1 - LINE_LEN; y2 = centerY;
        } else return;
        pathParts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`);
      });
    });
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.innerHTML = pathParts.join("");

    locations.forEach((loc) => {
      const gx = loc.grid_x ?? 0;
      const gy = loc.grid_y ?? 0;
      const left = (gx - minX) * SLOT;
      const top = (gy - minY) * SLOT;
      const box = document.createElement("div");
      box.className = "location-box";
      box.textContent = loc.name || loc.node_id;
      box.style.left = left + "px";
      box.style.top = top + "px";
      box.dataset.nodeId = loc.node_id;
      box.addEventListener("click", () => {
        if (skipNextClick) {
          skipNextClick = false;
          return;
        }
        openModal(loc.node_id);
      });
      layer.appendChild(box);
    });
  }

  function setupPanAndDrag() {
    const wrap = document.getElementById("grid-wrap");
    if (!wrap) {
      console.warn("TaleShed: grid-wrap not found, pan/drag/dblclick disabled.");
      return;
    }

    function onMove(e) {
      if (panState) {
        wrap.scrollLeft = panState.startScrollLeft + (panState.startX - e.clientX);
        wrap.scrollTop = panState.startScrollTop + (panState.startY - e.clientY);
      } else if (dragState) {
        const dx = e.clientX - dragState.startX;
        const dy = e.clientY - dragState.startY;
        const dgx = Math.round(dx / SLOT);
        const dgy = Math.round(dy / SLOT);
        const loc = locations.find((l) => l.node_id === dragState.nodeId);
        if (loc) {
          loc.grid_x = dragState.startGx + dgx;
          loc.grid_y = dragState.startGy + dgy;
          render();
        }
      }
    }

    function onUp() {
      if (dragState) {
        const loc = allNodes.find((n) => n.node_id === dragState.nodeId);
        if (loc) {
          const payload = {
            node_type: loc.node_type,
            name: loc.name,
            base_description: loc.base_description ?? "",
            adjectives: typeof loc.adjectives === "string" ? loc.adjectives : JSON.stringify(loc.adjectives ?? []),
            location_id: loc.location_id ?? null,
            is_active: loc.is_active != null ? loc.is_active : 1,
            meta: loc.meta ?? null,
            grid_x: loc.grid_x,
            grid_y: loc.grid_y,
            exits: typeof loc.exits === "string" ? loc.exits : JSON.stringify(loc.exits ?? []),
          };
          fetch(apiUrl("/api/world-graph/" + encodeURIComponent(dragState.nodeId)), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
            .then((r) => {
              if (r.ok) fetchGraph();
            })
            .catch(() => {});
          skipNextClick = true;
        }
        dragState = null;
      }
      panState = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    wrap.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const onBox = e.target.closest(".location-box");
      if (onBox) {
        const nodeId = onBox.dataset.nodeId;
        const loc = locations.find((l) => l.node_id === nodeId);
        if (!loc) return;
        dragState = {
          nodeId,
          startGx: loc.grid_x ?? 0,
          startGy: loc.grid_y ?? 0,
          startX: e.clientX,
          startY: e.clientY,
        };
      } else {
        panState = {
          startScrollLeft: wrap.scrollLeft,
          startScrollTop: wrap.scrollTop,
          startX: e.clientX,
          startY: e.clientY,
        };
      }
      if (panState) document.body.style.cursor = "grabbing";
      else if (dragState) document.body.style.cursor = "move";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    wrap.addEventListener("mouseover", (e) => {
      if (panState || dragState) return;
      if (e.target.closest(".location-box")) wrap.style.cursor = "pointer";
      else wrap.style.cursor = "grab";
    });
    wrap.addEventListener("mouseout", () => {
      if (!panState && !dragState) wrap.style.cursor = "";
    });

    wrap.addEventListener("dblclick", (e) => {
      const box = e.target.closest(".location-box");
      if (box && box.dataset.nodeId) {
        openModal(box.dataset.nodeId);
        return;
      }
      const { gx, gy } = eventToSlot(wrap, e.clientX, e.clientY);
      const nodeId = "room_" + gx + "_" + gy;
      const body = {
        node_id: nodeId,
        node_type: "location",
        name: "New Room",
        base_description: "",
        adjectives: "[]",
        location_id: null,
        is_active: 1,
        meta: null,
        grid_x: gx,
        grid_y: gy,
        exits: "[]",
      };
      fetch(apiUrl("/api/world-graph"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then((r) => {
          if (r.status === 409) {
            return fetch(apiUrl("/api/world-graph"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ...body,
                node_id: "room_" + gx + "_" + gy + "_" + Date.now(),
              }),
            });
          }
          return r;
        })
        .then((r) => {
          if (r.status === 401) {
            showApiMessage("Invalid or incorrect API key. Use ?api=YOUR_KEY in the URL.");
            return;
          }
          if (!r.ok) return r.json().then((j) => Promise.reject(new Error(j.error || r.statusText)));
          return r.json();
        })
        .then(() => fetchGraph())
        .catch((err) => alert("Add room failed: " + (err.message || err)));
    });
  }

  function closeModal() {
    document.getElementById("modal").classList.add("hidden");
    document.getElementById("modal-backdrop").classList.add("hidden");
  }

  document.getElementById("modal-delete").addEventListener("click", () => {
    const nodeId = document.getElementById("edit-node_id").value;
    if (!nodeId) return;
    const name = document.getElementById("edit-name").value || nodeId;
    if (!confirm('Delete "' + name + '" (node_id: ' + nodeId + ")? This cannot be undone.")) return;
    fetch(apiUrl("/api/world-graph/" + encodeURIComponent(nodeId)), { method: "DELETE" })
      .then((r) => {
        if (r.status === 401) {
          showApiMessage("Invalid or incorrect API key. Use ?api=YOUR_KEY in the URL.");
          return;
        }
        if (r.status !== 204 && r.status !== 200) return r.json().then((j) => Promise.reject(new Error(j.error || r.statusText)));
        closeModal();
        fetchGraph();
        if (document.getElementById("panel-nodes").classList.contains("active")) renderNodes();
      })
      .catch((err) => alert("Delete failed: " + (err.message || err)));
  });
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal-cancel").addEventListener("click", closeModal);
  document.getElementById("modal-backdrop").addEventListener("click", closeModal);

  // --- Panel switching ---
  const SUBTITLES = {
    "panel-world-graph": "Double-click empty space to add a room; drag rooms to move (exits stay connected); drag empty space to pan.",
    "panel-history": "History ledger entries. Edit, add, or delete (with confirmation).",
    "panel-vocabulary": "Vocabulary terms. Edit, add, or delete (with confirmation).",
    "panel-nodes": "All world_graph nodes. Edit, add, or delete (with confirmation).",
  };
  function switchPanel(panelId) {
    if (!panelId) return;
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    const panel = document.getElementById(panelId);
    const btn = document.querySelector('.nav-btn[data-panel="' + panelId + '"]');
    if (panel) panel.classList.add("active");
    if (btn) btn.classList.add("active");
    const sub = document.getElementById("subtitle");
    if (sub && SUBTITLES[panelId]) sub.textContent = SUBTITLES[panelId];
    if (panelId === "panel-world-graph") fetchGraph();
    if (panelId === "panel-history") fetchHistory();
    if (panelId === "panel-vocabulary") fetchVocabulary();
    if (panelId === "panel-nodes") fetchGraph(); /* renderNodes() called from fetchGraph when data loads if this panel is active */
  }
  var nav = document.querySelector(".bottom-nav");
  if (nav) {
    nav.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest && e.target.closest(".nav-btn");
      if (btn && btn.getAttribute("data-panel")) switchPanel(btn.getAttribute("data-panel"));
    });
  }

  setupPanAndDrag();
  fetchGraph();

  // --- History Ledger ---
  function fetchHistory() {
    fetch(apiUrl("/api/history-ledger"))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then((rows) => {
        const tbody = document.getElementById("history-tbody");
        tbody.innerHTML = "";
        rows.forEach((row) => {
          const tr = document.createElement("tr");
          tr.innerHTML =
            "<td>" +
            row.entry_id +
            "</td><td class=\"cell-truncate\">" +
            escapeHtml(String(row.timestamp || "")) +
            "</td><td class=\"cell-truncate\">" +
            escapeHtml(String(row.action_description || "")) +
            "</td><td>" +
            escapeHtml(String(row.node_id || "")) +
            "</td><td class=\"cell-truncate\">" +
            escapeHtml(String((row.prose_impact || "").slice(0, 50))) +
            "</td><td>" +
            escapeHtml(String(row.system_event || "")) +
            "</td><td class=\"btn-cell\"><div class=\"btn-row\"><button type=\"button\" class=\"btn btn-sm btn-edit\" data-entry-id=\"" +
            row.entry_id +
            "\">Edit</button></div></td>";
          tr.querySelector(".btn-edit").addEventListener("click", () => openHistoryModal(row.entry_id));
          tbody.appendChild(tr);
        });
      })
      .catch((e) => console.error(e));
  }
  function openHistoryModal(entryId) {
    const isNew = entryId == null;
    const title = document.getElementById("modal-history-title");
    const form = document.getElementById("form-history");
    document.getElementById("history-entry_id").value = isNew ? "" : entryId;
    document.getElementById("history-delete").style.display = isNew ? "none" : "";
    title.textContent = isNew ? "New history entry" : "Edit history entry";
    if (isNew) {
      document.getElementById("history-timestamp").value = new Date().toISOString();
      document.getElementById("history-action_description").value = "";
      document.getElementById("history-node_id").value = "";
      document.getElementById("history-prose_impact").value = "";
      document.getElementById("history-adjectives_old").value = "";
      document.getElementById("history-adjectives_new").value = "";
      document.getElementById("history-system_event").value = "";
    } else {
      fetch(apiUrl("/api/history-ledger/" + entryId))
        .then((r) => r.json())
        .then((row) => {
          document.getElementById("history-timestamp").value = row.timestamp || "";
          document.getElementById("history-action_description").value = row.action_description ?? "";
          document.getElementById("history-node_id").value = row.node_id ?? "";
          document.getElementById("history-prose_impact").value = row.prose_impact ?? "";
          document.getElementById("history-adjectives_old").value = row.adjectives_old ?? "";
          document.getElementById("history-adjectives_new").value = row.adjectives_new ?? "";
          document.getElementById("history-system_event").value = row.system_event ?? "";
        });
    }
    document.getElementById("modal-history").classList.remove("hidden");
    document.getElementById("modal-history-backdrop").classList.remove("hidden");
  }
  document.getElementById("form-history").addEventListener("submit", (e) => {
    e.preventDefault();
    const entryId = document.getElementById("history-entry_id").value;
    const payload = {
      timestamp: document.getElementById("history-timestamp").value.trim(),
      action_description: document.getElementById("history-action_description").value.trim() || null,
      node_id: document.getElementById("history-node_id").value.trim() || null,
      prose_impact: document.getElementById("history-prose_impact").value.trim() || null,
      adjectives_old: document.getElementById("history-adjectives_old").value.trim() || null,
      adjectives_new: document.getElementById("history-adjectives_new").value.trim() || null,
      system_event: document.getElementById("history-system_event").value.trim() || null,
    };
    const req = entryId
      ? fetch(apiUrl("/api/history-ledger/" + entryId), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      : fetch(apiUrl("/api/history-ledger"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    req
      .then((r) => (r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error || r.statusText)))))
      .then(() => {
        document.getElementById("modal-history").classList.add("hidden");
        document.getElementById("modal-history-backdrop").classList.add("hidden");
        fetchHistory();
      })
      .catch((err) => alert("Save failed: " + (err.message || err)));
  });
  document.getElementById("history-delete").addEventListener("click", () => {
    const entryId = document.getElementById("history-entry_id").value;
    if (!entryId) return;
    if (!confirm("Delete this history entry (entry_id: " + entryId + ")? This cannot be undone.")) return;
    fetch(apiUrl("/api/history-ledger/" + entryId), { method: "DELETE" })
      .then((r) => {
        if (r.status !== 204 && r.status !== 200) return r.json().then((j) => Promise.reject(new Error(j.error || r.statusText)));
        document.getElementById("modal-history").classList.add("hidden");
        document.getElementById("modal-history-backdrop").classList.add("hidden");
        fetchHistory();
      })
      .catch((err) => alert("Delete failed: " + (err.message || err)));
  });
  document.getElementById("history-add").addEventListener("click", () => openHistoryModal(null));
  document.querySelectorAll(".modal-history-close, .modal-history-cancel").forEach((el) => el.addEventListener("click", () => {
    document.getElementById("modal-history").classList.add("hidden");
    document.getElementById("modal-history-backdrop").classList.add("hidden");
  }));
  document.getElementById("modal-history-backdrop").addEventListener("click", () => {
    document.getElementById("modal-history").classList.add("hidden");
    document.getElementById("modal-history-backdrop").classList.add("hidden");
  });

  // --- Vocabulary ---
  function fetchVocabulary() {
    fetch(apiUrl("/api/vocabulary"))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then((rows) => {
        const tbody = document.getElementById("vocab-tbody");
        tbody.innerHTML = "";
        rows.forEach((row) => {
          const tr = document.createElement("tr");
          tr.innerHTML =
            "<td>" +
            escapeHtml(row.adjective) +
            "</td><td class=\"cell-truncate\">" +
            escapeHtml(String(row.rule_description || "").slice(0, 60)) +
            "</td><td>" +
            (row.is_starter ? "1" : "0") +
            "</td><td class=\"btn-cell\"><div class=\"btn-row\"><button type=\"button\" class=\"btn btn-sm btn-edit\" data-adj=\"" +
            escapeAttr(row.adjective) +
            "\">Edit</button></div></td>";
          tr.querySelector(".btn-edit").addEventListener("click", () => openVocabModal(row.adjective));
          tbody.appendChild(tr);
        });
      })
      .catch((e) => console.error(e));
  }
  function openVocabModal(adjective) {
    const isNew = adjective == null || adjective === "";
    document.getElementById("vocab-adjective-old").value = isNew ? "" : adjective;
    document.getElementById("vocab-delete").style.display = isNew ? "none" : "";
    document.getElementById("modal-vocab-title").textContent = isNew ? "New vocabulary term" : "Edit vocabulary";
    document.getElementById("vocab-adjective").readOnly = !isNew;
    if (isNew) {
      document.getElementById("vocab-adjective").value = "";
      document.getElementById("vocab-rule_description").value = "";
      document.getElementById("vocab-is_starter").checked = false;
    } else {
      fetch(apiUrl("/api/vocabulary/" + encodeURIComponent(adjective)))
        .then((r) => r.json())
        .then((row) => {
          document.getElementById("vocab-adjective").value = row.adjective;
          document.getElementById("vocab-rule_description").value = row.rule_description ?? "";
          document.getElementById("vocab-is_starter").checked = !!row.is_starter;
        });
    }
    document.getElementById("modal-vocab").classList.remove("hidden");
    document.getElementById("modal-vocab-backdrop").classList.remove("hidden");
  }
  document.getElementById("form-vocab").addEventListener("submit", (e) => {
    e.preventDefault();
    const oldAdj = document.getElementById("vocab-adjective-old").value;
    const payload = {
      adjective: document.getElementById("vocab-adjective").value.trim().toLowerCase(),
      rule_description: document.getElementById("vocab-rule_description").value.trim(),
      is_starter: document.getElementById("vocab-is_starter").checked ? 1 : 0,
    };
    const req = oldAdj
      ? fetch(apiUrl("/api/vocabulary/" + encodeURIComponent(oldAdj)), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      : fetch(apiUrl("/api/vocabulary"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    req
      .then((r) => (r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error || r.statusText)))))
      .then(() => {
        document.getElementById("modal-vocab").classList.add("hidden");
        document.getElementById("modal-vocab-backdrop").classList.add("hidden");
        fetchVocabulary();
      })
      .catch((err) => alert("Save failed: " + (err.message || err)));
  });
  document.getElementById("vocab-delete").addEventListener("click", () => {
    const adjective = document.getElementById("vocab-adjective").value;
    if (!adjective) return;
    if (!confirm('Delete vocabulary term "' + adjective + '"? This cannot be undone.')) return;
    fetch(apiUrl("/api/vocabulary/" + encodeURIComponent(adjective)), { method: "DELETE" })
      .then((r) => {
        if (r.status !== 204 && r.status !== 200) return r.json().then((j) => Promise.reject(new Error(j.error || r.statusText)));
        document.getElementById("modal-vocab").classList.add("hidden");
        document.getElementById("modal-vocab-backdrop").classList.add("hidden");
        fetchVocabulary();
      })
      .catch((err) => alert("Delete failed: " + (err.message || err)));
  });
  document.getElementById("vocab-add").addEventListener("click", () => openVocabModal(null));
  document.querySelectorAll(".modal-vocab-close, .modal-vocab-cancel").forEach((el) => el.addEventListener("click", () => {
    document.getElementById("modal-vocab").classList.add("hidden");
    document.getElementById("modal-vocab-backdrop").classList.add("hidden");
  }));
  document.getElementById("modal-vocab-backdrop").addEventListener("click", () => {
    document.getElementById("modal-vocab").classList.add("hidden");
    document.getElementById("modal-vocab-backdrop").classList.add("hidden");
  });

  // --- Nodes list ---
  function renderNodes() {
    const tbody = document.getElementById("nodes-tbody");
    tbody.innerHTML = "";
    allNodes.forEach((row) => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" +
        escapeHtml(row.node_id) +
        "</td><td>" +
        escapeHtml(row.node_type || "") +
        "</td><td class=\"cell-truncate\">" +
        escapeHtml(String(row.name || "")) +
        "</td><td>" +
        escapeHtml(String(row.location_id || "")) +
        "</td><td>" +
        (row.is_active ? "1" : "0") +
        "</td><td class=\"btn-cell\"><div class=\"btn-row\"><button type=\"button\" class=\"btn btn-sm btn-edit\">Edit</button></div></td>";
      tr.querySelector(".btn-edit").addEventListener("click", () => openModal(row.node_id));
      tbody.appendChild(tr);
    });
  }
  document.getElementById("nodes-add").addEventListener("click", () => {
    openNodeModalNew();
  });
  function openNodeModalNew() {
    document.getElementById("edit-node_id").value = "";
    document.getElementById("edit-node_id_ro").value = "";
    document.getElementById("edit-node_id_ro").readOnly = false;
    document.getElementById("edit-node_type").value = "location";
    document.getElementById("edit-name").value = "";
    document.getElementById("edit-base_description").value = "";
    document.getElementById("edit-adjectives").value = "[]";
    document.getElementById("edit-location_id").value = "";
    document.getElementById("edit-is_active").checked = true;
    document.getElementById("edit-meta").value = "";
    document.getElementById("edit-grid_x").value = "";
    document.getElementById("edit-grid_y").value = "";
    document.getElementById("edit-exits").value = "[]";
    document.getElementById("modal-title").textContent = "New node";
    document.getElementById("modal-delete").style.display = "none";
    document.getElementById("modal").classList.remove("hidden");
    document.getElementById("modal-backdrop").classList.remove("hidden");
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }
  function escapeAttr(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Node modal: when opening for edit we set readOnly and show delete; when opening for new we already have openNodeModalNew
  function openModal(nodeId) {
    const node = allNodes.find((n) => n.node_id === nodeId);
    if (!node) return;
    document.getElementById("edit-node_id").value = node.node_id;
    document.getElementById("edit-node_id_ro").value = node.node_id;
    document.getElementById("edit-node_id_ro").readOnly = true;
    document.getElementById("edit-node_type").value = node.node_type || "location";
    document.getElementById("edit-name").value = node.name || "";
    document.getElementById("edit-base_description").value = node.base_description || "";
    document.getElementById("edit-adjectives").value =
      typeof node.adjectives === "string" ? node.adjectives : JSON.stringify(node.adjectives || [], null, 2);
    document.getElementById("edit-location_id").value = node.location_id ?? "";
    document.getElementById("edit-is_active").checked = !!node.is_active;
    document.getElementById("edit-meta").value = node.meta ?? "";
    document.getElementById("edit-grid_x").value = node.grid_x ?? "";
    document.getElementById("edit-grid_y").value = node.grid_y ?? "";
    document.getElementById("edit-exits").value =
      typeof node.exits === "string" ? node.exits : JSON.stringify(node.exits || [], null, 2);
    document.getElementById("modal-title").textContent = "Edit: " + (node.name || node.node_id);
    document.getElementById("modal-delete").style.display = "";
    document.getElementById("modal").classList.remove("hidden");
    document.getElementById("modal-backdrop").classList.remove("hidden");
  }

  document.getElementById("modal-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const nodeId = document.getElementById("edit-node_id").value;
    const nodeIdRo = document.getElementById("edit-node_id_ro").value.trim();
    const isNew = !nodeId;
    const payload = {
      node_type: document.getElementById("edit-node_type").value,
      name: document.getElementById("edit-name").value.trim(),
      base_description: document.getElementById("edit-base_description").value,
      adjectives: document.getElementById("edit-adjectives").value.trim() || "[]",
      location_id: document.getElementById("edit-location_id").value.trim() || null,
      is_active: document.getElementById("edit-is_active").checked ? 1 : 0,
      meta: document.getElementById("edit-meta").value.trim() || null,
      grid_x: (function () {
        const v = document.getElementById("edit-grid_x").value;
        if (v === "") return null;
        const n = parseInt(v, 10);
        return isNaN(n) ? null : n;
      })(),
      grid_y: (function () {
        const v = document.getElementById("edit-grid_y").value;
        if (v === "") return null;
        const n = parseInt(v, 10);
        return isNaN(n) ? null : n;
      })(),
      exits: document.getElementById("edit-exits").value.trim() || "[]",
    };
    if (isNew) {
      const newId = nodeIdRo || "node_" + Date.now();
      payload.node_id = newId;
      fetch(apiUrl("/api/world-graph"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, node_id: newId }),
      })
        .then((r) => {
          if (r.status === 401) {
            showApiMessage("Invalid or incorrect API key. Use ?api=YOUR_KEY in the URL.");
            return;
          }
          if (!r.ok) return r.json().then((j) => Promise.reject(new Error(j.error || r.statusText)));
          return r.json();
        })
        .then(() => {
          closeModal();
          fetchGraph();
          if (document.getElementById("panel-nodes").classList.contains("active")) renderNodes();
        })
        .catch((err) => alert("Save failed: " + (err.message || err)));
    } else {
      fetch(apiUrl("/api/world-graph/" + encodeURIComponent(nodeId)), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then((r) => {
          if (r.status === 401) {
            showApiMessage("Invalid or incorrect API key. Use ?api=YOUR_KEY in the URL.");
            return;
          }
          if (!r.ok) return r.json().then((j) => Promise.reject(new Error(j.error || r.statusText)));
          return r.json();
        })
        .then(() => {
          closeModal();
          fetchGraph();
          if (document.getElementById("panel-nodes").classList.contains("active")) renderNodes();
        })
        .catch((err) => alert("Save failed: " + (err.message || err)));
    }
  });
})();
