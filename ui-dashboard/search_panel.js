/**
 * search_panel.js — Multimodal Search overlay for Apple Embedding Atlas
 *
 * Features:
 *  1. Semantic search panel (right side) — Gemini embeddings, result cards
 *  2. Main scatter highlighting via Atlas Color-by search_match column
 *  3. Floating "✕ Clear" pill + "📂 Index Files" button
 *  4. Open / Show in Finder in dot tooltip, data table, result cards
 *  5. Delete from index (and optionally disk) with confirmation modal
 *  6. Index Files — 3-step modal: pick folders → explore files → streaming progress
 */

// ── Force Atlas defaults (density mode, point size) ──────────────────────────
// Atlas stores its entire state in the URL hash (#?state=...).
// Strip stale URL state so Atlas reads fresh defaults from the server.
(function forceAtlasDefaults() {
  if (window.location.hash && window.location.hash.includes("state=")) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
})();

// Force dark color scheme for Atlas regardless of OS light/dark preference.
// search_panel.js (a classic script) runs before the Atlas ES module (which is
// deferred), so this override is in place when Atlas first reads matchMedia.
(function forceDarkColorScheme() {
  const _orig = window.matchMedia.bind(window);
  window.matchMedia = function(query) {
    const mql = _orig(query);
    if (query === "(prefers-color-scheme: dark)" || query === "(prefers-color-scheme: light)") {
      const forcedMatch = (query === "(prefers-color-scheme: dark)");
      return new Proxy(mql, {
        get(target, prop) {
          if (prop === "matches") return forcedMatch;
          const val = target[prop];
          return typeof val === "function" ? val.bind(target) : val;
        }
      });
    }
    return mql;
  };
})();

(function () {
  "use strict";

  // ── State ──────────────────────────────────────────────────────────────────
  const state = {
    query:      "",
    typeFilter: "",
    results:    [],
    matchIds:   new Set(),
    loading:    false,
    error:      null,
    collapsed:  false,
    nameToItem: {},
    pathToItem: {},
    selectedRowId: null,

    // Precise multi-select (cmd+click on table rows / neighbor panel)
    tableSelection:    new Set(), // paths explicitly selected by the user
    lastClickedRowIdx: -1,        // for shift+click range

    // Lasso selection state (tracked in watchAtlasSelection)
    lassoActive: false,

    // Delete modal
    pendingDelete: null, // { paths:[], names:[], rowIds:[] }

    // Index modal
    indexStep:           null,   // null|'folders'|'explore'|'indexing'|'done'
    indexFolders:        [],     // selected root folders
    indexDefaultFolders: [],
    indexCustomFolder:   "",
    indexNewFiles:       [],     // from scan (new, unindexed files)
    indexIndexedCount:   0,
    indexLog:            [],
    indexDone:           false,
    indexEventSource:    null,

    // File explorer (explore step)
    indexExploreDir:     null,   // currently browsed dir path
    indexDirCache:       {},     // path → { dirs, files, parent } from /api/browse
    indexDirLoading:     false,
    indexBreadcrumb:     [],     // [{name, path}] navigation history
    indexFileChecked:    new Map(),  // path → bool (explicit overrides; default = true for new files)
    indexNewPaths:       new Set(),  // set of all new file paths from scan
    indexSearch:         "",         // explore step search filter
  };

  // ── DOM ready ──────────────────────────────────────────────────────────────
  const whenReady = fn =>
    document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", fn)
      : fn();

  // ── Escape helpers ─────────────────────────────────────────────────────────
  const esc  = s => String(s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const attr = s => String(s).replace(/"/g,"&quot;");
  const sqlStr = s => String(s).replace(/'/g,"''"); // single-quote escape for DuckDB

  // ════════════════════════════════════════════════════════════════════════════
  // PANEL HTML
  // ════════════════════════════════════════════════════════════════════════════
  function createPanel() {
    const p = document.createElement("div");
    p.id = "ms-panel";
    p.innerHTML = `
      <div id="ms-header">
        <span id="ms-logo">🔍</span>
        <span id="ms-title">Multimodal Search</span>
        <button id="ms-collapse-btn" title="Collapse">−</button>
      </div>
      <div id="ms-body">
        <div id="ms-search-row">
          <input id="ms-input" type="text"
            placeholder="images with BAP logo, lecture notes, resume…"
            autocomplete="off" spellcheck="false"/>
          <select id="ms-type-filter">
            <option value="">All</option>
            <option value="image">🖼 Images</option>
            <option value="pdf">📄 PDFs</option>
            <option value="video">🎬 Videos</option>
          </select>
          <button id="ms-search-btn">Search</button>
        </div>
        <div id="ms-status"></div>
        <div id="ms-results"></div>
      </div>`;
    return p;
  }

  function createClearFloat() {
    const el = document.createElement("div");
    el.id = "ms-clear-float";
    el.innerHTML = `<button id="ms-clear-float-btn">✕ Clear highlights</button>`;
    el.querySelector("#ms-clear-float-btn").addEventListener("click", clearAll);
    return el;
  }

  function createIndexFab() {
    const el = document.createElement("div");
    el.id = "ms-index-fab";
    el.innerHTML = `<button id="ms-index-fab-btn" title="Index new files">📂 Index Files</button>`;
    el.querySelector("#ms-index-fab-btn").addEventListener("click", openIndexModal);
    return el;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // DELETE MODAL
  // ════════════════════════════════════════════════════════════════════════════
  function createDeleteModal() {
    const el = document.createElement("div");
    el.id = "ms-delete-modal";
    el.className = "ms-modal-overlay";
    el.style.display = "none";
    el.innerHTML = `
      <div class="ms-modal-card ms-delete-card">
        <div class="ms-modal-header">
          <span class="ms-modal-title">Remove from Index</span>
          <button class="ms-modal-close" id="ms-delete-cancel-x">✕</button>
        </div>
        <div id="ms-delete-body" class="ms-modal-body"></div>
        <div class="ms-modal-footer">
          <button class="ms-btn-ghost" id="ms-delete-cancel">Cancel</button>
          <button class="ms-btn-danger" id="ms-delete-confirm">Delete</button>
        </div>
      </div>`;
    document.getElementById("ms-delete-cancel-x")?.addEventListener("click", closeDeleteModal);
    document.getElementById("ms-delete-cancel")?.addEventListener("click", closeDeleteModal);
    document.getElementById("ms-delete-confirm")?.addEventListener("click", () => {
      const checked = document.querySelector('input[name="ms-delete-mode"]:checked');
      executeDelete(checked?.value === "disk");
    });
    el.addEventListener("click", e => { if (e.target === el) closeDeleteModal(); });
    return el;
  }

  function openDeleteModal(paths, names, rowIds = []) {
    state.pendingDelete = { paths, names, rowIds };
    const body = document.getElementById("ms-delete-body");
    if (!body) return;

    const nameList = names.slice(0, 5).map(n => `<li>${esc(n)}</li>`).join("");
    const more = names.length > 5 ? `<li class="ms-more">+ ${names.length - 5} more…</li>` : "";

    body.innerHTML = `
      <p class="ms-delete-desc">Remove <strong>${names.length}</strong> file${names.length !== 1 ? "s" : ""} from the search index?</p>
      <ul class="ms-delete-list">${nameList}${more}</ul>
      <div class="ms-delete-options">
        <label class="ms-radio-label">
          <input type="radio" name="ms-delete-mode" value="index" checked>
          <span>
            <strong>Remove from index only</strong>
            <small>File stays on your disk — just won't appear in search</small>
          </span>
        </label>
        <label class="ms-radio-label ms-radio-danger">
          <input type="radio" name="ms-delete-mode" value="disk">
          <span>
            <strong>Remove from index AND delete file permanently</strong>
            <small>⚠️ This cannot be undone</small>
          </span>
        </label>
      </div>`;

    const modal = document.getElementById("ms-delete-modal");
    if (modal) modal.style.display = "flex";
  }

  function closeDeleteModal() {
    const modal = document.getElementById("ms-delete-modal");
    if (modal) modal.style.display = "none";
    state.pendingDelete = null;
  }

  async function executeDelete(deleteFile) {
    if (!state.pendingDelete) return;
    const { paths, names, rowIds } = state.pendingDelete;
    closeDeleteModal();

    try {
      // 1. Delete from ChromaDB + manifest (+ optional file)
      const res = await fetch("/api/delete-items", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ paths, delete_file: deleteFile }),
      });
      const data = await res.json();

      // 2. Delete from Atlas DuckDB so the data table updates
      for (const path of paths) {
        await fetch("/data/query", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ type: "exec", sql: `DELETE FROM dataset WHERE path = '${sqlStr(path)}'` }),
        });
      }

      // 3. Remove from search results UI
      state.results = state.results.filter(r => !paths.includes(r.path));
      for (const r of state.results) state.matchIds.delete(r.row_id);
      renderStatus();
      renderResults();

      // 4. Force Atlas color refresh so deleted dot loses its highlight
      forceAtlasRefresh();

      // 5. Clear selection state for deleted paths
      for (const p of paths) state.tableSelection.delete(p);
      updateDeleteFloat();

      showToast(`Removed ${data.deleted} item${data.deleted !== 1 ? "s" : ""} from index.${deleteFile ? " File deleted." : ""}`);
    } catch (e) {
      showToast("Delete failed: " + e.message, true);
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // INDEX FILES MODAL
  // ════════════════════════════════════════════════════════════════════════════
  function createIndexModal() {
    const el = document.createElement("div");
    el.id = "ms-index-modal";
    el.className = "ms-modal-overlay";
    el.style.display = "none";
    el.innerHTML = `
      <div class="ms-modal-card ms-index-card">
        <div class="ms-modal-header">
          <span class="ms-modal-title">📂 Index New Files</span>
          <button class="ms-modal-close" id="ms-index-close">✕</button>
        </div>
        <div id="ms-index-body" class="ms-modal-body"></div>
      </div>`;
    document.getElementById("ms-index-close")?.addEventListener("click", closeIndexModal);
    el.addEventListener("click", e => { if (e.target === el && state.indexStep !== "indexing") closeIndexModal(); });
    return el;
  }

  function openIndexModal() {
    // Fetch default folders from server on first open
    fetch("/api/scan-folders")
      .then(r => r.json())
      .then(data => {
        state.indexDefaultFolders = data.default_folders || [];
        if (!state.indexFolders.length) {
          state.indexFolders = [...state.indexDefaultFolders];
        }
      })
      .catch(() => {
        state.indexDefaultFolders = [
          `${getHome()}/Documents`, `${getHome()}/Desktop`,
          `${getHome()}/Downloads`, `${getHome()}/Pictures`, `${getHome()}/Movies`,
        ];
        if (!state.indexFolders.length) state.indexFolders = [...state.indexDefaultFolders];
      })
      .finally(() => {
        state.indexStep = "folders";
        renderIndexModal();
      });

    state.indexStep = "folders";
    const modal = document.getElementById("ms-index-modal");
    if (modal) modal.style.display = "flex";
    renderIndexModal();
  }

  function closeIndexModal() {
    if (state.indexStep === "indexing") return; // can't close while running
    if (state.indexEventSource) { state.indexEventSource.close(); state.indexEventSource = null; }
    const modal = document.getElementById("ms-index-modal");
    if (modal) modal.style.display = "none";
    state.indexStep = null;
    state.indexNewFiles = [];
    state.indexLog = [];
    state.indexDone = false;
    state.indexSearch = "";
  }

  function getHome() {
    return (state.indexDefaultFolders[0] || "/Users/ash/Documents").replace(/\/Documents$/, "");
  }

  // Expand leading ~ to the real home directory so ~/foo and /Users/ash/foo compare equal
  // Also strip surrounding quotes (single or double) that users sometimes paste
  function expandHome(p) {
    if (!p) return p;
    if ((p.startsWith("'") && p.endsWith("'")) || (p.startsWith('"') && p.endsWith('"')))
      p = p.slice(1, -1);
    const h = getHome();
    return p.startsWith("~/") ? h + p.slice(1) : p;
  }

  function renderIndexModal() {
    const body = document.getElementById("ms-index-body");
    if (!body) return;

    if (state.indexStep === "folders") {
      const items = state.indexDefaultFolders.map(f => {
        const checked = state.indexFolders.includes(f) ? "checked" : "";
        const label = f.replace(/^\/Users\/[^/]+\//, "~/");
        return `<label class="ms-folder-row">
          <input type="checkbox" class="ms-folder-cb" value="${attr(f)}" ${checked}>
          <span class="ms-folder-name">${esc(label)}</span>
        </label>`;
      }).join("");

      body.innerHTML = `
        <p class="ms-index-desc">Choose folders to scan for new images, PDFs, and videos:</p>
        <div id="ms-folder-list">${items}</div>
        <div class="ms-custom-folder-row">
          <input id="ms-custom-folder" type="text" placeholder="Custom path, e.g. /Users/ash/Projects" autocomplete="off">
          <button id="ms-add-folder-btn">Add</button>
        </div>
        <div class="ms-modal-footer">
          <button class="ms-btn-ghost" id="ms-index-cancel-btn">Cancel</button>
          <button class="ms-btn-primary" id="ms-scan-btn">Scan Folders →</button>
        </div>`;

      body.querySelectorAll(".ms-folder-cb").forEach(cb => {
        cb.addEventListener("change", () => {
          if (cb.checked) {
            if (!state.indexFolders.includes(cb.value)) state.indexFolders.push(cb.value);
          } else {
            state.indexFolders = state.indexFolders.filter(f => f !== cb.value);
          }
        });
      });

      body.querySelector("#ms-add-folder-btn")?.addEventListener("click", () => {
        const raw = body.querySelector("#ms-custom-folder")?.value.trim();
        if (!raw) return;
        const val = expandHome(raw); // normalize ~/foo → /Users/ash/foo
        // Reject if already in the list (including under a different ~ alias)
        if (state.indexFolders.map(expandHome).includes(val)) {
          showToast("That path is already in the list.", true);
          return;
        }
        state.indexFolders.push(val);
        body.querySelector("#ms-custom-folder").value = "";
        const list = body.querySelector("#ms-folder-list");
        if (list) {
          const row = document.createElement("label");
          row.className = "ms-folder-row";
          const display = val.startsWith(getHome() + "/") ? "~/" + val.slice(getHome().length + 1) : val;
          row.innerHTML = `<input type="checkbox" class="ms-folder-cb" value="${attr(val)}" checked>
            <span class="ms-folder-name">${esc(display)}</span>`;
          // Handle both check AND uncheck so state stays in sync
          row.querySelector("input").addEventListener("change", e => {
            if (e.target.checked) {
              if (!state.indexFolders.includes(val)) state.indexFolders.push(val);
            } else {
              state.indexFolders = state.indexFolders.filter(f => f !== val);
            }
          });
          list.appendChild(row);
        }
      });

      body.querySelector("#ms-index-cancel-btn")?.addEventListener("click", closeIndexModal);
      body.querySelector("#ms-scan-btn")?.addEventListener("click", scanFolders);

    } else if (state.indexStep === "explore") {
      renderExploreStep(body);

    } else if (state.indexStep === "indexing") {
      body.innerHTML = `
        <div class="ms-index-progress-header">
          <span class="ms-spinner"></span> Indexing in progress…
        </div>
        <div id="ms-index-log" class="ms-index-log"></div>`;
      renderIndexLog();

    } else if (state.indexStep === "done") {
      body.innerHTML = `
        <div class="ms-index-done">
          <div class="ms-index-done-icon">✅</div>
          <h3>Indexing complete!</h3>
          <p>New files are immediately searchable. Updating the scatter plot…</p>
        </div>
        <div id="ms-index-log" class="ms-index-log ms-index-log-done"></div>`;
      renderIndexLog();
      startRebuildAtlas();

    } else if (state.indexStep === "rebuilding") {
      body.innerHTML = `
        <div class="ms-index-progress-header">
          <span class="ms-spinner"></span> Updating visualization…
        </div>
        <div id="ms-index-log" class="ms-index-log"></div>`;
      renderIndexLog();

    } else if (state.indexStep === "reloading") {
      body.innerHTML = `
        <div class="ms-index-done">
          <div class="ms-index-done-icon">🔄</div>
          <h3>Reloading…</h3>
          <p>The page will reload automatically in a moment.</p>
        </div>`;

    } else if (state.indexStep === "done-no-rebuild") {
      body.innerHTML = `
        <div class="ms-index-done">
          <div class="ms-index-done-icon">✅</div>
          <h3>Indexing complete!</h3>
          <p>Files are searchable. The scatter plot will update on next restart.</p>
        </div>
        <div id="ms-index-log" class="ms-index-log ms-index-log-done"></div>
        <div class="ms-modal-footer">
          <button class="ms-btn-primary" id="ms-index-finish-btn">Done</button>
        </div>`;
      renderIndexLog();
      body.querySelector("#ms-index-finish-btn")?.addEventListener("click", closeIndexModal);
    }
  }

  function renderIndexLog() {
    const el = document.getElementById("ms-index-log");
    if (!el) return;
    el.textContent = state.indexLog.join("\n");
    el.scrollTop = el.scrollHeight;
  }

  // ── Index modal: scan step ───────────────────────────────────────────────────
  async function scanFolders() {
    if (!state.indexFolders.length) { showToast("Select at least one folder first.", true); return; }
    const btn = document.getElementById("ms-scan-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Scanning…"; }
    try {
      const data = await fetch("/api/scan-folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folders: state.indexFolders }),
      }).then(r => r.json());
      state.indexNewFiles     = data.new || [];
      state.indexIndexedCount = data.indexed_count || 0;
      // Seed the new-paths set and file-checked map (all new files checked by default)
      state.indexNewPaths   = new Set(state.indexNewFiles.map(f => f.path));
      state.indexFileChecked = new Map();
      // Start at virtual root (null = show all selected folders as top-level entries)
      state.indexExploreDir  = null;
      state.indexDirCache    = {};
      state.indexBreadcrumb  = []; // empty = we're at virtual root
      state.indexStep = "explore";
      renderIndexModal();
    } catch (e) {
      showToast("Scan failed: " + e.message, true);
      if (btn) { btn.disabled = false; btn.textContent = "Scan Folders →"; }
    }
  }

  // ── Index modal: explore step ────────────────────────────────────────────────
  function exploreFileChecked(path) {
    if (state.indexFileChecked.has(path)) return state.indexFileChecked.get(path);
    return state.indexNewPaths.has(path); // new files default ON; indexed files default OFF
  }

  function exploreSelectedPaths() {
    // All new paths minus any the user unchecked, plus any indexed paths the user checked
    const result = [];
    for (const f of state.indexNewFiles) {
      if (exploreFileChecked(f.path)) result.push(f.path);
    }
    // Also include any indexed-file paths the user explicitly checked
    state.indexFileChecked.forEach((checked, path) => {
      if (checked && !state.indexNewPaths.has(path)) result.push(path);
    });
    return result;
  }

  function fmtSize(bytes) {
    if (bytes == null) return "";
    if (bytes < 1024)       return `${bytes} B`;
    if (bytes < 1024*1024)  return `${(bytes/1024).toFixed(0)} KB`;
    return `${(bytes/(1024*1024)).toFixed(1)} MB`;
  }

  function renderExploreStep(body) {
    // Override body padding so our flex children fill properly
    body.style.cssText = "padding:0;display:flex;flex-direction:column;overflow:hidden;";

    const selCount  = exploreSelectedPaths().length;
    const totalNew  = state.indexNewFiles.length;
    const crumb     = state.indexBreadcrumb;
    const curDir    = state.indexExploreDir;
    const searchQ   = state.indexSearch || "";

    // Breadcrumb: always start with a clickable "All Folders" root
    const rootCrumb = crumb.length === 0
      ? `<span class="ms-crumb-cur">All Folders</span>`
      : `<button class="ms-crumb-btn" id="ms-crumb-root">All Folders</button>`;
    const crumbHtml = [rootCrumb, ...crumb.map((c, i) => {
      if (i === crumb.length - 1) return `<span class="ms-crumb-cur">${esc(c.name)}</span>`;
      return `<button class="ms-crumb-btn" data-idx="${i}" data-path="${attr(c.path)}">${esc(c.name)}</button>`;
    })].join(`<span class="ms-crumb-sep">›</span>`);

    const loading = state.indexDirLoading;

    body.innerHTML = `
      <div class="ms-explore-header">
        <div class="ms-crumb">${crumbHtml}</div>
        <div class="ms-explore-bulk">
          <button class="ms-bulk-btn" id="ms-explore-all" title="Check all new files">All new</button>
          <button class="ms-bulk-btn" id="ms-explore-none" title="Uncheck everything">None</button>
        </div>
      </div>
      <div class="ms-explore-search-row">
        <input id="ms-explore-search" class="ms-explore-search" type="text"
          placeholder="Search files by name…" value="${attr(searchQ)}" autocomplete="off">
        <button class="ms-explore-search-clear" id="ms-explore-search-clear"
          title="Clear search" style="${searchQ ? "" : "visibility:hidden"}">✕</button>
      </div>
      <div id="ms-explore-tree" class="ms-explore-tree">
        ${loading ? `<div class="ms-explore-loading"><span class="ms-spinner"></span> Loading…</div>` : ""}
      </div>
      <div class="ms-explore-footer">
        <button class="ms-btn-ghost" id="ms-back-explore-btn">← Folders</button>
        <span class="ms-explore-sel-count">${selCount} of ${totalNew} new files selected</span>
        ${selCount > 0
          ? `<button class="ms-btn-primary" id="ms-start-index-btn">Index ${selCount} →</button>`
          : `<button class="ms-btn-ghost" id="ms-start-index-btn" disabled>Index 0</button>`}
      </div>`;

    body.querySelector("#ms-explore-all")?.addEventListener("click", () => {
      state.indexNewFiles.forEach(f => state.indexFileChecked.set(f.path, true));
      renderIndexModal();
    });
    body.querySelector("#ms-explore-none")?.addEventListener("click", () => {
      state.indexNewFiles.forEach(f => state.indexFileChecked.set(f.path, false));
      renderIndexModal();
    });
    body.querySelector("#ms-back-explore-btn")?.addEventListener("click", () => {
      state.indexStep = "folders";
      renderIndexModal();
    });
    body.querySelector("#ms-start-index-btn")?.addEventListener("click", () => {
      if (selCount > 0) startIndexing();
    });

    // "All Folders" root crumb → go back to virtual root
    body.querySelector("#ms-crumb-root")?.addEventListener("click", () => {
      state.indexExploreDir = null;
      state.indexBreadcrumb = [];
      renderIndexModal();
    });

    // Deeper breadcrumb nav
    body.querySelectorAll(".ms-crumb-btn[data-idx]").forEach(btn =>
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        state.indexBreadcrumb = state.indexBreadcrumb.slice(0, idx + 1);
        state.indexExploreDir = btn.dataset.path;
        renderIndexModal();
      }));

    // Search box — filter files by name across all new files
    const searchInput = body.querySelector("#ms-explore-search");
    searchInput?.addEventListener("input", () => {
      state.indexSearch = searchInput.value;
      const clr = document.getElementById("ms-explore-search-clear");
      if (clr) clr.style.visibility = searchInput.value ? "" : "hidden";
      renderSearchResults();
    });
    searchInput?.addEventListener("keydown", e => { if (e.key === "Escape") { state.indexSearch = ""; renderIndexModal(); } });
    body.querySelector("#ms-explore-search-clear")?.addEventListener("click", () => {
      state.indexSearch = "";
      renderIndexModal();
    });
    // Focus the search input without re-rendering on open
    if (searchQ) { searchInput?.focus(); }

    // Load: null = virtual root, string = real dir; skip if search active
    if (!loading) {
      if (searchQ) {
        renderSearchResults();
      } else if (!curDir) {
        renderExploreVirtualRoot();
      } else {
        loadExploreDir(curDir, body);
      }
    }
  }

  function renderSearchResults() {
    const tree  = document.getElementById("ms-explore-tree");
    if (!tree) return;
    const q = (state.indexSearch || "").toLowerCase().trim();
    if (!q) { renderExploreVirtualRoot(); return; }

    const matches = state.indexNewFiles.filter(f =>
      f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
    );

    if (!matches.length) {
      tree.innerHTML = `<div class="ms-explore-empty">No files matching "${esc(q)}"</div>`;
      return;
    }

    let html = "";
    matches.forEach(f => {
      const checked = exploreFileChecked(f.path);
      const icon    = f.type === "pdf" ? "📄" : f.type === "video" ? "🎬" : "🖼";
      const dir     = f.path.replace(/\/[^/]+$/, "").replace(/^\/Users\/[^/]+\//, "~/");
      html += `
        <label class="ms-explore-file-row">
          <input type="checkbox" class="ms-explore-cb" data-path="${attr(f.path)}" ${checked ? "checked" : ""}>
          <span class="ms-explore-file-icon">${icon}</span>
          <span class="ms-explore-file-name" title="${attr(f.path)}">${esc(f.name)}</span>
          <span class="ms-explore-file-dir">${esc(dir)}</span>
          <span class="ms-explore-file-size">${fmtSize(f.size)}</span>
          <button class="ms-explore-open-btn" data-path="${attr(f.path)}" title="Open file">↗</button>
        </label>`;
    });
    tree.innerHTML = html;

    tree.querySelectorAll(".ms-explore-cb").forEach(cb =>
      cb.addEventListener("change", () => {
        state.indexFileChecked.set(cb.dataset.path, cb.checked);
        const sel = exploreSelectedPaths().length;
        const info = document.querySelector(".ms-explore-sel-count");
        if (info) info.textContent = `${sel} of ${state.indexNewFiles.length} new files selected`;
        const btn  = document.getElementById("ms-start-index-btn");
        if (btn) { btn.textContent = `Index ${sel} →`; btn.disabled = sel === 0; }
      }));

    tree.querySelectorAll(".ms-explore-open-btn").forEach(btn =>
      btn.addEventListener("click", e => {
        e.preventDefault();
        fetch("/open-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: btn.dataset.path, action: "open" }),
        });
      }));
  }

  function renderExploreVirtualRoot() {
    const tree = document.getElementById("ms-explore-tree");
    if (!tree) return;
    if (!state.indexFolders.length) {
      tree.innerHTML = `<div class="ms-explore-empty">No folders selected.</div>`;
      return;
    }
    // Compute per-folder new-file counts from indexNewFiles
    const countByFolder = {};
    state.indexFolders.forEach(f => { countByFolder[f] = 0; });
    state.indexNewFiles.forEach(f => {
      for (const folder of state.indexFolders) {
        if (f.path.startsWith(folder + "/") || f.path === folder) {
          countByFolder[folder] = (countByFolder[folder] || 0) + 1;
          break;
        }
      }
    });

    // Build a set of file paths in indexNewFiles for quick lookup
    const filePathSet = new Map(state.indexNewFiles.map(f => [f.path, f]));

    let html = "";
    let hasFilePaths = false;
    state.indexFolders.forEach(folder => {
      const fileEntry = filePathSet.get(folder);
      if (fileEntry) {
        // This is an individual file path — render as a selectable file row
        hasFilePaths = true;
        const checked = exploreFileChecked(folder);
        const icon = fileEntry.type === "pdf" ? "📄" : fileEntry.type === "video" ? "🎬" : "🖼";
        const dir  = folder.replace(/\/[^/]+$/, "").replace(/^\/Users\/[^/]+\//, "~/");
        html += `
          <label class="ms-explore-file-row">
            <input type="checkbox" class="ms-explore-cb" data-path="${attr(folder)}" ${checked ? "checked" : ""}>
            <span class="ms-explore-file-icon">${icon}</span>
            <span class="ms-explore-file-name" title="${attr(folder)}">${esc(fileEntry.name)}</span>
            <span class="ms-explore-file-dir">${esc(dir)}</span>
            <span class="ms-explore-file-size">${fmtSize(fileEntry.size)}</span>
            <button class="ms-explore-open-btn" data-path="${attr(folder)}" title="Open file">↗</button>
          </label>`;
      } else {
        // Directory path — render as a navigable folder row
        const name  = folder.replace(/^\/Users\/[^/]+\//, "~/");
        const count = countByFolder[folder] || 0;
        const badge = count > 0
          ? `<span class="ms-explore-new-badge">${count} new</span>` : "";
        html += `
          <div class="ms-explore-dir-row ms-explore-root-row" data-dir-path="${attr(folder)}">
            <span class="ms-explore-dir-icon">📂</span>
            <span class="ms-explore-dir-name">${esc(name)}</span>
            ${badge}
            <span class="ms-explore-dir-arrow">›</span>
          </div>`;
      }
    });
    tree.innerHTML = html;

    // Wire up checkbox change handlers for directly-rendered file rows
    if (hasFilePaths) {
      tree.querySelectorAll(".ms-explore-cb").forEach(cb =>
        cb.addEventListener("change", () => {
          state.indexFileChecked.set(cb.dataset.path, cb.checked);
          const sel  = exploreSelectedPaths().length;
          const info = document.querySelector(".ms-explore-sel-count");
          if (info) info.textContent = `${sel} of ${state.indexNewFiles.length} new files selected`;
          const btn  = document.getElementById("ms-start-index-btn");
          if (btn) { btn.textContent = `Index ${sel} →`; btn.disabled = sel === 0; }
        }));
      tree.querySelectorAll(".ms-explore-open-btn").forEach(btn =>
        btn.addEventListener("click", e => {
          e.preventDefault();
          fetch("/open-file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: btn.dataset.path, action: "open" }),
          });
        }));
    }

    tree.querySelectorAll(".ms-explore-root-row").forEach(row =>
      row.addEventListener("click", () => {
        const p = row.dataset.dirPath;
        const label = row.querySelector(".ms-explore-dir-name").textContent;
        state.indexBreadcrumb = [{ name: label, path: p }];
        state.indexExploreDir = p;
        renderIndexModal();
      }));
  }

  async function loadExploreDir(dirPath, body) {
    if (state.indexDirCache[dirPath]) {
      renderExploreTree(body, state.indexDirCache[dirPath]);
      return;
    }
    state.indexDirLoading = true;
    const tree = document.getElementById("ms-explore-tree");
    if (tree) tree.innerHTML = `<div class="ms-explore-loading"><span class="ms-spinner"></span> Loading…</div>`;

    try {
      const data = await fetch(`/api/browse?path=${encodeURIComponent(dirPath)}`).then(r => r.json());
      state.indexDirCache[dirPath] = data;
      state.indexDirLoading = false;
      renderExploreTree(body, data);
    } catch (e) {
      state.indexDirLoading = false;
      const tree2 = document.getElementById("ms-explore-tree");
      if (tree2) tree2.innerHTML = `<div class="ms-explore-empty">⚠ Could not read folder.</div>`;
    }
  }

  function renderExploreTree(body, dirData) {
    const tree = document.getElementById("ms-explore-tree");
    if (!tree) return;

    const { dirs = [], files = [] } = dirData;

    if (!dirs.length && !files.length) {
      tree.innerHTML = `<div class="ms-explore-empty">No supported files here.</div>`;
      return;
    }

    let html = "";

    // Directories first
    dirs.forEach(d => {
      const badge = d.new > 0
        ? `<span class="ms-explore-new-badge">${d.new} new</span>` : "";
      const indexedNote = d.new === 0 && d.total > 0
        ? `<span class="ms-explore-indexed-note">all indexed</span>` : "";
      html += `
        <div class="ms-explore-dir-row" data-dir-path="${attr(d.path)}">
          <span class="ms-explore-dir-icon">📁</span>
          <span class="ms-explore-dir-name">${esc(d.name)}/</span>
          ${badge}${indexedNote}
          <span class="ms-explore-dir-count">${d.total} file${d.total !== 1 ? "s" : ""}</span>
          <span class="ms-explore-dir-arrow">›</span>
        </div>`;
    });

    // Files
    files.forEach(f => {
      const isNew     = state.indexNewPaths.has(f.path);
      const checked   = exploreFileChecked(f.path);
      const icon      = f.type === "pdf" ? "📄" : f.type === "video" ? "🎬" : "🖼";
      const statusBadge = isNew
        ? `<span class="ms-explore-new-badge">new</span>`
        : `<span class="ms-explore-indexed-note">indexed</span>`;
      html += `
        <label class="ms-explore-file-row${!isNew ? " ms-explore-already-indexed" : ""}">
          <input type="checkbox" class="ms-explore-cb" data-path="${attr(f.path)}"
            ${checked ? "checked" : ""}
            ${!isNew && !checked ? "title=\"Already indexed — check to re-index\"" : ""}>
          <span class="ms-explore-file-icon">${icon}</span>
          <span class="ms-explore-file-name" title="${attr(f.path)}">${esc(f.name)}</span>
          ${statusBadge}
          <span class="ms-explore-file-size">${fmtSize(f.size)}</span>
          <button class="ms-explore-open-btn" data-path="${attr(f.path)}" title="Open file">↗</button>
        </label>`;
    });

    tree.innerHTML = html;

    // Directory click → navigate in
    tree.querySelectorAll(".ms-explore-dir-row").forEach(row =>
      row.addEventListener("click", () => {
        const dirPath = row.dataset.dirPath;
        const name = row.querySelector(".ms-explore-dir-name").textContent.replace(/\/$/, "");
        state.indexBreadcrumb.push({ name, path: dirPath });
        state.indexExploreDir = dirPath;
        renderIndexModal();
      }));

    // Open file buttons
    tree.querySelectorAll(".ms-explore-open-btn").forEach(btn =>
      btn.addEventListener("click", e => {
        e.preventDefault(); // don't toggle the label's checkbox
        fetch("/open-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: btn.dataset.path, action: "open" }),
        });
      }));

    // Checkbox change
    tree.querySelectorAll(".ms-explore-cb").forEach(cb =>
      cb.addEventListener("change", () => {
        state.indexFileChecked.set(cb.dataset.path, cb.checked);
        // Update footer count without full re-render
        const sel  = exploreSelectedPaths().length;
        const info = document.querySelector(".ms-explore-sel-count");
        if (info) info.textContent = `${sel} of ${state.indexNewFiles.length} new files selected`;
        const btn  = document.getElementById("ms-start-index-btn");
        if (btn) { btn.textContent = `Index ${sel} →`; btn.disabled = sel === 0; }
      }));
  }

  function exploreNavigateTo(dirPath) {
    state.indexExploreDir = dirPath;
    renderIndexModal();
  }

  // ── Index modal: indexing step ───────────────────────────────────────────────
  async function startIndexing() {
    const selectedPaths = exploreSelectedPaths();
    if (!selectedPaths.length) { showToast("No files selected.", true); return; }

    state.indexStep = "indexing";
    state.indexLog  = [`Starting indexer for ${selectedPaths.length} file${selectedPaths.length !== 1 ? "s" : ""}…`];
    state.indexDone = false;
    renderIndexModal();

    const closeBtn = document.getElementById("ms-index-close");
    if (closeBtn) closeBtn.style.display = "none";

    let streamUrl;
    try {
      const res = await fetch("/api/index-session", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ paths: selectedPaths }),
      });
      const { session_id } = await res.json();
      streamUrl = `/api/index-files-stream/${session_id}`;
    } catch (_) {
      streamUrl = `/api/index-stream?folders=${encodeURIComponent(state.indexFolders.join(","))}`;
    }

    const es = new EventSource(streamUrl);
    state.indexEventSource = es;

    es.onmessage = e => {
      const data = JSON.parse(e.data);
      if (data.line) { state.indexLog.push(data.line); renderIndexLog(); }
      if (data.done || data.error) {
        es.close();
        state.indexEventSource = null;
        state.indexDone = true;
        state.indexStep = "done";
        const cb2 = document.getElementById("ms-index-close");
        if (cb2) cb2.style.display = "";
        renderIndexModal();
      }
    };
    es.onerror = () => {
      if (!state.indexDone) {
        state.indexLog.push("— Connection lost. —");
        state.indexStep = "done";
        renderIndexModal();
      }
      es.close();
    };
  }

  function startRebuildAtlas() {
    state.indexStep = "rebuilding";
    state.indexLog  = ["Rebuilding scatter plot…"];
    renderIndexModal();

    const es = new EventSource("/api/rebuild-atlas");

    es.onmessage = e => {
      const data = JSON.parse(e.data);
      if (data.line) { state.indexLog.push(data.line); renderIndexLog(); }
      if (data.done) {
        es.close();
        state.indexStep = "reloading";
        renderIndexModal();
        // Poll until server is back up, then reload
        const poll = () => {
          fetch("/").then(r => { if (r.ok) location.reload(); else setTimeout(poll, 800); })
                    .catch(() => setTimeout(poll, 800));
        };
        setTimeout(poll, 1500);
      }
      if (data.error) {
        es.close();
        state.indexLog.push("⚠ Rebuild failed: " + data.error);
        state.indexStep = "done-no-rebuild";
        renderIndexModal();
      }
    };
    es.onerror = () => { es.close(); };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ATLAS COLOR HIGHLIGHTING
  // ════════════════════════════════════════════════════════════════════════════
  async function duckdbExec(sql) {
    try {
      await fetch("/data/query", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ type: "exec", sql }),
      });
    } catch (_) {}
  }

  function atlasColorSelect() {
    return [...document.querySelectorAll("select")]
      .find(s => [...s.options].some(o => o.value === "undefined")) || null;
  }

  function setAtlasColorField(value) {
    const sel = atlasColorSelect();
    if (!sel || sel.value === value) return;
    sel.value = value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function forceAtlasRefresh() {
    const sel = atlasColorSelect();
    if (!sel) return;
    const cur = sel.value;
    const tmp = cur === "undefined" ? '"row_id"' : "undefined";
    sel.value = tmp;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    setTimeout(() => {
      sel.value = cur;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }, 150);
  }

  async function highlightMatches(results) {
    if (!results.length) return;
    const cases = results
      .filter(r => r.row_id != null)
      .map(r => `WHEN row_id = ${r.row_id} THEN ${Number(r.score).toFixed(4)}`)
      .join(" ");
    await duckdbExec("UPDATE dataset SET search_match = 0.0");
    await duckdbExec(`UPDATE dataset SET search_match = CASE ${cases} ELSE 0.0 END`);
    setTimeout(() => setAtlasColorField('"search_match"'), 120);
  }

  async function clearHighlights() {
    await duckdbExec("UPDATE dataset SET search_match = 0.0");
    setAtlasColorField("undefined");
    state.selectedRowId = null;
  }

  // Opens the Obsidian-style graph view, actually selects the node (turns it
  // red), pins an info popup on it, and animates the camera toward it.
  // Used when the user clicks a result card.
  async function selectInGraph(item) {
    if (!item.path) { showToast("Can't locate this item on the graph.", true); return; }

    state.selectedRowId = item.row_id ?? null;
    document.querySelectorAll(".ms-card").forEach(c =>
      c.classList.toggle("ms-card-selected", c.dataset.path === item.path));

    await focusNodeInGraph(item.path, item.name);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // TOAST NOTIFICATIONS
  // ════════════════════════════════════════════════════════════════════════════
  function showToast(msg, isError = false) {
    const existing = document.getElementById("ms-toast");
    if (existing) existing.remove();
    const t = document.createElement("div");
    t.id = "ms-toast";
    t.className = isError ? "ms-toast ms-toast-error" : "ms-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add("ms-toast-visible"), 10);
    setTimeout(() => { t.classList.remove("ms-toast-visible"); setTimeout(() => t.remove(), 300); }, 3500);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // STATUS BAR
  // ════════════════════════════════════════════════════════════════════════════
  function renderStatus() {
    const el = document.getElementById("ms-status");
    if (!el) return;
    if (state.loading) {
      el.innerHTML = '<span class="ms-spinner"></span> Searching with Gemini…';
      el.className = "ms-status-loading"; return;
    }
    if (state.error) {
      el.textContent = "⚠ " + state.error;
      el.className = "ms-status-error"; return;
    }
    if (state.results.length) {
      const n = state.results.length;
      el.innerHTML =
        `<span class="ms-badge">${n} match${n !== 1 ? "es" : ""}</span>` +
        `<span class="ms-query-label"> for "${esc(state.query)}"</span>` +
        `<span class="ms-cmd-hint"> · ⌘ click to select</span>`;
      el.className = "ms-status-results"; return;
    }
    el.textContent = ""; el.className = "";
  }

  function setClearFloatVisible(v) {
    const el = document.getElementById("ms-clear-float");
    if (el) el.style.display = v ? "flex" : "none";
  }

  // ════════════════════════════════════════════════════════════════════════════
  // RESULT CARDS
  // ════════════════════════════════════════════════════════════════════════════
  function renderResults() {
    const el = document.getElementById("ms-results");
    if (!el) return;
    if (!state.results.length) { el.innerHTML = ""; return; }

    el.innerHTML = state.results.map(r => {
      const icon  = r.type === "image" ? "🖼" : r.type === "pdf" ? "📄" : "🎬";
      const pct   = Math.round(r.score * 100);
      const thumb = r.thumbnail
        ? `<img class="ms-thumb" src="${r.thumbnail}" alt="" loading="lazy">`
        : `<div class="ms-thumb ms-thumb-placeholder">${icon}</div>`;
      const prev  = r.preview
        ? `<p class="ms-preview">${esc(r.preview.slice(0, 120))}</p>` : "";
      return `
        <div class="ms-card${r.row_id === state.selectedRowId ? " ms-card-selected" : ""}${state.tableSelection.has(r.path) ? " ms-card-checked" : ""}"
             data-path="${attr(r.path)}" data-ms-path="${attr(r.path)}" data-rowid="${r.row_id}"
             title="Click: view in graph · ⌘ Click: add to selection for bulk delete">
          <div class="ms-card-thumb">${thumb}</div>
          <div class="ms-card-info">
            <div class="ms-card-name" title="${attr(r.path)}">${esc(r.name)}</div>
            <div class="ms-card-meta">
              <span class="ms-type-pill ms-type-${r.type}">${r.type.toUpperCase()}</span>
              <span class="ms-score">${pct}% match</span>
            </div>
            ${prev}
            <div class="ms-card-actions">
              <button class="ms-btn-open"   data-path="${attr(r.path)}">Open</button>
              <button class="ms-btn-reveal" data-path="${attr(r.path)}">Show in Finder</button>
              <button class="ms-btn-delete" data-path="${attr(r.path)}" data-name="${attr(r.name)}" title="Remove from index">🗑 Delete</button>
            </div>
          </div>
        </div>`;
    }).join("");

    el.querySelectorAll(".ms-card").forEach(card =>
      card.addEventListener("click", e => {
        if (e.target.closest("button")) return; // Open / Finder / Delete buttons handled separately
        const path  = card.dataset.path;
        const rowId = card.dataset.rowid === "null" ? null : Number(card.dataset.rowid);
        const item  = state.results.find(r => r.path === path) ||
                       { path, row_id: rowId, name: card.querySelector(".ms-card-name")?.textContent || "item" };
        if (e.metaKey) {
          // ⌘+click: toggle this card in/out of the bulk-delete selection
          if (state.tableSelection.has(path)) {
            state.tableSelection.delete(path);
            card.classList.remove("ms-card-checked");
          } else {
            state.tableSelection.add(path);
            card.classList.add("ms-card-checked");
          }
          updateDeleteFloat();
          return;
        }
        // Normal click: open in graph view
        selectInGraph(item);
      }));
    el.querySelectorAll(".ms-btn-open").forEach(b =>
      b.addEventListener("click", e => { e.stopPropagation(); openFile(b.dataset.path, "open"); }));
    el.querySelectorAll(".ms-btn-reveal").forEach(b =>
      b.addEventListener("click", e => { e.stopPropagation(); openFile(b.dataset.path, "reveal"); }));
    el.querySelectorAll(".ms-btn-delete").forEach(b =>
      b.addEventListener("click", e => {
        e.stopPropagation();
        openDeleteModal([b.dataset.path], [b.dataset.name]);
      }));
  }

  // ════════════════════════════════════════════════════════════════════════════
  // API HELPERS
  // ════════════════════════════════════════════════════════════════════════════
  async function runSearch(query, typeFilter) {
    state.loading = true;
    state.error   = null;
    state.results = [];
    state.query   = query;
    state.matchIds.clear();
    state.selectedRowId = null;
    // Kill any lasso float the moment search starts — don't wait for the interval
    state.lassoActive = false;
    const _lf = document.getElementById("ms-delete-sel-float");
    if (_lf) _lf.style.display = "none";
    setClearFloatVisible(false);
    renderStatus();
    renderResults();

    try {
      const res  = await fetch("/gemini-search", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ query, type_filter: typeFilter, k: 40 }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      state.results = data.results || [];
      for (const r of state.results) if (r.row_id != null) state.matchIds.add(r.row_id);
      highlightMatches(state.results);
    } catch (err) {
      state.error = err.message || "Search failed";
    } finally {
      state.loading = false;
      renderStatus();
      renderResults();
      setClearFloatVisible(state.results.length > 0);
    }
  }

  async function openFile(path, action) {
    try {
      await fetch("/open-file", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ path, action }),
      });
    } catch (_) {}
  }

  function clearAll() {
    state.results = [];
    state.error   = null;
    state.query   = "";
    state.matchIds.clear();
    state.selectedRowId = null;
    const inp = document.getElementById("ms-input");
    if (inp) inp.value = "";
    setClearFloatVisible(false);
    clearHighlights();
    renderStatus();
    renderResults();
    document.querySelectorAll(".ms-dot-actions").forEach(el => el.remove());
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PATH/NAME LOOKUP MAPS
  // ════════════════════════════════════════════════════════════════════════════
  async function loadAllCoords() {
    try {
      const res  = await fetch("/api/map-coords");
      if (!res.ok) return;
      const data = await res.json();
      state.nameToItem = {};
      state.pathToItem = {};
      for (const item of data.items) {
        state.nameToItem[item.name] = item;
        state.pathToItem[item.path] = item;
      }
    } catch (_) {}
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ATLAS DATA TABLE — Open / Finder / Delete buttons
  // ════════════════════════════════════════════════════════════════════════════
  function injectTableActions() {
    const tbody = document.querySelector("table tbody");
    if (!tbody) return;

    const allRows = [...tbody.querySelectorAll("tr")];
    for (let rowIdx = 0; rowIdx < allRows.length; rowIdx++) {
      const row = allRows[rowIdx];
      if (row.querySelector(".ms-tbl-actions")) continue;

      // Resolve path from cell text — works for ALL rows, not just search results.
      // Priority: exact match in pathToItem → any /Users/ cell text → partial match.
      let path = null;
      const cells = [...row.querySelectorAll("td")];
      for (const td of cells) {
        const t = td.textContent.trim();
        if (!t) continue;
        if (state.pathToItem[t]) { path = t; break; }
        if (t.startsWith("/Users/") && t.length > 10 && !t.includes("\n")) {
          // Use as-is: covers doc_id/path columns in the Atlas table
          path = t;
          break;
        }
      }
      // Fallback: partial match against known paths
      if (!path) {
        for (const td of cells) {
          const t = td.textContent.trim();
          if (!t) continue;
          for (const p of Object.keys(state.pathToItem)) {
            if (p.endsWith(t) || t.endsWith(state.pathToItem[p]?.name || "\0")) { path = p; break; }
          }
          if (path) break;
        }
      }
      if (!path) continue;

      // Tag row for selection tracking
      row.dataset.msPath = path;
      if (state.tableSelection.has(path)) row.classList.add("ms-row-selected");

      // Cmd+click / Shift+click to toggle selection (capture phase beats Atlas)
      row.addEventListener("click", e => {
        if (!e.metaKey && !e.shiftKey) return;
        e.stopPropagation();
        toggleRowSelection(path, row, allRows, rowIdx, e.shiftKey);
      }, true);

      const item = state.pathToItem[path];
      const name = item?.name || path.split("/").pop();
      const cell = row.querySelector("td");
      if (!cell) continue;

      const wrap = document.createElement("span");
      wrap.className = "ms-tbl-actions";
      wrap.innerHTML =
        `<button class="ms-tbl-btn" data-action="open"   data-path="${attr(path)}">Open</button>` +
        `<button class="ms-tbl-btn" data-action="reveal" data-path="${attr(path)}">Finder</button>` +
        `<button class="ms-tbl-btn ms-tbl-btn-del" data-action="delete" data-path="${attr(path)}" data-name="${attr(name)}">Delete</button>`;

      wrap.querySelectorAll(".ms-tbl-btn").forEach(b => {
        b.addEventListener("click", e => {
          e.stopPropagation();
          if (b.dataset.action === "delete") {
            openDeleteModal([b.dataset.path], [b.dataset.name || b.dataset.path]);
          } else {
            openFile(b.dataset.path, b.dataset.action);
          }
        });
      });
      cell.prepend(wrap);
    }
  }

  function watchAtlasTable() {
    const run = () => injectTableActions();
    const observer = new MutationObserver(run);
    const wait = setInterval(() => {
      const tbody = document.querySelector("table tbody");
      if (!tbody) return;
      clearInterval(wait);
      run();
      // subtree:true catches Atlas filling cell content after rows are created
      observer.observe(tbody, { childList: true, subtree: true });
    }, 300);
    // Also poll periodically so newly loaded pages / Atlas navigation pick up
    setInterval(run, 1200);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ATLAS NEIGHBOR / INSPECTOR PANEL — cmd+click to select items for deletion
  // Atlas shows a "Neighbors of #N" panel with per-item field cards when you
  // click a dot. We inject selection behaviour onto those cards.
  // ════════════════════════════════════════════════════════════════════════════
  function injectInspectorSelection() {
    const OWN = "#ms-panel,#ms-graph-overlay,#ms-delete-sel-float,#ms-clear-float,#ms-delete-modal,#ms-index-modal,#ms-index-fab";

    // Find the "Neighbors of #N" inspector panel
    let inspectorRoot = null;
    {
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tw.nextNode())) {
        if (n.textContent.match(/Neighbors of #\d+/)) {
          // Walk up until we find a sizeable scrollable container
          let el = n.parentElement;
          while (el && el !== document.body) {
            if (el.scrollHeight > 200 || el.children.length >= 3) { inspectorRoot = el; break; }
            el = el.parentElement;
          }
          break;
        }
      }
    }
    if (!inspectorRoot) return;

    // Strategy: find the SMALLEST element that contains BOTH "row_id" AND "/Users/"
    // in its full textContent — that's the card boundary.
    // Skip any element whose child already satisfies both conditions (not the leaf).
    const cards = [];
    for (const el of inspectorRoot.querySelectorAll("*")) {
      if (el.dataset.msSelectable) continue;
      if (el.closest(OWN)) continue;
      const text = el.textContent;
      if (!text.includes("row_id") || !text.includes("/Users/")) continue;

      // Is any direct child also a full card? If so, skip — we want the innermost.
      let childIsCard = false;
      for (const ch of el.children) {
        if (ch.textContent.includes("row_id") && ch.textContent.includes("/Users/")) {
          childIsCard = true; break;
        }
      }
      if (childIsCard) continue;

      // Extract the actual path value — first text node anywhere inside that starts with /Users/
      let pathVal = null;
      const ctw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let cn;
      while ((cn = ctw.nextNode())) {
        const t = cn.textContent.trim();
        if (t.startsWith("/Users/") && t.length > 10) { pathVal = t; break; }
      }
      if (!pathVal) continue;

      el.dataset.msSelectable = "1";
      el.dataset.msPath = pathVal;
      cards.push(el);
    }

    if (!cards.length) return;

    cards.forEach((card, idx) => {
      const path = card.dataset.msPath;
      if (state.tableSelection.has(path)) card.classList.add("ms-row-selected");

      // Use capture so we intercept before Atlas's own click handlers
      card.addEventListener("click", e => {
        if (!e.metaKey && !e.shiftKey) return;
        e.stopPropagation();
        e.preventDefault();
        toggleRowSelection(path, card, cards, idx, e.shiftKey);
      }, true);

      // Selection hint badge
      if (!card.querySelector(".ms-nb-sel-hint")) {
        const hint = document.createElement("span");
        hint.className = "ms-nb-sel-hint";
        hint.textContent = "⌘ click to select";
        card.appendChild(hint);
      }
    });
  }

  function watchAtlasInspector() {
    let debounce = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(injectInspectorSelection, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ATLAS DOT TOOLTIP — Open / Finder / Delete buttons
  // ════════════════════════════════════════════════════════════════════════════
  function resolveItemFromTooltip(tooltip) {
    const walker = document.createTreeWalker(tooltip, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = (node.textContent || "").trim();
      if (!t) continue;
      if (state.pathToItem[t]) return state.pathToItem[t];
      if (state.nameToItem[t]) return state.nameToItem[t];
      if (t.startsWith("/Users/")) {
        for (const [p, item] of Object.entries(state.pathToItem)) {
          if (p.startsWith(t) || t.includes(item.name)) return item;
        }
      }
    }
    return null;
  }

  function injectIntoAtlasTooltip(tooltip) {
    if (tooltip.querySelector(".ms-dot-actions")) return;
    const item = resolveItemFromTooltip(tooltip);
    if (!item) return;

    const row = document.createElement("div");
    row.className = "ms-dot-actions";
    row.innerHTML =
      `<button class="ms-dot-btn ms-dot-btn-open"   data-path="${attr(item.path)}">Open</button>` +
      `<button class="ms-dot-btn ms-dot-btn-reveal" data-path="${attr(item.path)}">Show in Finder</button>` +
      `<button class="ms-dot-btn ms-dot-btn-delete" data-path="${attr(item.path)}" data-name="${attr(item.name)}">🗑 Delete</button>`;

    row.querySelector(".ms-dot-btn-open").addEventListener("click", e => {
      e.stopPropagation(); openFile(item.path, "open");
    });
    row.querySelector(".ms-dot-btn-reveal").addEventListener("click", e => {
      e.stopPropagation(); openFile(item.path, "reveal");
    });
    row.querySelector(".ms-dot-btn-delete").addEventListener("click", e => {
      e.stopPropagation(); openDeleteModal([item.path], [item.name]);
    });
    tooltip.appendChild(row);
  }

  function watchAtlasTooltip() {
    setInterval(() => {
      const tooltip = document.querySelector('[class*="shadow-md"][class*="flex-col"][class*="p-2"]');
      if (!tooltip) return;
      if (tooltip.closest("#ms-panel")) return;
      if (tooltip.querySelector(".ms-dot-actions")) return;
      // Only inject into floating tooltips (absolute/fixed), not legend panel rows
      const pos = window.getComputedStyle(tooltip).position;
      if (pos !== "absolute" && pos !== "fixed") return;
      injectIntoAtlasTooltip(tooltip);
    }, 200);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // RESET VIEW — button injected into Atlas's Color panel row, always visible
  // ════════════════════════════════════════════════════════════════════════════
  function resetView() {
    // 1. Clear our search panel
    clearAll();

    // 2. Reset Atlas color encoding
    setAtlasColorField("undefined");

    // 3. Press Escape to clear any scatter selection / tooltip
    ["keydown", "keyup"].forEach(evtName =>
      document.dispatchEvent(new KeyboardEvent(evtName, { key: "Escape", code: "Escape", bubbles: true }))
    );

    // 4. Clear Atlas's own text search if visible
    document.querySelectorAll("input[type='text'], input:not([type])").forEach(inp => {
      if (inp.closest("#ms-panel, #ms-index-modal, #ms-delete-modal")) return;
      if (inp.id === "ms-input" || inp.id === "ms-custom-folder") return;
      if ((inp.placeholder || "").toLowerCase().includes("search") || inp.closest("[class*='search']")) {
        inp.value = "";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    showToast("View reset — filters and highlights cleared.");
  }

  function injectAtlasResetBtn() {
    if (document.getElementById("ms-reset-btn")) return;

    // The Color select sits inside a LABEL.flex.items-center.gap-2 inside a panel div.
    const colorSel = atlasColorSelect();
    if (!colorSel) return;

    // Walk up to find the flex panel that wraps the Color label + select
    const colorLabel = colorSel.closest("label");
    if (!colorLabel) return;
    const colorPanel = colorLabel.parentElement; // the flex div holding Color + gear
    if (!colorPanel || colorPanel.closest("#ms-panel")) return;

    const btn = document.createElement("button");
    btn.id        = "ms-reset-btn";
    btn.className = "ms-reset-btn";
    btn.textContent = "⟳ Reset";
    btn.title     = "Reset all filters, highlights, and color encoding";
    btn.addEventListener("click", resetView);
    colorPanel.appendChild(btn);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PRECISE MULTI-SELECT DELETE
  // Cmd+click or Cmd+Shift+click rows in the data table or Atlas neighbor
  // panel to build an exact selection set, then delete only those items.
  // ════════════════════════════════════════════════════════════════════════════
  function createDeleteSelectionFloat() {
    const el = document.createElement("div");
    el.id = "ms-delete-sel-float";
    el.style.display = "none";
    el.innerHTML = `
      <div id="ms-sel-header">
        <span id="ms-delete-sel-info">0 selected</span>
        <button id="ms-delete-sel-clear" title="Clear selection">✕ Clear</button>
      </div>
      <div id="ms-sel-list"></div>
      <button id="ms-delete-sel-btn">🗑 Delete Selected</button>`;
    return el;
  }

  function updateDeleteFloat() {
    const float = document.getElementById("ms-delete-sel-float");
    if (!float) return;
    const n = state.tableSelection.size;
    if (n === 0) { float.style.display = "none"; return; }

    float.style.display = "flex";
    const info = document.getElementById("ms-delete-sel-info");
    if (info) info.textContent = `${n} file${n !== 1 ? "s" : ""} selected`;

    const list = document.getElementById("ms-sel-list");
    if (list) {
      const entries = [...state.tableSelection].slice(0, 8);
      const more = state.tableSelection.size > 8
        ? `<span class="ms-sel-more">+${state.tableSelection.size - 8} more</span>` : "";
      list.innerHTML = entries.map(p => {
        const name = state.pathToItem[p]?.name || p.split("/").pop();
        return `<div class="ms-sel-item" title="${attr(p)}">
          <span class="ms-sel-remove" data-path="${attr(p)}">✕</span>
          <span class="ms-sel-name">${esc(name)}</span>
        </div>`;
      }).join("") + more;
      list.querySelectorAll(".ms-sel-remove").forEach(btn => {
        btn.addEventListener("click", e => {
          e.stopPropagation();
          const p = btn.dataset.path;
          state.tableSelection.delete(p);
          // un-highlight anywhere this path is shown (table rows and result cards)
          document.querySelectorAll(`[data-ms-path="${attr(p)}"]`).forEach(el => {
            el.classList.remove("ms-row-selected");
            el.classList.remove("ms-card-checked");
          });
          updateDeleteFloat();
        });
      });
    }
  }

  function clearTableSelection() {
    state.tableSelection.clear();
    state.lastClickedRowIdx = -1;
    document.querySelectorAll(".ms-row-selected").forEach(el =>
      el.classList.remove("ms-row-selected"));
    document.querySelectorAll(".ms-card-checked").forEach(el =>
      el.classList.remove("ms-card-checked"));
    const float = document.getElementById("ms-delete-sel-float");
    if (float) float.style.display = "none";
  }

  function toggleRowSelection(path, rowEl, allRows, rowIdx, shiftKey) {
    if (!path) return;
    if (shiftKey && state.lastClickedRowIdx >= 0 && allRows) {
      // Range select
      const lo = Math.min(state.lastClickedRowIdx, rowIdx);
      const hi = Math.max(state.lastClickedRowIdx, rowIdx);
      for (let i = lo; i <= hi; i++) {
        const r = allRows[i];
        const p = r?.dataset?.msPath;
        if (p) {
          state.tableSelection.add(p);
          r.classList.add("ms-row-selected");
        }
      }
    } else {
      if (state.tableSelection.has(path)) {
        state.tableSelection.delete(path);
        rowEl.classList.remove("ms-row-selected");
      } else {
        state.tableSelection.add(path);
        rowEl.classList.add("ms-row-selected");
      }
    }
    state.lastClickedRowIdx = rowIdx;
    updateDeleteFloat();
  }

  function deleteSelection() {
    let paths, names;

    if (state.tableSelection.size > 0) {
      // Precise: delete exactly what the user cmd+clicked
      paths = [...state.tableSelection];
      names = paths.map(p => state.pathToItem[p]?.name || p.split("/").pop());
    } else {
      // Fallback: lasso/crossfilter — read all visible table rows
      paths = []; names = [];
      document.querySelectorAll("table tbody tr").forEach(row => {
        const btn = row.querySelector(".ms-tbl-btn[data-path]");
        const p   = btn?.dataset.path;
        if (p && !paths.includes(p)) {
          paths.push(p);
          names.push(state.pathToItem[p]?.name || p.split("/").pop());
        }
      });
    }

    if (!paths.length) {
      showToast("Cmd+click rows to select files, then delete.", true);
      return;
    }
    openDeleteModal(paths, names);
  }

  function watchAtlasSelection() {
    // Show the lasso float ONLY when the user drew an actual lasso on the scatter
    // that filtered the table (i.e. fewer rows visible than the total dataset).
    // Strategy: track pointer drags on the scatter area AND require the table
    // row count to decrease after the drag — panning doesn't filter rows, but
    // a real lasso selection does.
    const OWN_PANELS = "#ms-panel,#ms-index-modal,#ms-delete-modal,#ms-delete-sel-float,#ms-clear-float,#ms-graph-overlay,#ms-index-fab";
    const DRAG_THRESHOLD = 15; // px

    // Fetch true total count once so we know when the table is filtered
    let baseTotal = 0;
    const tableRowCount = () => document.querySelectorAll("table tbody tr").length;
    fetch("/data/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "json", sql: "SELECT COUNT(*) AS n FROM dataset" }),
    }).then(r => r.json()).then(d => { baseTotal = d[0]?.n || 0; }).catch(() => {});

    let dragStartX = 0, dragStartY = 0, rowsAtDragStart = 0;
    let trackingCanvasDrag = false;

    document.addEventListener("pointerdown", e => {
      if (e.target.closest(OWN_PANELS)) return;
      // Only track drags that START on a <canvas> — lasso is drawn on the scatter
      // canvas; resize handles, buttons, and table rows are not canvas elements.
      if (e.target.tagName !== "CANVAS") return;
      trackingCanvasDrag = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      rowsAtDragStart = tableRowCount();
    }, { passive: true });

    document.addEventListener("pointerup", e => {
      if (!trackingCanvasDrag) return;
      trackingCanvasDrag = false;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
      setTimeout(() => {
        const rowsNow = tableRowCount();
        const total = baseTotal || Object.keys(state.pathToItem).length;
        // Only activate if the drag actually filtered the table — pans don't change rows
        if (rowsNow > 0 && rowsNow < rowsAtDragStart && (total === 0 || rowsNow < total)) {
          state.lassoActive = true;
        }
      }, 300);
    }, { passive: true });

    document.addEventListener("keydown", e => {
      if (e.key === "Escape") state.lassoActive = false;
    }, { passive: true });

    setInterval(() => {
      const float = document.getElementById("ms-delete-sel-float");
      if (!float) return;

      // Cmd+click (precise) — updateDeleteFloat() manages this; don't interfere
      if (state.tableSelection.size > 0) return;

      // Suppress whenever search is active (has text OR has results)
      const msInput = document.getElementById("ms-input");
      const inSearch = state.results.length > 0 || (msInput && msInput.value.trim().length > 0);
      if (inSearch) { float.style.display = "none"; state.lassoActive = false; return; }

      // Suppress during Atlas "Neighbors of #N" view
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let wn;
      while ((wn = walker.nextNode())) {
        if (wn.parentElement?.closest(OWN_PANELS)) continue;
        if (/^Neighbors of #\d+/.test(wn.textContent.trim())) {
          float.style.display = "none"; state.lassoActive = false; return;
        }
      }

      // If table came back to full count the lasso was cleared
      const rows = tableRowCount();
      const total = baseTotal || Object.keys(state.pathToItem).length;
      if (total > 0 && rows >= total) state.lassoActive = false;

      if (!state.lassoActive) { float.style.display = "none"; return; }
      if (!rows) { float.style.display = "none"; state.lassoActive = false; return; }

      const info = document.getElementById("ms-delete-sel-info");
      const list = document.getElementById("ms-sel-list");
      if (info) info.textContent = `~${rows} in lasso`;
      if (list) list.innerHTML = `<span class="ms-sel-lasso-hint">Cmd+click specific rows to be precise, or delete all ~${rows}</span>`;
      float.style.display = "flex";
    }, 600);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // OBSIDIAN GRAPH MODE — full-screen Canvas 2D scatter with labels + edges
  // ════════════════════════════════════════════════════════════════════════════
  const graph = {
    visible:  false,
    canvas:   null,
    ctx:      null,
    nodes:    [],      // {path,name,type,x,y,cluster_id,cluster_label,neighbors,row_id}
    clusters: [],      // {cluster_id,cluster_label,cx,cy,count}
    vp:       { tx: 0, ty: 0, scale: 1 },   // viewport transform
    drag:     null,    // {startX,startY,origTx,origTy}
    hover:    null,    // node index under cursor
    pinned:   null,    // node index with a pinned (always-shown) tooltip
    selected: new Set(), // selected path strings (cmd+click)
    dataRange: null,   // {xMin,xMax,yMin,yMax,xRange,yRange}
    raf:      null,
    dirty:    true,
    loadPromise: null,
  };

  const GRAPH_NODE_COLORS = {
    image: "#6366f1", video: "#f59e0b", pdf: "#10b981", unknown: "#94a3b8"
  };
  const GRAPH_CLUSTER_COLORS = [
    "#818cf8","#f472b6","#34d399","#fb923c","#38bdf8","#a78bfa",
    "#fbbf24","#4ade80","#f87171","#60a5fa","#e879f9","#2dd4bf",
    "#fb7185","#a3e635","#c084fc","#67e8f9",
  ];

  // Extra graph state (beyond the main graph object)
  const graphThumbCache = new Map(); // path → HTMLImageElement | 'loading' | 'error'
  const graphNavHistory = [];        // [nodeIdx] — back-navigation stack
  let graphSearchFilter = "";        // text typed into the toolbar search box

  function graphToScreen(dx, dy) {
    const r = graph.dataRange;
    if (!r) return { x: 0, y: 0 };
    const nx = (dx - r.xMin) / r.xRange;
    const ny = 1 - (dy - r.yMin) / r.yRange;
    const W  = graph.canvas.width, H = graph.canvas.height;
    const pad = 60;
    return {
      x: graph.vp.tx + (pad + nx * (W - pad * 2)) * graph.vp.scale,
      y: graph.vp.ty + (pad + ny * (H - pad * 2)) * graph.vp.scale,
    };
  }

  function screenToGraph(sx, sy) {
    const r = graph.dataRange;
    if (!r) return { x: 0, y: 0 };
    const W = graph.canvas.width, H = graph.canvas.height;
    const pad = 60;
    const nx = ((sx - graph.vp.tx) / graph.vp.scale - pad) / (W - pad * 2);
    const ny = ((sy - graph.vp.ty) / graph.vp.scale - pad) / (H - pad * 2);
    return { x: r.xMin + nx * r.xRange, y: r.yMin + (1 - ny) * r.yRange };
  }

  function graphNodeRadius() { return Math.max(3.5, Math.min(13, graph.vp.scale * 7)); }

  // Lazy-load thumbnail into an Image for canvas drawImage
  function getGraphThumb(node) {
    if (!node.thumbnail) return null;
    const cached = graphThumbCache.get(node.path);
    if (cached instanceof HTMLImageElement) return cached;
    if (cached === "loading" || cached === "error") return null;
    graphThumbCache.set(node.path, "loading");
    const img = new Image();
    img.onload  = () => { graphThumbCache.set(node.path, img); graph.dirty = true; };
    img.onerror = () => graphThumbCache.set(node.path, "error");
    img.src = node.thumbnail;
    return null;
  }

  // Reusable rounded-rectangle path helper (accepts ctx so it works in minimap too)
  function roundRect(ctx, x, y, w, h, rx) {
    if (ctx.roundRect) {
      ctx.beginPath(); ctx.roundRect(x, y, w, h, rx);
    } else {
      ctx.beginPath();
      ctx.moveTo(x + rx, y);
      ctx.lineTo(x + w - rx, y); ctx.arcTo(x + w, y, x + w, y + rx, rx);
      ctx.lineTo(x + w, y + h - rx); ctx.arcTo(x + w, y + h, x + w - rx, y + h, rx);
      ctx.lineTo(x + rx, y + h); ctx.arcTo(x, y + h, x, y + h - rx, rx);
      ctx.lineTo(x, y + rx); ctx.arcTo(x, y, x + rx, y, rx);
      ctx.closePath();
    }
  }

  function drawGraph() {
    if (!graph.canvas || !graph.ctx) return;
    const ctx = graph.ctx;
    const W = graph.canvas.width, H = graph.canvas.height;
    const r = graphNodeRadius();
    const showLabels = graph.vp.scale > 0.8;
    const showEdges  = graph.nodes.length < 2000;

    // Background
    ctx.fillStyle = "#0d0f1a";
    ctx.fillRect(0, 0, W, H);

    if (!graph.nodes.length) {
      ctx.fillStyle = "#4b5563";
      ctx.font = "16px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Loading graph data…", W / 2, H / 2);
      return;
    }

    const resultPaths = new Set(state.results.map(res => res.path));
    const hasFilter   = graphSearchFilter.length > 0;
    const matchesFilter = n =>
      !hasFilter || n.name.toLowerCase().includes(graphSearchFilter)
        || (n.cluster_label || "").toLowerCase().includes(graphSearchFilter);

    ctx.save();

    // ── Faint background edges ────────────────────────────────────────────
    if (showEdges) {
      ctx.globalAlpha = Math.min(0.18, 0.04 * graph.vp.scale);
      ctx.strokeStyle = "#6366f1";
      ctx.lineWidth   = 0.7;
      ctx.beginPath();
      for (const node of graph.nodes) {
        if (hasFilter && !matchesFilter(node)) continue;
        const s = graphToScreen(node.x, node.y);
        for (const ni of (node.neighbors?.ids?.slice(0, 4) || [])) {
          const nb = graph.nodes[ni];
          if (!nb) continue;
          const e = graphToScreen(nb.x, nb.y);
          ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y);
        }
      }
      ctx.stroke();
    }

    // ── Highlighted edges from the pinned node ────────────────────────────
    const pinnedNode = graph.pinned !== null ? graph.nodes[graph.pinned] : null;
    const pinnedNeighborIds = new Set((pinnedNode?.neighbors?.ids || []).slice(0, 8));
    if (pinnedNode && pinnedNeighborIds.size) {
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = "#fbbf24";
      ctx.lineWidth   = 1.8;
      const ps = graphToScreen(pinnedNode.x, pinnedNode.y);
      ctx.beginPath();
      for (const ni of pinnedNeighborIds) {
        const nb = graph.nodes[ni];
        if (!nb) continue;
        const e = graphToScreen(nb.x, nb.y);
        ctx.moveTo(ps.x, ps.y); ctx.lineTo(e.x, e.y);
      }
      ctx.stroke();
    }

    // ── Nodes ─────────────────────────────────────────────────────────────
    ctx.globalAlpha = 1;
    for (let i = 0; i < graph.nodes.length; i++) {
      const node     = graph.nodes[i];
      const s        = graphToScreen(node.x, node.y);
      const isHover  = graph.hover === i;
      const isSel    = graph.selected.has(node.path);
      const isResult = resultPaths.has(node.path);
      const isPinNb  = pinnedNeighborIds.has(i);
      const isPinned = graph.pinned === i;
      const filtered = hasFilter && !matchesFilter(node);

      let color = GRAPH_CLUSTER_COLORS[node.cluster_id % GRAPH_CLUSTER_COLORS.length] || "#94a3b8";
      if (isResult || isPinNb) color = "#fbbf24";
      if (isSel)               color = "#f43f5e";

      ctx.globalAlpha = filtered ? 0.06 : (isPinNb ? 0.95 : 0.88);
      const nr = isPinned ? r * 2.6 : (isHover || isPinNb) ? r * 1.75 : r;

      // Gold glow for pinned or search-result nodes
      if ((isPinned || (isResult && !filtered)) && !isSel) {
        ctx.save();
        ctx.globalAlpha  = isPinned ? 1 : 0.88;
        ctx.shadowBlur   = isPinned ? 26 : 10;
        ctx.shadowColor  = "#fbbf24";
        ctx.beginPath(); ctx.arc(s.x, s.y, nr, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
        ctx.shadowBlur = 0;
        ctx.restore();
      } else {
        ctx.beginPath(); ctx.arc(s.x, s.y, nr, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
      }

      // Outline ring
      if (isPinned) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth   = 2;
        ctx.beginPath(); ctx.arc(s.x, s.y, nr + 3.5, 0, Math.PI * 2);
        ctx.stroke();
      } else if (!filtered && (isHover || isSel || isPinNb)) {
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = isSel ? "#ff6b8a" : "rgba(255,255,255,0.7)";
        ctx.lineWidth   = 1.5;
        ctx.beginPath(); ctx.arc(s.x, s.y, nr, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // ── Cluster labels ─────────────────────────────────────────────────────
    const allUnclustered = !graph.clusters.some(
      c => c.cluster_label && c.cluster_label !== "unclustered");
    if (!allUnclustered && graph.vp.scale > 0.4) {
      ctx.globalAlpha = Math.min(1, (graph.vp.scale - 0.4) * 3);
      for (const cl of graph.clusters) {
        if (!cl.cluster_label || cl.cluster_label === "unclustered") continue;
        const s = graphToScreen(cl.cx, cl.cy);
        if (s.x < -60 || s.x > W + 60 || s.y < -30 || s.y > H + 30) continue;
        const fontSize = Math.round(Math.max(10, Math.min(15, 13 * graph.vp.scale)));
        ctx.font = `600 ${fontSize}px Inter, sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        const txt = cl.cluster_label;
        const tw  = ctx.measureText(txt).width;
        const hp = 7, vp2 = 4;
        ctx.fillStyle = "rgba(13,15,26,0.82)";
        roundRect(ctx, s.x - tw / 2 - hp, s.y - fontSize / 2 - vp2, tw + hp * 2, fontSize + vp2 * 2, 6);
        ctx.fill();
        ctx.fillStyle = "rgba(203,213,225,0.9)";
        ctx.fillText(txt, s.x, s.y);
      }
      ctx.globalAlpha = 1;
    }

    // ── Hover tooltip (with thumbnail preview) ─────────────────────────────
    // Pinned nodes show the rich DOM popup instead, so only show here for hover≠pinned.
    if (graph.hover !== null && graph.hover !== graph.pinned && graph.nodes[graph.hover]) {
      const node  = graph.nodes[graph.hover];
      const s     = graphToScreen(node.x, node.y);
      const thumb = getGraphThumb(node);
      const fsize = 11.5, lh = 16;
      const line1 = node.name;
      const line2 = [node.type,
        (node.cluster_label && node.cluster_label !== "unclustered") ? node.cluster_label : ""
      ].filter(Boolean).join(" · ");
      const lines = [line1, line2].filter(Boolean);
      const pw     = 190;
      const thumbH = thumb ? 108 : 0;
      const ph     = thumbH + lines.length * lh + 16;
      let tx = s.x + 15, ty = s.y - ph / 2;
      if (tx + pw > W - 8) tx = s.x - pw - 15;
      if (ty < 8) ty = 8;
      if (ty + ph > H - 8) ty = H - ph - 8;

      ctx.fillStyle   = "rgba(15,18,30,0.97)";
      ctx.strokeStyle = "rgba(99,102,241,0.4)";
      ctx.lineWidth   = 1;
      roundRect(ctx, tx, ty, pw, ph, 8);
      ctx.fill(); ctx.stroke();

      let textY = ty + 8;
      if (thumb) {
        ctx.save();
        roundRect(ctx, tx, ty, pw, thumbH, 8);
        ctx.clip();
        ctx.drawImage(thumb, tx, ty, pw, thumbH);
        ctx.restore();
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.fillRect(tx, ty + thumbH, pw, 1);
        textY = ty + thumbH + 8;
      }

      ctx.textAlign = "left"; ctx.textBaseline = "top";
      lines.forEach((l, idx) => {
        ctx.font      = `${idx === 0 ? 500 : 400} ${fsize}px Inter, sans-serif`;
        ctx.fillStyle = idx === 0 ? "#e2e8f0" : "#818cf8";
        ctx.fillText(l.slice(0, 28), tx + 9, textY + idx * lh);
      });
    }

    ctx.restore();

    // ── Minimap (drawn outside the main save/restore) ──────────────────────
    drawMinimap();

    graph.dirty = false;
    updateGraphPopup();
  }

  // ── Corner minimap — full-graph overview + current viewport rect ────────────
  function drawMinimap() {
    if (!graph.canvas || !graph.nodes.length || !graph.dataRange) return;
    const ctx  = graph.ctx;
    const W    = graph.canvas.width, H = graph.canvas.height;
    const dr   = graph.dataRange;
    const pad  = 60;
    const mmW  = 150, mmH = 96, mmX = W - mmW - 14, mmY = H - mmH - 14;
    const pinnedNbSet = new Set(
      (graph.pinned !== null ? graph.nodes[graph.pinned]?.neighbors?.ids || [] : []).slice(0, 8)
    );
    const resultPaths = new Set(state.results.map(r => r.path));

    // Background panel
    ctx.fillStyle   = "rgba(10,12,20,0.84)";
    ctx.strokeStyle = "rgba(99,102,241,0.2)";
    ctx.lineWidth   = 1;
    roundRect(ctx, mmX, mmY, mmW, mmH, 6);
    ctx.fill(); ctx.stroke();

    // Clip to minimap bounds
    ctx.save();
    roundRect(ctx, mmX, mmY, mmW, mmH, 6);
    ctx.clip();

    for (let i = 0; i < graph.nodes.length; i++) {
      const node = graph.nodes[i];
      const nx = (node.x - dr.xMin) / dr.xRange;
      const ny = 1 - (node.y - dr.yMin) / dr.yRange;
      const dx = mmX + nx * mmW;
      const dy = mmY + ny * mmH;
      ctx.fillStyle =
        graph.selected.has(node.path) ? "#f43f5e"
        : graph.pinned === i          ? "#fbbf24"
        : pinnedNbSet.has(i)          ? "#fde68a"
        : resultPaths.has(node.path)  ? "#fbbf24"
        : GRAPH_CLUSTER_COLORS[node.cluster_id % GRAPH_CLUSTER_COLORS.length] || "#6366f1";
      ctx.fillRect(dx - 0.5, dy - 0.5, 1.8, 1.8);
    }

    ctx.restore(); // end minimap clip

    // Viewport indicator rect
    const toNx = sx => ((sx - graph.vp.tx) / graph.vp.scale - pad) / (W - pad * 2);
    const toNy = sy => ((sy - graph.vp.ty) / graph.vp.scale - pad) / (H - pad * 2);
    const rx0 = mmX + Math.max(0, toNx(0)) * mmW;
    const rx1 = mmX + Math.min(1, toNx(W)) * mmW;
    const ry0 = mmY + Math.max(0, toNy(0)) * mmH;
    const ry1 = mmY + Math.min(1, toNy(H)) * mmH;
    if (rx1 > rx0 + 1 && ry1 > ry0 + 1) {
      ctx.strokeStyle = "rgba(251,191,36,0.7)";
      ctx.lineWidth   = 1.5;
      ctx.strokeRect(rx0, ry0, rx1 - rx0, ry1 - ry0);
    }

    // "MAP" label
    ctx.font          = "500 9px Inter, sans-serif";
    ctx.textAlign     = "right";
    ctx.textBaseline  = "bottom";
    ctx.fillStyle     = "rgba(99,102,241,0.35)";
    ctx.fillText("MAP", mmX + mmW - 4, mmY + mmH - 2);
  }

  // ── Rich DOM popup for the pinned node (real thumbnail + action buttons) ──
  function updateGraphPopup() {
    const popup = document.getElementById("ms-graph-popup");
    if (!popup) return;

    if (graph.pinned === null || !graph.nodes[graph.pinned]) {
      popup.style.display = "none";
      popup.dataset.path = "";
      return;
    }

    const node = graph.nodes[graph.pinned];
    popup.style.display = "block";

    if (popup.dataset.path !== node.path) {
      popup.dataset.path = node.path;
      const typeIcon = node.type === "video" ? "🎬" : node.type === "pdf" ? "📄" : "🖼";
      const thumbHtml = node.thumbnail
        ? `<img class="ms-graph-popup-thumb" src="${attr(node.thumbnail)}" />`
        : `<div class="ms-graph-popup-thumb ms-graph-popup-thumb-placeholder">${typeIcon}</div>`;

      const neighborIds = (node.neighbors?.ids || []).slice(0, 10);
      const neighborHtml = neighborIds.length
        ? `
          <div class="ms-graph-popup-neighbors-label">
            Nearby <span class="ms-graph-nb-hint">← → to navigate</span>
          </div>
          <div class="ms-graph-popup-neighbors">
            ${neighborIds.map((nid, nbIdx) => {
              const nb = graph.nodes[nid];
              if (!nb) return "";
              const nbIcon = nb.type === "video" ? "🎬" : nb.type === "pdf" ? "📄" : "🖼";
              return `<div class="ms-graph-popup-neighbor" data-nid="${nid}" title="${attr(nb.path)}">`
                + `<span class="ms-nb-icon">${nbIcon}</span>`
                + `<span class="ms-nb-name">${esc(nb.name)}</span>`
                + `</div>`;
            }).join("")}
          </div>`
        : "";

      // Show match score if this node is a search result
      const matchScore = state.results.find(res => res.path === node.path)?.score;
      const scoreHtml  = matchScore != null
        ? `<span class="ms-graph-popup-score">${Math.round(matchScore * 100)}% match</span>`
        : "";

      const clusterLabel = node.cluster_label && node.cluster_label !== "unclustered"
        ? node.cluster_label : "";

      popup.innerHTML = `
        <button class="ms-graph-popup-close" title="Close (Esc)">✕</button>
        ${thumbHtml}
        <div class="ms-graph-popup-body">
          <div class="ms-graph-popup-name" title="${attr(node.name)}">${esc(node.name)}</div>
          <div class="ms-graph-popup-meta">
            <span class="ms-type-pill ms-type-${esc(node.type)}">${esc(node.type)}</span>
            ${clusterLabel ? `<span class="ms-graph-popup-cluster">${esc(clusterLabel)}</span>` : ""}
            ${scoreHtml}
          </div>
          <div class="ms-card-actions">
            <button class="ms-btn-open" data-act="open">Open</button>
            <button class="ms-btn-reveal" data-act="reveal">Finder</button>
            <button class="ms-btn-delete" data-act="delete">🗑 Delete</button>
          </div>
          ${neighborHtml}
        </div>
      `;
      popup.querySelector(".ms-graph-popup-close").addEventListener("click", () => {
        graph.pinned = null;
        graph.dirty = true;
      });
      popup.querySelector('[data-act="open"]').addEventListener("click", () => openFile(node.path, "open"));
      popup.querySelector('[data-act="reveal"]').addEventListener("click", () => openFile(node.path, "reveal"));
      popup.querySelector('[data-act="delete"]').addEventListener("click", () => openDeleteModal([node.path], [node.name]));
      popup.querySelectorAll(".ms-graph-popup-neighbor").forEach(el => {
        el.addEventListener("click", () => {
          const nid = Number(el.dataset.nid);
          const nb = graph.nodes[nid];
          if (!nb) return;
          graphNavHistory.push(graph.pinned); // remember where we came from
          graph.selected.clear();
          graph.selected.add(nb.path);
          graph.pinned = nid;
          graph.hover = null;
          const delBtn = document.getElementById("ms-graph-del-btn");
          if (delBtn) delBtn.style.display = "inline-flex";
          animateViewportTo(computeCenteredViewport(nb, 3.2));
        });
      });
    }

    const s = graphToScreen(node.x, node.y);
    const W = window.innerWidth, H = window.innerHeight;
    const pw = popup.offsetWidth || 260, ph = popup.offsetHeight || 220;
    let left = s.x + 18, top = s.y - ph / 2;
    if (left + pw > W - 10) left = s.x - pw - 18;
    if (left < 10) left = 10;
    if (top < 10) top = 10;
    if (top + ph > H - 10) top = H - ph - 10;
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  function graphRaf() {
    if (!graph.visible) return;
    if (graph.dirty) drawGraph();
    graph.raf = requestAnimationFrame(graphRaf);
  }

  async function loadGraphData() {
    try {
      // Fetch nodes
      const res = await fetch("/data/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "json",
          sql:  "SELECT row_id, path, name, type, x, y, cluster_id, cluster_label, neighbors, thumbnail FROM dataset ORDER BY row_id",
        }),
      });
      graph.nodes = await res.json();

      // Compute data range for viewport scaling
      const xs = graph.nodes.map(n => n.x), ys = graph.nodes.map(n => n.y);
      const xMin = Math.min(...xs), xMax = Math.max(...xs);
      const yMin = Math.min(...ys), yMax = Math.max(...ys);
      graph.dataRange = { xMin, xMax, yMin, yMax, xRange: xMax - xMin || 1, yRange: yMax - yMin || 1 };

      // Decode neighbors JSON strings
      graph.nodes.forEach(n => {
        if (typeof n.neighbors === "string") {
          try { n.neighbors = JSON.parse(n.neighbors); } catch { n.neighbors = null; }
        }
      });
    } catch(e) { console.warn("Graph: failed to load nodes", e); }

    // Load cluster metadata from server
    try {
      const res = await fetch("/static/cluster_meta.json");
      if (res.ok) graph.clusters = await res.json();
    } catch { }

    // If no cluster_meta.json, derive clusters from node data
    if (!graph.clusters.length && graph.nodes.length) {
      const byCluster = {};
      for (const n of graph.nodes) {
        const cid = n.cluster_id ?? 0;
        if (!byCluster[cid]) byCluster[cid] = { ids: [], xs: [], ys: [], label: n.cluster_label || "" };
        byCluster[cid].xs.push(n.x); byCluster[cid].ys.push(n.y);
      }
      graph.clusters = Object.entries(byCluster).map(([cid, d]) => ({
        cluster_id:    parseInt(cid),
        cluster_label: d.label,
        cx: d.xs.reduce((a, b) => a + b, 0) / d.xs.length,
        cy: d.ys.reduce((a, b) => a + b, 0) / d.ys.length,
        count: d.xs.length,
      }));
    }

    graph.dirty = true;
  }

  function computeCenteredViewport(node, targetScale = 3.2) {
    const r = graph.dataRange;
    const W = graph.canvas.width, H = graph.canvas.height;
    const pad = 60;
    const nx = (node.x - r.xMin) / r.xRange;
    const ny = 1 - (node.y - r.yMin) / r.yRange;
    return {
      tx: W / 2 - (pad + nx * (W - pad * 2)) * targetScale,
      ty: H / 2 - (pad + ny * (H - pad * 2)) * targetScale,
      scale: targetScale,
    };
  }

  function animateViewportTo(target, duration = 650) {
    const start = { ...graph.vp };
    const t0 = performance.now();
    function step(now) {
      const t = Math.min(1, (now - t0) / duration);
      const ease = 1 - Math.pow(1 - t, 3); // easeOutCubic
      graph.vp.tx    = start.tx + (target.tx - start.tx) * ease;
      graph.vp.ty    = start.ty + (target.ty - start.ty) * ease;
      graph.vp.scale = start.scale + (target.scale - start.scale) * ease;
      graph.dirty = true;
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // Opens the graph (if needed), pans+zooms the camera to a node, selects it,
  // and pins its info popup open. Used when a search-result card is clicked.
  async function focusNodeInGraph(path, name) {
    const wasVisible = graph.visible;
    if (!wasVisible) openGraphMode();

    if (!graph.nodes.length) {
      if (!graph.loadPromise) graph.loadPromise = loadGraphData();
      await graph.loadPromise;
    }
    // Give the canvas a tick to size itself when just opened
    if (!wasVisible) await new Promise(r => setTimeout(r, 30));

    const idx = graph.nodes.findIndex(n => n.path === path);
    if (idx === -1) {
      showToast(`Couldn't find "${name || path}" in the graph.`, true);
      return;
    }

    const node = graph.nodes[idx];
    graph.selected.clear();
    graph.selected.add(node.path);
    graph.pinned = idx;
    graph.hover  = null;
    const delBtn = document.getElementById("ms-graph-del-btn");
    if (delBtn) delBtn.style.display = "inline-flex";

    animateViewportTo(computeCenteredViewport(node, 3.2));
  }

  function openGraphMode() {
    if (graph.visible) return;
    graph.visible = true;

    const overlay = document.getElementById("ms-graph-overlay");
    overlay.style.display = "flex";

    const canvas = document.getElementById("ms-graph-canvas");
    graph.canvas = canvas;
    graph.ctx    = canvas.getContext("2d");

    // Size canvas to full window
    const resize = () => {
      canvas.width  = overlay.clientWidth;
      canvas.height = overlay.clientHeight;
      graph.dirty   = true;
    };
    resize();
    window.addEventListener("resize", resize);
    overlay._resizeHandler = resize;

    // Load data if needed (dedupe concurrent loads)
    if (!graph.nodes.length) {
      if (!graph.loadPromise) graph.loadPromise = loadGraphData().then(() => { graph.dirty = true; });
    }

    // Center viewport on first open
    graph.vp = { tx: 0, ty: 0, scale: 1 };

    // Start render loop
    cancelAnimationFrame(graph.raf);
    graphRaf();
  }

  function closeGraphMode() {
    graph.visible = false;
    document.getElementById("ms-graph-overlay").style.display = "none";
    cancelAnimationFrame(graph.raf);
    const overlay = document.getElementById("ms-graph-overlay");
    if (overlay._resizeHandler) {
      window.removeEventListener("resize", overlay._resizeHandler);
      overlay._resizeHandler = null;
    }
    const popup = document.getElementById("ms-graph-popup");
    if (popup) { popup.style.display = "none"; popup.dataset.path = ""; }
  }

  function createGraphOverlay() {
    const el = document.createElement("div");
    el.id = "ms-graph-overlay";
    el.style.display = "none";
    el.innerHTML = `
      <canvas id="ms-graph-canvas"></canvas>
      <div id="ms-graph-toolbar">
        <span id="ms-graph-title">Graph</span>
        <input id="ms-graph-search" type="text" placeholder="Find node… (/ or f)" autocomplete="off" spellcheck="false">
        <button id="ms-graph-zoom-in"  title="Zoom in (+)">＋</button>
        <button id="ms-graph-zoom-out" title="Zoom out (-)">－</button>
        <button id="ms-graph-fit"      title="Fit all">⊙ Fit</button>
        <button id="ms-graph-del-btn" style="display:none">🗑 Delete</button>
        <button id="ms-graph-close">✕ Close</button>
      </div>
      <div id="ms-graph-popup" data-path=""></div>
      <div id="ms-graph-hint">Scroll: pan · Pinch / Ctrl+scroll: zoom · Click: inspect · ⌘+click: select · ↔ navigate · Double-click: open</div>
    `;
    return el;
  }

  function bindGraphEvents() {
    const canvas = document.getElementById("ms-graph-canvas");
    if (!canvas) return;

    // ── Pan: mouse drag ────────────────────────────────────────────────────────
    canvas.addEventListener("mousedown", e => {
      if (e.button !== 0) return;
      graph.drag = { startX: e.clientX, startY: e.clientY, origTx: graph.vp.tx, origTy: graph.vp.ty };
    });
    window.addEventListener("mousemove", e => {
      if (graph.drag) {
        graph.vp.tx = graph.drag.origTx + (e.clientX - graph.drag.startX);
        graph.vp.ty = graph.drag.origTy + (e.clientY - graph.drag.startY);
        graph.dirty = true;
      } else if (graph.visible) {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const hr = graphNodeRadius() * 1.5;
        let found = null;
        for (let i = 0; i < graph.nodes.length; i++) {
          const s = graphToScreen(graph.nodes[i].x, graph.nodes[i].y);
          if (Math.abs(s.x - mx) < hr && Math.abs(s.y - my) < hr) { found = i; break; }
        }
        if (found !== graph.hover) { graph.hover = found; graph.dirty = true; }
        canvas.style.cursor = found !== null ? "pointer" : "grab";
      }
    });
    window.addEventListener("mouseup", () => { graph.drag = null; });

    // ── Zoom / Pan via scroll wheel / trackpad ─────────────────────────────────
    // ctrlKey=true  → pinch-to-zoom (macOS trackpad) or Ctrl+scroll → ZOOM
    // ctrlKey=false → two-finger swipe on trackpad                  → PAN
    canvas.addEventListener("wheel", e => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (e.ctrlKey) {
        // Pinch or Ctrl+scroll → zoom anchored at cursor
        const factor = e.deltaY < 0 ? 1.12 : 0.89;
        graph.vp.tx = mx + (graph.vp.tx - mx) * factor;
        graph.vp.ty = my + (graph.vp.ty - my) * factor;
        graph.vp.scale *= factor;
      } else {
        // Two-finger swipe → pan
        graph.vp.tx -= e.deltaX;
        graph.vp.ty -= e.deltaY;
      }
      graph.dirty = true;
    }, { passive: false });

    // ── Click — select / pin node ──────────────────────────────────────────────
    canvas.addEventListener("click", e => {
      if (graph.drag && (Math.abs(e.clientX - graph.drag.startX) > 4 ||
                         Math.abs(e.clientY - graph.drag.startY) > 4)) return;
      if (graph.hover === null) {
        if (!e.metaKey) {
          graph.selected.clear(); graph.pinned = null; graph.dirty = true;
          const delBtn = document.getElementById("ms-graph-del-btn");
          if (delBtn) delBtn.style.display = "none";
        }
        return;
      }
      const node = graph.nodes[graph.hover];
      if (e.metaKey) {
        if (graph.selected.has(node.path)) graph.selected.delete(node.path);
        else graph.selected.add(node.path);
      } else {
        graph.selected.clear();
        graph.selected.add(node.path);
      }
      graph.pinned = graph.hover;
      const delBtn = document.getElementById("ms-graph-del-btn");
      if (delBtn) delBtn.style.display = graph.selected.size > 0 ? "inline-flex" : "none";
      graph.dirty = true;
    });

    // ── Double-click — open file ───────────────────────────────────────────────
    canvas.addEventListener("dblclick", () => {
      if (graph.hover === null) return;
      const node = graph.nodes[graph.hover];
      fetch("/open-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: node.path }),
      }).catch(() => {});
    });

    // ── Keyboard shortcuts ─────────────────────────────────────────────────────
    window.addEventListener("keydown", e => {
      if (!graph.visible) return;
      const inInput = e.target.matches("input, textarea");

      if (e.key === "Escape") {
        if (inInput) {
          e.target.blur();
          graphSearchFilter = "";
          const gsEl = document.getElementById("ms-graph-search");
          if (gsEl) gsEl.value = "";
          graph.dirty = true;
          return;
        }
        if (graph.pinned !== null) {
          graph.pinned = null; graph.selected.clear(); graph.dirty = true;
          const delBtn = document.getElementById("ms-graph-del-btn");
          if (delBtn) delBtn.style.display = "none";
        } else {
          closeGraphMode();
        }
        return;
      }

      if (inInput) return;

      // / or f → focus search
      if (e.key === "/" || e.key === "f") {
        e.preventDefault();
        document.getElementById("ms-graph-search")?.focus();
        return;
      }

      // ArrowRight / n → navigate to first neighbor of pinned node
      if ((e.key === "ArrowRight" || e.key === "n") && graph.pinned !== null) {
        const node = graph.nodes[graph.pinned];
        const firstNb = node?.neighbors?.ids?.[0];
        if (firstNb != null && graph.nodes[firstNb]) {
          graphNavHistory.push(graph.pinned);
          graph.pinned = firstNb;
          const nb = graph.nodes[firstNb];
          graph.selected.clear(); graph.selected.add(nb.path);
          graph.hover = null;
          animateViewportTo(computeCenteredViewport(nb, 3.2));
          graph.dirty = true;
        }
        return;
      }

      // ArrowLeft / b → go back in nav history
      if ((e.key === "ArrowLeft" || e.key === "b") && graphNavHistory.length > 0) {
        const prevIdx = graphNavHistory.pop();
        graph.pinned  = prevIdx;
        const prev    = graph.nodes[prevIdx];
        graph.selected.clear();
        if (prev) {
          graph.selected.add(prev.path);
          animateViewportTo(computeCenteredViewport(prev, 3.2));
        }
        graph.dirty = true;
        return;
      }

      // + / = → zoom in
      if (e.key === "+" || e.key === "=") {
        const cx = (graph.canvas?.width  || 800) / 2;
        const cy = (graph.canvas?.height || 600) / 2;
        const f = 1.2;
        graph.vp.tx = cx + (graph.vp.tx - cx) * f;
        graph.vp.ty = cy + (graph.vp.ty - cy) * f;
        graph.vp.scale *= f; graph.dirty = true;
      }
      // - → zoom out
      if (e.key === "-") {
        const cx = (graph.canvas?.width  || 800) / 2;
        const cy = (graph.canvas?.height || 600) / 2;
        const f = 0.83;
        graph.vp.tx = cx + (graph.vp.tx - cx) * f;
        graph.vp.ty = cy + (graph.vp.ty - cy) * f;
        graph.vp.scale *= f; graph.dirty = true;
      }
    });

    // ── Graph node search ──────────────────────────────────────────────────────
    document.getElementById("ms-graph-search")?.addEventListener("input", e => {
      graphSearchFilter = e.target.value.trim().toLowerCase();
      graph.dirty = true;
    });

    // ── Toolbar buttons ────────────────────────────────────────────────────────
    document.getElementById("ms-graph-close")?.addEventListener("click", closeGraphMode);
    document.getElementById("ms-graph-zoom-in")?.addEventListener("click", () => {
      const cx = (graph.canvas?.width  || 800) / 2;
      const cy = (graph.canvas?.height || 600) / 2;
      const f = 1.25;
      graph.vp.tx = cx + (graph.vp.tx - cx) * f;
      graph.vp.ty = cy + (graph.vp.ty - cy) * f;
      graph.vp.scale *= f; graph.dirty = true;
    });
    document.getElementById("ms-graph-zoom-out")?.addEventListener("click", () => {
      const cx = (graph.canvas?.width  || 800) / 2;
      const cy = (graph.canvas?.height || 600) / 2;
      const f = 0.8;
      graph.vp.tx = cx + (graph.vp.tx - cx) * f;
      graph.vp.ty = cy + (graph.vp.ty - cy) * f;
      graph.vp.scale *= f; graph.dirty = true;
    });
    document.getElementById("ms-graph-fit")?.addEventListener("click", () => {
      graph.vp = { tx: 0, ty: 0, scale: 1 }; graph.dirty = true;
    });
    document.getElementById("ms-graph-del-btn")?.addEventListener("click", () => {
      if (!graph.selected.size) return;
      const paths = [...graph.selected];
      const names = paths.map(p => graph.nodes.find(n => n.path === p)?.name || p.split("/").pop());
      openDeleteModal(paths, names);
    });
  }

  // Button injected into Atlas toolbar to open Graph mode
  function injectGraphModeBtn() {
    if (document.getElementById("ms-graph-btn")) return;
    const colorSel = atlasColorSelect();
    if (!colorSel) return;
    const colorLabel = colorSel.closest("label");
    const colorPanel = colorLabel?.parentElement;
    if (!colorPanel || colorPanel.closest("#ms-panel")) return;

    const btn = document.createElement("button");
    btn.id        = "ms-graph-btn";
    btn.className = "ms-reset-btn";   // reuse the same pill style
    btn.textContent = "⬡ Graph";
    btn.title     = "Open Obsidian-style graph view";
    btn.style.marginLeft = "4px";
    btn.addEventListener("click", openGraphMode);
    colorPanel.appendChild(btn);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // TWO-FINGER TRACKPAD PAN for Atlas's main WebGL scatter
  // Atlas uses click+drag for panning. We intercept two-finger trackpad swipes
  // ════════════════════════════════════════════════════════════════════════════
  // DOCK SEARCH PANEL INTO ATLAS RIGHT COLUMN
  // Instead of floating #ms-panel as a fixed overlay, we move it into the
  // Atlas right-sidebar slot so it looks like a native part of the UI.
  // Atlas's own chart widgets are cleared; our panel takes their place.
  // ════════════════════════════════════════════════════════════════════════════
  function dockSearchPanel() {
    const OWN = "#ms-panel,#ms-graph-overlay,#ms-index-modal,#ms-delete-modal";
    let atlasColumn = null;

    // Capture a persistent JS reference to the panel element.
    // Even after Atlas wipes atlasColumn.innerHTML the DOM node lives in
    // memory as long as this variable holds it — so we can re-append it.
    const msPanel = document.getElementById("ms-panel");
    if (!msPanel) return;

    const injectPanel = () => {
      if (!atlasColumn) return;
      if (atlasColumn.contains(msPanel)) return; // already there
      atlasColumn.innerHTML = "";
      atlasColumn.style.cssText = "overflow:hidden!important;padding:0!important;";
      atlasColumn.appendChild(msPanel);           // re-attaches detached node
      msPanel.classList.add("ms-panel-docked");
    };

    const tryDock = () => {
      for (const el of document.querySelectorAll("div")) {
        if (el.closest(OWN)) continue;
        const cls = el.className || "";
        if (!cls.includes("overflow-y-scroll") && !cls.includes("overflow-y-auto")) continue;
        const rect = el.getBoundingClientRect();
        if (rect.left > 800 && rect.height > 400 && rect.width > 80) {
          atlasColumn = el;
          injectPanel();

          // Re-inject when Atlas clears/re-renders the column (e.g. sidebar toggle)
          const colObs = new MutationObserver(() => {
            if (!atlasColumn.contains(msPanel)) injectPanel();
          });
          colObs.observe(atlasColumn, { childList: true });

          // Re-dock if Atlas removes and replaces the column element itself
          if (atlasColumn.parentElement) {
            new MutationObserver(() => {
              if (!document.contains(atlasColumn)) {
                colObs.disconnect();
                atlasColumn = null;
                let t = 20;
                const retry = () => { if (tryDock() || --t <= 0) return; setTimeout(retry, 200); };
                retry();
              }
            }).observe(atlasColumn.parentElement, { childList: true });
          }

          return true;
        }
      }
      return false;
    };

    let tries = 35;
    const attempt = () => { if (tryDock() || --tries <= 0) return; setTimeout(attempt, 200); };
    attempt();
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ATLAS TRACKPAD PAN
  // (wheel events with ctrlKey=false) and translate them into synthetic
  // pointer/mouse drag events so Atlas pans naturally.
  // ════════════════════════════════════════════════════════════════════════════
  function injectAtlasTrackpadPan() {
    let panState    = null; // { startX, startY, curX, curY }
    let panEndTimer = null;

    // Return the Atlas WebGL canvas (anything that isn't our graph canvas)
    const getAtlasCanvas = () =>
      [...document.querySelectorAll("canvas")].find(c => c.id !== "ms-graph-canvas");

    document.addEventListener("wheel", e => {
      if (graph.visible) return;  // our graph canvas handles its own wheel
      if (e.ctrlKey) return;      // pinch-to-zoom → let Atlas zoom normally
      // Don't intercept scroll inside any of our own UI panels / modals
      if (e.target?.closest?.(".ms-modal-overlay, #ms-panel, #ms-graph-overlay")) return;

      const canvas = getAtlasCanvas();
      if (!canvas) return;

      // Only act when the pointer is actually over the canvas
      const rect = canvas.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top  || e.clientY > rect.bottom) return;

      e.preventDefault();
      e.stopPropagation();

      const cx = e.clientX, cy = e.clientY;
      const fire = (type, x, y, btn, btns) => {
        const shared = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y };
        canvas.dispatchEvent(new MouseEvent(type.replace("pointer", "mouse"),
          { ...shared, button: btn, buttons: btns }));
        canvas.dispatchEvent(new PointerEvent(type,
          { ...shared, pointerId: 10, pointerType: "mouse",
            button: btn, buttons: btns, isPrimary: true }));
      };

      if (!panState) {
        panState = { startX: cx, startY: cy, curX: cx, curY: cy };
        fire("pointerdown", cx, cy, 0, 1);
      }

      // Invert scroll delta so swiping right → canvas moves right
      const nx = panState.curX - e.deltaX * 0.7;
      const ny = panState.curY - e.deltaY * 0.7;
      panState.curX = nx; panState.curY = ny;
      fire("pointermove", nx, ny, 0, 1);

      // Release the virtual drag after scroll stops
      clearTimeout(panEndTimer);
      panEndTimer = setTimeout(() => {
        if (panState) {
          fire("pointerup", panState.curX, panState.curY, 0, 0);
          panState = null;
        }
      }, 80);
    }, { passive: false, capture: true });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // EVENTS
  // ════════════════════════════════════════════════════════════════════════════
  function bindEvents() {
    const input       = document.getElementById("ms-input");
    const searchBtn   = document.getElementById("ms-search-btn");
    const typeFilter  = document.getElementById("ms-type-filter");
    const collapseBtn = document.getElementById("ms-collapse-btn");
    const body        = document.getElementById("ms-body");
    const panel       = document.getElementById("ms-panel");

    const doSearch = () => {
      const q = input?.value.trim() || "";
      if (q) runSearch(q, typeFilter?.value || "");
    };

    input?.addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
    searchBtn?.addEventListener("click", doSearch);

    collapseBtn?.addEventListener("click", () => {
      state.collapsed = !state.collapsed;
      if (body) body.style.display = state.collapsed ? "none" : "flex";
      collapseBtn.textContent = state.collapsed ? "+" : "−";
      panel?.classList.toggle("ms-collapsed", state.collapsed);
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════════════════════════════════
  whenReady(() => {
    document.body.appendChild(createPanel());
    document.body.appendChild(createClearFloat());
    document.body.appendChild(createIndexFab());
    document.body.appendChild(createDeleteModal());
    document.body.appendChild(createIndexModal());

    // Re-bind modal button listeners after appendChild
    document.getElementById("ms-delete-cancel-x")?.addEventListener("click", closeDeleteModal);
    document.getElementById("ms-delete-cancel")?.addEventListener("click", closeDeleteModal);
    document.getElementById("ms-delete-confirm")?.addEventListener("click", () => {
      const checked = document.querySelector('input[name="ms-delete-mode"]:checked');
      executeDelete(checked?.value === "disk");
    });
    document.getElementById("ms-index-close")?.addEventListener("click", closeIndexModal);

    bindEvents();
    renderStatus();
    renderResults();
    loadAllCoords();
    watchAtlasTooltip();
    watchAtlasTable();

    // Delete Selected float — precise cmd+click selection + lasso fallback
    document.body.appendChild(createDeleteSelectionFloat());
    document.getElementById("ms-delete-sel-btn")?.addEventListener("click", deleteSelection);
    document.getElementById("ms-delete-sel-clear")?.addEventListener("click", clearTableSelection);
    watchAtlasSelection();
    watchAtlasInspector();

    // Reset View + Graph mode buttons — poll until Atlas Color panel renders
    const resetPoll = setInterval(() => {
      injectAtlasResetBtn();
      injectGraphModeBtn();
      if (document.getElementById("ms-reset-btn") && document.getElementById("ms-graph-btn")) {
        clearInterval(resetPoll);
      }
    }, 500);

    // Graph overlay
    document.body.appendChild(createGraphOverlay());
    bindGraphEvents();
    injectAtlasTrackpadPan();

    // Prevent Atlas (and the trackpad-pan handler) from swallowing wheel events
    // that are meant to scroll content inside our panel.
    document.getElementById("ms-panel")?.addEventListener("wheel", e => {
      // Walk up from the event target to find the first scrollable ancestor
      // that actually has overflow to scroll in the wheel direction.
      let el = e.target;
      while (el && el !== document.body) {
        const style = window.getComputedStyle(el);
        const canScrollY = (style.overflowY === "auto" || style.overflowY === "scroll");
        const canScrollX = (style.overflowX === "auto" || style.overflowX === "scroll");
        if (canScrollY && el.scrollHeight > el.clientHeight) {
          // This element can scroll vertically — let it, block Atlas
          e.stopPropagation();
          return;
        }
        if (canScrollX && el.scrollWidth > el.clientWidth) {
          e.stopPropagation();
          return;
        }
        el = el.parentElement;
      }
      // Nothing scrollable found — still stop propagation so Atlas doesn't pan
      // when the user is hovering over our panel.
      e.stopPropagation();
    }, { passive: true });

    // Move search panel into the Atlas right-column slot so it's part of the layout
    dockSearchPanel();

  });
})();

