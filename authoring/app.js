(function () {
  "use strict";

  /** 3D world: 1 unit = 1 block. Location = 5x5x5, tunnel = 1x1x3. */
  const LOCATION_SIZE = 5;
  const TUNNEL_LENGTH = 3;
  const TUNNEL_CROSS = 1;
  const BLOCKS_PER_EXIT = 8; /* center-to-center: 2.5 + 3 + 2.5 */

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

  /* 3D scene */
  let scene3D = null;
  let camera3D = null;
  let renderer3D = null;
  let canvas3D = null;
  let locationMeshes = []; /* { mesh, nodeId } for raycast */
  let tunnelMeshes = [];
  let labelMeshes = [];
  const focusPoint = { x: 0, y: 0, z: 0 };
  let cameraDistance = 80;
  let cameraYaw = 0.4;
  let cameraPitch = 0.2;
  const CAMERA_DIST_MIN = 20;
  const CAMERA_DIST_MAX = 400;
  let compassRose = null; /* 3D compass group; position updated each frame */
  var compassLowerLeftNDC = new THREE.Vector3(-0.76, -0.38, 0.22); /* lower-left, right 3% and down 3% */
  let sceneDirectionalLight = null; /* light follows camera: viewer is the light source */
  let dragState = null; /* { type: 'left'|'right', startX, startY, startYaw, startPitch, startFocus } */
  const keysPressed = Object.create(null);
  const PAN_SPEED = 1.5;
  let animationId = null;

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
        computeLayoutFromExits();
        render();
        var nodesPanel = document.getElementById("panel-nodes");
        if (nodesPanel && nodesPanel.classList.contains("active")) renderNodes();
      })
      .catch((e) => {
        if (e.message !== "Unauthorized") console.error(e);
      });
  }

  const DIRECTIONS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest", "up", "down"];

  function parseExits(str) {
    if (!str || !str.trim()) return [];
    try {
      const arr = JSON.parse(str);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function normalizeExit(e) {
    const label = (e.label || e.name || e.target || "(exit)").trim() || "(exit)";
    const target = String(e.target || e.target_node_id || e.destination || "").trim();
    const dir = (e.direction || "").toLowerCase();
    const direction = DIRECTIONS.includes(dir) ? dir : DIRECTIONS[0];
    return { label, target, direction };
  }

  function getOtherLocationIds(currentNodeId) {
    return locations.filter(function (l) { return l.node_id !== currentNodeId; }).map(function (l) { return l.node_id; });
  }

  function renderExitsList(exitsData, currentNodeId) {
    const listEl = document.getElementById("exits-list");
    if (!listEl) return;
    const exits = Array.isArray(exitsData) ? exitsData : parseExits(typeof exitsData === "string" ? exitsData : "[]");
    const usedDirections = new Set(exits.map(function (e) { return normalizeExit(e).direction; }));
    const otherIds = getOtherLocationIds(currentNodeId || "");

    listEl.innerHTML = "";
    exits.forEach(function (e, index) {
      const ex = normalizeExit(e);
      const row = document.createElement("div");
      row.className = "exit-row";
      row.dataset.index = String(index);
      const labelInput = document.createElement("input");
      labelInput.type = "text";
      labelInput.className = "exit-label";
      labelInput.placeholder = "e.g. battered door";
      labelInput.value = ex.label;
      const targetSelect = document.createElement("select");
      targetSelect.className = "exit-target";
      const emptyOpt = document.createElement("option");
      emptyOpt.value = "";
      emptyOpt.textContent = "— select —";
      targetSelect.appendChild(emptyOpt);
      otherIds.forEach(function (id) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = id;
        if (id === ex.target) opt.selected = true;
        targetSelect.appendChild(opt);
      });
      const usedByOtherRows = new Set(
        exits.filter(function (_, j) { return j !== index; }).map(function (e) { return normalizeExit(e).direction; })
      );
      const dirSelect = document.createElement("select");
      dirSelect.className = "exit-direction";
      DIRECTIONS.forEach(function (d) {
        const opt = document.createElement("option");
        opt.value = d;
        opt.textContent = d;
        if (d === ex.direction) opt.selected = true;
        if (usedByOtherRows.has(d)) opt.disabled = true;
        dirSelect.appendChild(opt);
      });
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn-delete-exit";
      delBtn.textContent = "Delete";
      delBtn.setAttribute("aria-label", "Delete this exit");
      delBtn.addEventListener("click", function () {
        if (!confirm("Remove this exit? The reverse exit in the target room will also be removed.")) return;
        row.remove();
      });
      row.appendChild(labelInput);
      row.appendChild(targetSelect);
      row.appendChild(dirSelect);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    });
  }

  function parseAdjectivesFromValue(val) {
    if (val == null || val === "") return [];
    if (Array.isArray(val)) return val.map(function (x) { return String(x).trim(); }).filter(Boolean);
    if (typeof val !== "string") return [];
    try {
      const parsed = JSON.parse(val.trim() || "[]");
      return Array.isArray(parsed) ? parsed.map(function (x) { return String(x).trim(); }).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  function renderAdjectivesList(adjectivesArray, vocabularyRows) {
    const listEl = document.getElementById("adjectives-list");
    const selectEl = document.getElementById("adjectives-vocab-select");
    if (!listEl || !selectEl) return;
    const adjectives = Array.isArray(adjectivesArray) ? adjectivesArray : parseAdjectivesFromValue(adjectivesArray);
    const used = new Set(adjectives.map(function (a) { return a.toLowerCase(); }));

    listEl.innerHTML = "";
    adjectives.forEach(function (adj) {
      const row = document.createElement("div");
      row.className = "adjective-row";
      const span = document.createElement("span");
      span.className = "adjective-term";
      span.textContent = adj;
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn-delete-adjective";
      delBtn.textContent = "Delete";
      delBtn.setAttribute("aria-label", "Remove this adjective");
      delBtn.addEventListener("click", function () {
        row.remove();
        syncAdjectivesToHiddenInput();
        refreshAdjectivesVocabSelect();
      });
      row.appendChild(span);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    });

    selectEl.innerHTML = "";
    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "— choose term —";
    selectEl.appendChild(emptyOpt);
    (vocabularyRows || []).forEach(function (v) {
      const adj = (v.adjective || "").trim();
      if (!adj) return;
      const opt = document.createElement("option");
      opt.value = adj;
      opt.textContent = adj;
      if (used.has(adj.toLowerCase())) opt.disabled = true;
      selectEl.appendChild(opt);
    });
    syncAdjectivesToHiddenInput();
  }

  function refreshAdjectivesVocabSelect(usedSet) {
    const selectEl = document.getElementById("adjectives-vocab-select");
    if (!selectEl) return;
    const current = usedSet || new Set(
      Array.from(document.querySelectorAll(".adjective-row .adjective-term")).map(function (el) { return el.textContent.toLowerCase(); })
    );
    Array.from(selectEl.options).forEach(function (opt) {
      if (opt.value === "") return;
      opt.disabled = current.has(opt.value.toLowerCase());
    });
  }

  function syncAdjectivesToHiddenInput() {
    const hidden = document.getElementById("edit-adjectives");
    if (!hidden) return;
    hidden.value = JSON.stringify(collectAdjectivesFromList());
  }

  function collectAdjectivesFromList() {
    const listEl = document.getElementById("adjectives-list");
    if (!listEl) return [];
    return Array.from(listEl.querySelectorAll(".adjective-row .adjective-term")).map(function (el) { return el.textContent.trim(); }).filter(Boolean);
  }

  function addAdjectiveRow() {
    const selectEl = document.getElementById("adjectives-vocab-select");
    const listEl = document.getElementById("adjectives-list");
    if (!selectEl || !listEl) return;
    const adj = (selectEl.value || "").trim();
    if (!adj) return;
    const used = new Set(
      Array.from(listEl.querySelectorAll(".adjective-row .adjective-term")).map(function (el) { return el.textContent.toLowerCase(); })
    );
    if (used.has(adj.toLowerCase())) return;
    const row = document.createElement("div");
    row.className = "adjective-row";
    const span = document.createElement("span");
    span.className = "adjective-term";
    span.textContent = adj;
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn-delete-adjective";
    delBtn.textContent = "Delete";
    delBtn.setAttribute("aria-label", "Remove this adjective");
    delBtn.addEventListener("click", function () {
      row.remove();
      syncAdjectivesToHiddenInput();
      refreshAdjectivesVocabSelect();
    });
    row.appendChild(span);
    row.appendChild(delBtn);
    listEl.appendChild(row);
    syncAdjectivesToHiddenInput();
    refreshAdjectivesVocabSelect();
    selectEl.value = "";
  }

  function collectExitsFromList() {
    const listEl = document.getElementById("exits-list");
    if (!listEl) return [];
    const rows = listEl.querySelectorAll(".exit-row");
    const byDir = {};
    rows.forEach(function (row) {
      const labelInp = row.querySelector(".exit-label");
      const targetSel = row.querySelector(".exit-target");
      const dirSel = row.querySelector(".exit-direction");
      if (!dirSel || !targetSel) return;
      const direction = dirSel.value;
      const target = (targetSel.value || "").trim();
      if (!target) return;
      if (byDir[direction]) return;
      byDir[direction] = {
        label: (labelInp && labelInp.value) ? labelInp.value.trim() : target,
        target: target,
        direction: direction,
      };
    });
    return DIRECTIONS.map(function (d) { return byDir[d]; }).filter(Boolean);
  }

  function addExitRow(currentNodeId) {
    const listEl = document.getElementById("exits-list");
    if (!listEl) return;
    const existing = collectExitsFromList();
    const usedDirs = new Set(existing.map(function (e) { return e.direction; }));
    const firstFree = DIRECTIONS.find(function (d) { return !usedDirs.has(d); });
    if (!firstFree) {
      alert("Only one exit per direction. Remove an exit first to add another.");
      return;
    }
    const otherIds = getOtherLocationIds(currentNodeId || "");
    const row = document.createElement("div");
    row.className = "exit-row";
    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.className = "exit-label";
    labelInput.placeholder = "e.g. battered door";
    const targetSelect = document.createElement("select");
    targetSelect.className = "exit-target";
    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "— select —";
    targetSelect.appendChild(emptyOpt);
    otherIds.forEach(function (id) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = id;
      targetSelect.appendChild(opt);
    });
    const dirSelect = document.createElement("select");
    dirSelect.className = "exit-direction";
    DIRECTIONS.forEach(function (d) {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d;
      if (d === firstFree) opt.selected = true;
      if (usedDirs.has(d)) opt.disabled = true;
      dirSelect.appendChild(opt);
    });
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn-delete-exit";
    delBtn.textContent = "Delete";
    delBtn.setAttribute("aria-label", "Delete this exit");
    delBtn.addEventListener("click", function () {
      if (!confirm("Remove this exit? The reverse exit in the target room will also be removed.")) return;
      row.remove();
    });
    row.appendChild(labelInput);
    row.appendChild(targetSelect);
    row.appendChild(dirSelect);
    row.appendChild(delBtn);
    listEl.appendChild(row);
  }

  /** Block offset per direction (8 blocks center-to-center). +X=east, +Y=up, +Z=south (north = -Z so N appears correct in view). */
  const DIR_OFFSET_BLOCKS = {
    north: { x: 0, y: 0, z: -8 },
    south: { x: 0, y: 0, z: 8 },
    east: { x: 8, y: 0, z: 0 },
    west: { x: -8, y: 0, z: 0 },
    up: { x: 0, y: 8, z: 0 },
    down: { x: 0, y: -8, z: 0 },
    northeast: { x: 5.656854249492381, y: 0, z: -5.656854249492381 },
    southeast: { x: 5.656854249492381, y: 0, z: 5.656854249492381 },
    southwest: { x: -5.656854249492381, y: 0, z: 5.656854249492381 },
    northwest: { x: -5.656854249492381, y: 0, z: -5.656854249492381 },
  };

  /** Assign grid_x, grid_y, grid_z (blocks) from exit graph. Root at (0,0,0); neighbors at +8 blocks in exit direction. */
  function computeLayoutFromExits() {
    const locById = new Map(locations.map((l) => [l.node_id, l]));
    const pos = new Map();
    const queue = [];
    const first = locations[0];
    if (!first) return;
    pos.set(first.node_id, { x: 0, y: 0, z: 0 });
    queue.push(first.node_id);
    while (queue.length) {
      const nodeId = queue.shift();
      const loc = locById.get(nodeId);
      if (!loc) continue;
      const p = pos.get(nodeId);
      const exits = parseExits(loc.exits);
      for (const e of exits) {
        const targetId = (e.target || "").trim();
        if (!targetId || !locById.has(targetId)) continue;
        if (pos.has(targetId)) continue;
        const dir = (e.direction || "").toLowerCase();
        const off = DIR_OFFSET_BLOCKS[dir];
        if (!off) continue;
        pos.set(targetId, { x: p.x + off.x, y: p.y + off.y, z: p.z + off.z });
        queue.push(targetId);
      }
    }
    var minX = 0, maxX = 0, minY = 0, maxY = 0, minZ = 0, maxZ = 0;
    var hasPlaced = false;
    pos.forEach(function (p) {
      if (!hasPlaced) { minX = maxX = p.x; minY = maxY = p.y; minZ = maxZ = p.z; hasPlaced = true; }
      else {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
      }
    });
    var edgeOffset = BLOCKS_PER_EXIT;
    var fallback = 0;
    for (var i = 0; i < locations.length; i++) {
      var loc = locations[i];
      var p = pos.get(loc.node_id);
      if (p != null) {
        loc.grid_x = p.x;
        loc.grid_y = p.y;
        loc.grid_z = p.z;
      } else {
        loc.grid_x = hasPlaced ? maxX + edgeOffset + fallback * edgeOffset : fallback * edgeOffset;
        loc.grid_y = 0;
        loc.grid_z = 0;
        fallback++;
      }
    }
  }

  function initScene3D() {
    if (typeof THREE === "undefined") return;
    canvas3D = document.getElementById("world-graph-canvas");
    if (!canvas3D) return;
    const wrap = document.getElementById("grid-wrap");
    if (!wrap) return;
    scene3D = new THREE.Scene();
    scene3D.background = new THREE.Color(0x1a1a1a);
    const aspect = Math.max(1, wrap.clientWidth / wrap.clientHeight);
    camera3D = new THREE.PerspectiveCamera(50, aspect, 1, 2000);
    renderer3D = new THREE.WebGLRenderer({ canvas: canvas3D, antialias: true });
    renderer3D.setPixelRatio(window.devicePixelRatio || 1);
    renderer3D.setSize(wrap.clientWidth, wrap.clientHeight);
    /* directional light follows camera so viewer is the light source; updated each frame in animate() */
    sceneDirectionalLight = new THREE.DirectionalLight(0xffffff, 0.9);
    scene3D.add(sceneDirectionalLight);
    scene3D.add(sceneDirectionalLight.target);
    scene3D.add(new THREE.AmbientLight(0x404060, 0.5));
    compassRose = createCompassRose();
    if (compassRose) scene3D.add(compassRose);
    updateCameraPosition();
    setup3DControls();
  }

  function makeCompassLabelTexture(text) {
    var w = 320;
    var h = 160;
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(230, 230, 230, 0.95)";
    ctx.font = "bold 70px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, w / 2, h / 2);
    var tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }

  function createCompassRose() {
    if (typeof THREE === "undefined") return null;
    var group = new THREE.Group();
    group.scale.setScalar(0.0275); /* 50% of previous; lower-left corner */
    var ringRadius = 12;
    var ringTube = 0.2;
    var ringGeo = new THREE.TorusGeometry(ringRadius, ringTube, 8, 32);
    ringGeo.rotateX(-Math.PI / 2);
    var ringMat = new THREE.MeshBasicMaterial({ color: 0x606070 });
    var ring = new THREE.Mesh(ringGeo, ringMat);
    group.add(ring);
    var labelW = 2.5 * 2.5;
    var labelH = 1.2 * 2.5;
    var labelGeo = new THREE.PlaneGeometry(labelW, labelH);
    var cards = [
      { text: "N", x: 0, y: 0, z: -ringRadius, rotY: Math.PI },
      { text: "E", x: ringRadius, y: 0, z: 0, rotY: -Math.PI / 2 },
      { text: "S", x: 0, y: 0, z: ringRadius, rotY: 0 },
      { text: "W", x: -ringRadius, y: 0, z: 0, rotY: Math.PI / 2 },
    ];
    var labelMatOpts = {
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    };
    cards.forEach(function (c) {
      var tex = makeCompassLabelTexture(c.text);
      var mat = new THREE.MeshBasicMaterial(Object.assign({ map: tex }, labelMatOpts));
      var plane = new THREE.Mesh(labelGeo.clone(), mat);
      plane.position.set(c.x, c.y, c.z);
      plane.rotation.y = c.rotY;
      group.add(plane);
    });
    var vertLabels = [
      { text: "Up", x: 0, y: 14, z: 0, rotX: -Math.PI / 2 },
      { text: "Down", x: 0, y: -14, z: 0, rotX: Math.PI / 2 },
    ];
    vertLabels.forEach(function (c) {
      var tex = makeCompassLabelTexture(c.text);
      var mat = new THREE.MeshBasicMaterial(Object.assign({ map: tex }, labelMatOpts));
      var plane = new THREE.Mesh(labelGeo.clone(), mat);
      plane.position.set(c.x, c.y, c.z);
      plane.rotation.x = c.rotX;
      group.add(plane);
    });
    return group;
  }

  function updateCameraPosition() {
    if (!camera3D) return;
    const x = focusPoint.x + cameraDistance * Math.cos(cameraPitch) * Math.sin(cameraYaw);
    const y = focusPoint.y + cameraDistance * Math.sin(cameraPitch);
    const z = focusPoint.z + cameraDistance * Math.cos(cameraPitch) * Math.cos(cameraYaw);
    camera3D.position.set(x, y, z);
    camera3D.lookAt(focusPoint.x, focusPoint.y, focusPoint.z);
    camera3D.updateMatrixWorld(true);
  }

  function hexToCss(hex) {
    const n = parseInt(hex, 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return "rgb(" + r + "," + g + "," + b + ")";
  }

  function makeFaceLabelTexture(shortName) {
    var w = 256;
    var h = 64;
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#1a1a1a";
    ctx.font = "bold 24px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(shortName).slice(0, 12), w / 2, h / 2);
    var tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }

  var FACE_LABEL_OFFSET = 0.01;
  var LABEL_STRIP_H = 0.8;
  var LABEL_STRIP_W = 4;
  var HALF = LOCATION_SIZE / 2;
  var LOWEST_ROW_CENTER = -HALF + LABEL_STRIP_H / 2;

  function addFaceLabelsForLocation(scene, gx, gy, gz, nodeId, fullName, isPlayer) {
    var labelText = String(nodeId).slice(0, 12);
    var tex = makeFaceLabelTexture(labelText);
    var mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    var geo = new THREE.PlaneGeometry(LABEL_STRIP_W, LABEL_STRIP_H);
    var faces = [
      { pos: [HALF + FACE_LABEL_OFFSET, LOWEST_ROW_CENTER, 0], rot: [0, -Math.PI / 2, 0] },
      { pos: [-HALF - FACE_LABEL_OFFSET, LOWEST_ROW_CENTER, 0], rot: [0, Math.PI / 2, 0] },
      { pos: [0, HALF + FACE_LABEL_OFFSET, LOWEST_ROW_CENTER], rot: [-Math.PI / 2, 0, 0] },
      { pos: [0, -HALF - FACE_LABEL_OFFSET, LOWEST_ROW_CENTER], rot: [Math.PI / 2, 0, 0] },
      { pos: [0, LOWEST_ROW_CENTER, HALF + FACE_LABEL_OFFSET], rot: [0, 0, 0] },
      { pos: [0, LOWEST_ROW_CENTER, -HALF - FACE_LABEL_OFFSET], rot: [0, Math.PI, 0] },
    ];
    for (var i = 0; i < faces.length; i++) {
      var plane = new THREE.Mesh(geo.clone(), mat);
      plane.position.set(gx + faces[i].pos[0], gy + faces[i].pos[1], gz + faces[i].pos[2]);
      plane.rotation.set(faces[i].rot[0], faces[i].rot[1], faces[i].rot[2]);
      plane.userData = { nodeId: nodeId, fullName: fullName };
      scene.add(plane);
      labelMeshes.push(plane);
    }
  }

  function buildScene3D() {
    if (!scene3D || typeof THREE === "undefined") return;
    locationMeshes.forEach(function (o) {
      scene3D.remove(o.mesh);
      o.mesh.geometry.dispose();
      if (o.mesh.material) o.mesh.material.dispose();
    });
    tunnelMeshes.forEach(function (m) {
      scene3D.remove(m);
      m.geometry.dispose();
      if (m.material) m.material.dispose();
    });
    var disposedMats = new Set();
    labelMeshes.forEach(function (m) {
      scene3D.remove(m);
      m.geometry.dispose();
      if (m.material && !disposedMats.has(m.material)) {
        disposedMats.add(m.material);
        if (m.material.map) m.material.map.dispose();
        m.material.dispose();
      }
    });
    locationMeshes = [];
    tunnelMeshes = [];
    labelMeshes = [];

    const playerNode = allNodes.find(function (n) { return n.node_id === "player"; });
    const playerLocationId = (playerNode && playerNode.location_id) || null;
    const boxGeo = new THREE.BoxGeometry(LOCATION_SIZE, LOCATION_SIZE, LOCATION_SIZE);
    const tunnelGeo = new THREE.BoxGeometry(TUNNEL_CROSS, TUNNEL_CROSS, TUNNEL_LENGTH);
    const matDefault = new THREE.MeshPhongMaterial({
      color: 0xe8e4d8,
      emissive: 0x2a2a28,
    });
    const matCurrent = new THREE.MeshPhongMaterial({
      color: 0x66bb6a,
      emissive: 0x1a331a,
    });
    const matTunnel = new THREE.MeshPhongMaterial({
      color: 0x9a9a9a,
      emissive: 0x222222,
    });

    locations.forEach(function (loc) {
      const gx = Number(loc.grid_x) || 0;
      const gy = Number(loc.grid_y) || 0;
      const gz = Number(loc.grid_z) || 0;
      const isPlayerLoc = loc.node_id === playerLocationId;
      const mesh = new THREE.Mesh(
        boxGeo.clone(),
        isPlayerLoc ? matCurrent : matDefault
      );
      mesh.position.set(gx, gy, gz);
      mesh.userData = { nodeId: loc.node_id, fullName: loc.name || loc.node_id };
      scene3D.add(mesh);
      locationMeshes.push({ mesh: mesh, nodeId: loc.node_id });

      addFaceLabelsForLocation(scene3D, gx, gy, gz, loc.node_id, loc.name || loc.node_id, isPlayerLoc);

      const exits = parseExits(loc.exits);
      exits.forEach(function (e) {
        const dir = (e.direction || "").toLowerCase();
        const off = DIR_OFFSET_BLOCKS[dir];
        if (!off) return;
        const len = Math.sqrt(off.x * off.x + off.y * off.y + off.z * off.z);
        if (len < 0.1) return;
        const nx = off.x / len;
        const ny = off.y / len;
        const nz = off.z / len;
        const tunnel = new THREE.Mesh(tunnelGeo.clone(), matTunnel);
        tunnel.position.set(
          gx + (LOCATION_SIZE / 2 + TUNNEL_LENGTH / 2) * nx,
          gy + (LOCATION_SIZE / 2 + TUNNEL_LENGTH / 2) * ny,
          gz + (LOCATION_SIZE / 2 + TUNNEL_LENGTH / 2) * nz
        );
        tunnel.rotation.y = Math.atan2(nx, nz);
        tunnel.rotation.x = -Math.asin(ny);
        tunnel.userData = { exitLabel: e.label || "(exit)" };
        scene3D.add(tunnel);
        tunnelMeshes.push(tunnel);
      });
    });

    /* center focus on locations */
    if (locations.length > 0) {
      let sx = 0, sy = 0, sz = 0;
      locations.forEach(function (l) {
        sx += Number(l.grid_x) || 0;
        sy += Number(l.grid_y) || 0;
        sz += Number(l.grid_z) || 0;
      });
      focusPoint.x = sx / locations.length;
      focusPoint.y = sy / locations.length;
      focusPoint.z = sz / locations.length;
    }
    updateCameraPosition();
  }

  function applyWasdPan() {
    if (!camera3D || !focusPoint) return;
    var el = document.activeElement;
    var tag = el && el.tagName ? el.tagName.toUpperCase() : "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    var forward = new THREE.Vector3(
      focusPoint.x - camera3D.position.x,
      focusPoint.y - camera3D.position.y,
      focusPoint.z - camera3D.position.z
    );
    var len = forward.length();
    if (len < 1e-6) return;
    forward.divideScalar(len);
    var up = new THREE.Vector3(0, 1, 0);
    var right = new THREE.Vector3().crossVectors(forward, up).normalize();
    var move = 0;
    if (keysPressed["KeyW"]) { focusPoint.x += forward.x * PAN_SPEED; focusPoint.y += forward.y * PAN_SPEED; focusPoint.z += forward.z * PAN_SPEED; move = 1; }
    if (keysPressed["KeyS"]) { focusPoint.x -= forward.x * PAN_SPEED; focusPoint.y -= forward.y * PAN_SPEED; focusPoint.z -= forward.z * PAN_SPEED; move = 1; }
    if (keysPressed["KeyD"]) { focusPoint.x += right.x * PAN_SPEED; focusPoint.y += right.y * PAN_SPEED; focusPoint.z += right.z * PAN_SPEED; move = 1; }
    if (keysPressed["KeyA"]) { focusPoint.x -= right.x * PAN_SPEED; focusPoint.y -= right.y * PAN_SPEED; focusPoint.z -= right.z * PAN_SPEED; move = 1; }
    if (move) updateCameraPosition();
  }

  function animate() {
    if (!renderer3D || !scene3D || !camera3D) return;
    applyWasdPan();
    if (compassRose && camera3D) {
      compassLowerLeftNDC.set(-0.76, -0.38, 0.22);
      compassLowerLeftNDC.unproject(camera3D);
      compassRose.position.copy(compassLowerLeftNDC);
      compassRose.updateMatrixWorld(true);
      compassRose.traverse(function (o) {
        if (o.isMesh && o.material && o.material.map) o.lookAt(camera3D.position);
      });
    }
    if (sceneDirectionalLight && camera3D) {
      sceneDirectionalLight.position.copy(camera3D.position);
      sceneDirectionalLight.target.position.set(focusPoint.x, focusPoint.y, focusPoint.z);
      sceneDirectionalLight.target.updateMatrixWorld(true);
    }
    renderer3D.render(scene3D, camera3D);
    animationId = requestAnimationFrame(animate);
  }

  function setup3DControls() {
    const wrap = document.getElementById("grid-wrap");
    const canvas = document.getElementById("world-graph-canvas");
    if (!wrap || !canvas) return;

    function getSize() {
      return { w: wrap.clientWidth, h: wrap.clientHeight };
    }

    wrap.addEventListener("resize", function () {
      if (!camera3D || !renderer3D) return;
      const s = getSize();
      camera3D.aspect = s.w / s.h;
      camera3D.updateProjectionMatrix();
      renderer3D.setSize(s.w, s.h);
    });

    canvas.addEventListener("mousedown", function (e) {
      if (e.target !== canvas) return;
      if (e.button === 0) {
        dragState = { type: "left", startX: e.clientX, startY: e.clientY, startYaw: cameraYaw, startPitch: cameraPitch };
      } else if (e.button === 2) {
        dragState = { type: "right", startX: e.clientX, startY: e.clientY, startFocus: { x: focusPoint.x, y: focusPoint.y, z: focusPoint.z } };
      }
    });
    canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    window.addEventListener("mousemove", function (e) {
      if (!dragState) return;
      if (dragState.type === "left") {
        const dx = (e.clientX - dragState.startX) * 0.01;
        const dy = (e.clientY - dragState.startY) * 0.01;
        cameraYaw = dragState.startYaw + dx;
        cameraPitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, dragState.startPitch + dy));
        updateCameraPosition();
      } else {
        const dx = (e.clientX - dragState.startX) * 0.15;
        const dy = (e.clientY - dragState.startY) * 0.15;
        const sin = Math.sin(cameraYaw);
        const cos = Math.cos(cameraYaw);
        focusPoint.x = dragState.startFocus.x - dx * cos - dy * sin;
        focusPoint.z = dragState.startFocus.z + dx * sin - dy * cos;
        focusPoint.y = dragState.startFocus.y + (dragState.startY - e.clientY) * 0.15;
        updateCameraPosition();
      }
    });
    window.addEventListener("mouseup", function () { dragState = null; });

    canvas.addEventListener("wheel", function (e) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 8 : -8;
      cameraDistance = Math.max(CAMERA_DIST_MIN, Math.min(CAMERA_DIST_MAX, cameraDistance + delta));
      updateCameraPosition();
    }, { passive: false });

    window.addEventListener("keydown", function (e) {
      if (e.code !== "KeyW" && e.code !== "KeyA" && e.code !== "KeyS" && e.code !== "KeyD") return;
      var el = document.activeElement;
      var tag = el && el.tagName ? el.tagName.toUpperCase() : "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      keysPressed[e.code] = true;
      e.preventDefault();
    });
    window.addEventListener("keyup", function (e) {
      if (e.code !== "KeyW" && e.code !== "KeyA" && e.code !== "KeyS" && e.code !== "KeyD") return;
      var el = document.activeElement;
      var tag = el && el.tagName ? el.tagName.toUpperCase() : "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      keysPressed[e.code] = false;
      e.preventDefault();
    });

    var tooltipEl = document.getElementById("graph-tooltip");
    canvas.addEventListener("mousemove", function (e) {
      if (dragState || typeof THREE === "undefined" || !camera3D || !scene3D) {
        if (tooltipEl) tooltipEl.classList.add("hidden");
        return;
      }
      var rect = canvas.getBoundingClientRect();
      var mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      var my = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      var raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(mx, my), camera3D);
      var allPickable = locationMeshes.map(function (o) { return o.mesh; }).concat(labelMeshes).concat(tunnelMeshes);
      var hits = raycaster.intersectObjects(allPickable);
      if (hits.length > 0 && tooltipEl) {
        var ud = hits[0].object.userData;
        if (ud.fullName) {
          tooltipEl.textContent = ud.fullName;
          tooltipEl.classList.remove("hidden");
          tooltipEl.style.left = (e.clientX + 12) + "px";
          tooltipEl.style.top = (e.clientY + 12) + "px";
        } else if (ud.exitLabel) {
          tooltipEl.textContent = ud.exitLabel;
          tooltipEl.classList.remove("hidden");
          tooltipEl.style.left = (e.clientX + 12) + "px";
          tooltipEl.style.top = (e.clientY + 12) + "px";
        } else {
          tooltipEl.classList.add("hidden");
        }
      } else if (tooltipEl) {
        tooltipEl.classList.add("hidden");
      }
    });
    canvas.addEventListener("mouseleave", function () {
      if (tooltipEl) tooltipEl.classList.add("hidden");
    });

    canvas.addEventListener("dblclick", function (e) {
      if (e.button !== 0) return;
      if (typeof THREE === "undefined" || !camera3D || !scene3D) return;
      const rect = canvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      const raycaster = new THREE.Raycaster();
      const mouse = new THREE.Vector2(x, y);
      raycaster.setFromCamera(mouse, camera3D);
      const allPickable = locationMeshes.map(function (o) { return o.mesh; }).concat(labelMeshes);
      const hits = raycaster.intersectObjects(allPickable);
      if (hits.length > 0 && hits[0].object.userData && hits[0].object.userData.nodeId) {
        openModal(hits[0].object.userData.nodeId);
      }
    });

  }


  function render() {
    if (typeof THREE === "undefined") return;
    if (!scene3D) initScene3D();
    if (scene3D) {
      buildScene3D();
      if (!animationId) animate();
    }
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
    "panel-world-graph": "3D world: left-drag orbit, right-drag pan, wheel zoom, W/A/S/D pan. Double-click location to edit; use Add location to create (add exits to place it).",
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

  (function setupZoomControls() {
    const zoomOut = document.getElementById("zoom-out");
    const zoomIn = document.getElementById("zoom-in");
    const zoomInput = document.getElementById("zoom-percent");
    function updateZoomUI() {
      if (zoomInput) zoomInput.value = Math.round(cameraDistance);
    }
    if (zoomOut) zoomOut.addEventListener("click", function () {
      cameraDistance = Math.max(CAMERA_DIST_MIN, cameraDistance - 15);
      updateCameraPosition();
      updateZoomUI();
    });
    if (zoomIn) zoomIn.addEventListener("click", function () {
      cameraDistance = Math.min(CAMERA_DIST_MAX, cameraDistance + 15);
      updateCameraPosition();
      updateZoomUI();
    });
    if (zoomInput) {
      zoomInput.addEventListener("change", function () {
        const v = parseFloat(zoomInput.value);
        if (!isNaN(v)) {
          cameraDistance = Math.max(CAMERA_DIST_MIN, Math.min(CAMERA_DIST_MAX, v));
          updateCameraPosition();
          updateZoomUI();
        }
      });
      zoomInput.addEventListener("blur", updateZoomUI);
    }
    window.addEventListener("resize", function () {
      if (!document.getElementById("panel-world-graph").classList.contains("active")) return;
      if (renderer3D && camera3D && canvas3D) {
        var wrap = document.getElementById("grid-wrap");
        if (wrap) {
          camera3D.aspect = wrap.clientWidth / wrap.clientHeight;
          camera3D.updateProjectionMatrix();
          renderer3D.setSize(wrap.clientWidth, wrap.clientHeight);
        }
      }
    });
  })();

  var addLocationBtn = document.getElementById("world-graph-add-location");
  if (addLocationBtn) addLocationBtn.addEventListener("click", openNodeModalNew);

  (function () {
    const checkbox = document.getElementById("show-locations");
    const nodesPanel = document.getElementById("panel-nodes");
    if (checkbox && nodesPanel) {
      function applyShowLocationsInNodes() {
        if (checkbox.checked) nodesPanel.classList.remove("nodes-hide-locations");
        else nodesPanel.classList.add("nodes-hide-locations");
      }
      checkbox.addEventListener("change", applyShowLocationsInNodes);
      applyShowLocationsInNodes();
    }
  })();
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
      tr.className = row.node_type === "location" ? "node-row node-row-location" : "node-row";
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
    refreshLocationIdDatalist();
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
    document.getElementById("edit-grid_z").value = "";
    document.getElementById("edit-exits").value = "[]";
    document.getElementById("edit-node_type").value = "location";
    document.getElementById("exits-section").classList.remove("hidden");
    renderExitsList([], null);
    document.getElementById("modal-title").textContent = "New location";
    document.getElementById("modal-delete").style.display = "none";
    document.getElementById("modal-move-player-wrap").classList.add("hidden");
    fetchVocabularyForModal(function (vocab) {
      renderAdjectivesList([], vocab);
      document.getElementById("modal").classList.remove("hidden");
      document.getElementById("modal-backdrop").classList.remove("hidden");
    });
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

  function refreshLocationIdDatalist() {
    const list = document.getElementById("edit-location_id-list");
    if (!list) return;
    list.innerHTML = "";
    (allNodes || []).forEach(function (n) {
      const opt = document.createElement("option");
      opt.value = n.node_id || "";
      if (opt.value) list.appendChild(opt);
    });
  }

  function fetchVocabularyForModal(cb) {
    fetch(apiUrl("/api/vocabulary"))
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) { cb(rows || []); })
      .catch(function () { cb([]); });
  }

  // Node modal: when opening for edit we set readOnly and show delete; when opening for new we already have openNodeModalNew
  function openModal(nodeId) {
    const node = allNodes.find((n) => n.node_id === nodeId);
    if (!node) return;
    refreshLocationIdDatalist();
    document.getElementById("edit-node_id").value = node.node_id;
    document.getElementById("edit-node_id_ro").value = node.node_id;
    document.getElementById("edit-node_id_ro").readOnly = true;
    document.getElementById("edit-node_type").value = node.node_type || "location";
    document.getElementById("edit-name").value = node.name || "";
    document.getElementById("edit-base_description").value = node.base_description || "";
    document.getElementById("edit-adjectives").value =
      typeof node.adjectives === "string" ? node.adjectives : JSON.stringify(node.adjectives || []);
    document.getElementById("edit-location_id").value = node.location_id ?? "";
    document.getElementById("edit-is_active").checked = !!node.is_active;
    document.getElementById("edit-meta").value = node.meta ?? "";
    document.getElementById("edit-grid_x").value = node.grid_x ?? "";
    document.getElementById("edit-grid_y").value = node.grid_y ?? "";
    document.getElementById("edit-grid_z").value = node.grid_z ?? "";
    if (node.node_type === "location") {
      document.getElementById("exits-section").classList.remove("hidden");
      renderExitsList(node.exits, node.node_id);
    } else {
      document.getElementById("exits-section").classList.add("hidden");
      document.getElementById("edit-exits").value = "[]";
    }
    document.getElementById("modal-title").textContent = "Edit: " + (node.name || node.node_id);
    document.getElementById("modal-delete").style.display = "";
    if (node.node_type === "location") {
      document.getElementById("modal-move-player-wrap").classList.remove("hidden");
    } else {
      document.getElementById("modal-move-player-wrap").classList.add("hidden");
    }
    fetchVocabularyForModal(function (vocab) {
      renderAdjectivesList(node.adjectives, vocab);
      document.getElementById("modal").classList.remove("hidden");
      document.getElementById("modal-backdrop").classList.remove("hidden");
    });
  }

  document.getElementById("edit-node_type").addEventListener("change", function () {
    const isLocation = this.value === "location";
    const section = document.getElementById("exits-section");
    const moveWrap = document.getElementById("modal-move-player-wrap");
    if (isLocation) {
      section.classList.remove("hidden");
      renderExitsList([], document.getElementById("edit-node_id").value || null);
      if (document.getElementById("edit-node_id").value) moveWrap.classList.remove("hidden");
    } else {
      section.classList.add("hidden");
      document.getElementById("edit-exits").value = "[]";
      moveWrap.classList.add("hidden");
    }
  });

  document.getElementById("modal-move-player").addEventListener("click", function () {
    const locationId = document.getElementById("edit-node_id").value;
    if (!locationId) return;
    if (!confirm("Move the player to this location?")) return;
    const player = allNodes.find(function (n) { return n.node_id === "player"; });
    if (!player) return;
    const payload = {
      node_type: "player",
      name: player.name || "Player",
      base_description: player.base_description || "",
      adjectives: typeof player.adjectives === "string" ? player.adjectives : JSON.stringify(player.adjectives || []),
      location_id: locationId,
      is_active: player.is_active != null ? player.is_active : 1,
      meta: player.meta != null ? player.meta : null,
      exits: "[]",
      grid_x: null,
      grid_y: null,
      grid_z: null,
    };
    fetch(apiUrl("/api/world-graph/player"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        if (r.status === 401) {
          showApiMessage("Invalid or incorrect API key. Use ?api=YOUR_KEY in the URL.");
          return;
        }
        if (!r.ok) return r.json().then(function (j) { return Promise.reject(new Error(j.error || r.statusText)); });
        return r.json();
      })
      .then(function () {
        fetchGraph();
        if (document.getElementById("panel-nodes").classList.contains("active")) renderNodes();
      })
      .catch(function (err) { alert("Move player failed: " + (err.message || err)); });
  });

  document.getElementById("exits-add").addEventListener("click", function () {
    addExitRow(document.getElementById("edit-node_id").value || null);
  });

  document.getElementById("adjectives-add").addEventListener("click", addAdjectiveRow);

  document.getElementById("modal-form").addEventListener("submit", (e) => {
    e.preventDefault();
    syncAdjectivesToHiddenInput();
    const nodeId = document.getElementById("edit-node_id").value;
    const nodeIdRo = document.getElementById("edit-node_id_ro").value.trim();
    const isNew = !nodeId;
    const nodeType = document.getElementById("edit-node_type").value;
    const exitsJson = nodeType === "location"
      ? JSON.stringify(collectExitsFromList())
      : "[]";
    document.getElementById("edit-exits").value = exitsJson;
    const payload = {
      node_type: nodeType,
      name: document.getElementById("edit-name").value.trim(),
      base_description: document.getElementById("edit-base_description").value,
      adjectives: document.getElementById("edit-adjectives").value.trim() || "[]",
      location_id: document.getElementById("edit-location_id").value.trim() || null,
      is_active: document.getElementById("edit-is_active").checked ? 1 : 0,
      meta: document.getElementById("edit-meta").value.trim() || null,
      grid_x: (function () {
        const v = document.getElementById("edit-grid_x").value;
        if (v === "") return null;
        const n = parseFloat(v);
        return isNaN(n) ? null : n;
      })(),
      grid_y: (function () {
        const v = document.getElementById("edit-grid_y").value;
        if (v === "") return null;
        const n = parseFloat(v);
        return isNaN(n) ? null : n;
      })(),
      grid_z: (function () {
        const v = document.getElementById("edit-grid_z").value;
        if (v === "") return null;
        const n = parseFloat(v);
        return isNaN(n) ? null : n;
      })(),
      exits: exitsJson,
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
