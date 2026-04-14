"use strict";

/* =====================================================================
 * popup.js — Folder Jump palette
 *
 * Lifecycle:
 *   1. Request context from background (folders, mode, pinned IDs)
 *   2. Render list; user types to filter
 *   3. Enter / click → executeAction → close
 *   4. ★ button → togglePin → refresh ★ state in list
 * ===================================================================== */

let allFolders   = [];   // [{id, name, displayPath}]
let pinnedIds    = new Set();
let recentIds    = [];   // MRU order, newest first
let filtered     = [];
let selIdx       = 0;
let mode         = "jump";

// ── Boot ───────────────────────────────────────────────────────────────
(async () => {
  let ctx = null;
  try {
    ctx = await browser.runtime.sendMessage({ action: "getContext" });
  } catch (_) {}

  if (!ctx) {
    document.getElementById("mode-label").textContent = "No context — re-open via shortcut";
    return;
  }

  mode        = ctx.mode;
  allFolders  = ctx.folders ?? [];
  pinnedIds   = new Set(ctx.pinnedIds ?? []);
  recentIds   = ctx.recentIds ?? [];
  filtered    = defaultOrder();

  document.getElementById("mode-label").textContent =
    mode === "move" ? "Move to folder" : "Jump to folder";

  renderList();

  const input = document.getElementById("search");
  input.addEventListener("input",   onSearch);
  input.addEventListener("keydown", onKeydown);
  input.focus();
})();

// ── Search ─────────────────────────────────────────────────────────────
function onSearch() {
  const q = document.getElementById("search").value;
  if (!q) {
    filtered = defaultOrder();
  } else {
    const scored = [];
    for (const f of allFolders) {
      const r = fuzzyScore(q, f.displayPath);
      if (r) { scored.push({ f, score: r.score, hits: r.hits }); }
    }
    scored.sort((a, b) => b.score - a.score ||
      a.f.displayPath.length - b.f.displayPath.length ||
      a.f.displayPath.localeCompare(b.f.displayPath));
    filtered = scored.map(s => s.f);
  }
  selIdx = 0;
  renderList();
}

// Empty-query ordering: MRU folders first (in recency order), then the rest alphabetically.
function defaultOrder() {
  const byId = new Map(allFolders.map(f => [f.id, f]));
  const seen = new Set();
  const recents = [];
  for (const id of recentIds) {
    const f = byId.get(id);
    if (f) { recents.push(f); seen.add(id); }
  }
  const rest = allFolders.filter(f => !seen.has(f.id));
  return recents.concat(rest);
}

// Score a single match position. Bonuses for start-of-string / word boundary.
function charBonus(haystack, j) {
  if (j === 0) { return 10; }
  const prev = haystack[j - 1];
  if (prev === "/" || prev === " " || prev === "-" || prev === "_" || prev === ".") { return 10; }
  const c = haystack[j];
  if (prev === prev.toLowerCase() && prev !== prev.toUpperCase() &&
      c === c.toUpperCase() && c !== c.toLowerCase()) { return 5; } // camelCase
  return 0;
}

// DP fuzzy scorer. Returns {score, hits} or null. Rewards contiguous runs
// and word-boundary starts; penalises gaps.
function fuzzyScore(needle, haystack) {
  const n = needle.toLowerCase();
  const hLower = haystack.toLowerCase();
  const N = n.length, H = hLower.length;
  if (N === 0) { return { score: 0, hits: [] }; }
  if (N > H) { return null; }

  const NEG = -Infinity;
  const parents = [];           // parents[i][j] = previous haystack index
  let prev = new Array(H).fill(NEG);

  // i = 0
  const par0 = new Array(H).fill(-1);
  for (let j = 0; j < H; j++) {
    if (hLower[j] === n[0]) {
      prev[j] = 1 + charBonus(haystack, j);
    }
  }
  parents.push(par0);

  for (let i = 1; i < N; i++) {
    const cur = new Array(H).fill(NEG);
    const par = new Array(H).fill(-1);
    let bestPrev = NEG, bestPrevJ = -1;

    for (let j = 0; j < H; j++) {
      // Update running max of prev[0..j-1] so we know the best non-adjacent predecessor.
      if (j > 0 && prev[j - 1] > bestPrev) {
        bestPrev = prev[j - 1];
        bestPrevJ = j - 1;
      }
      if (hLower[j] !== n[i]) { continue; }

      let best = NEG, bestPar = -1;

      // Option A — contiguous with j-1 (big bonus)
      if (j > 0 && prev[j - 1] > NEG) {
        const s = prev[j - 1] + 1 + charBonus(haystack, j) + 15;
        if (s > best) { best = s; bestPar = j - 1; }
      }
      // Option B — gap to best earlier match (penalise distance)
      if (bestPrev > NEG && bestPrevJ !== j - 1) {
        const gap = j - bestPrevJ - 1;
        const s = bestPrev + 1 + charBonus(haystack, j) - gap;
        if (s > best) { best = s; bestPar = bestPrevJ; }
      }
      cur[j] = best;
      par[j] = bestPar;
    }
    prev = cur;
    parents.push(par);
  }

  // Pick best ending position
  let bestJ = -1, bestScore = NEG;
  for (let j = 0; j < H; j++) {
    if (prev[j] > bestScore) { bestScore = prev[j]; bestJ = j; }
  }
  if (bestJ === -1) { return null; }

  // Reconstruct hit indices
  const hits = new Array(N);
  let j = bestJ;
  for (let i = N - 1; i >= 0; i--) {
    hits[i] = j;
    j = parents[i][j];
  }

  // Basename boost: reward matches landing in the last path segment.
  // Per-hit bonus plus a big extra when ALL hits are in the basename.
  const lastSlash = haystack.lastIndexOf("/");
  if (lastSlash >= 0) {
    let inBase = 0;
    for (const hi of hits) { if (hi > lastSlash) { inBase++; } }
    bestScore += inBase * 8;
    if (inBase === hits.length) { bestScore += 40; }
  } else {
    bestScore += hits.length * 8 + 40; // no path separator → whole string is basename
  }

  return { score: bestScore, hits };
}

// Kept for highlight() — returns just the hit array or null.
function fuzzyMatch(needle, haystack) {
  if (!needle) { return []; }
  const r = fuzzyScore(needle, haystack);
  return r ? r.hits : null;
}

// ── Keyboard ───────────────────────────────────────────────────────────
function onKeydown(e) {
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      selIdx = Math.min(selIdx + 1, filtered.length - 1);
      renderList();
      break;
    case "ArrowUp":
      e.preventDefault();
      selIdx = Math.max(selIdx - 1, 0);
      renderList();
      break;
    case "Enter":
      e.preventDefault();
      if (filtered[selIdx]) { selectFolder(filtered[selIdx]); }
      break;
    case "Escape":
      if (document.getElementById("search").value) {
        document.getElementById("search").value = "";
        onSearch();
      } else {
        window.close();
      }
      break;
  }
}

// ── Render ─────────────────────────────────────────────────────────────
function renderList() {
  const list = document.getElementById("folder-list");
  const needle = document.getElementById("search").value;

  if (filtered.length === 0) {
    list.innerHTML = '<li class="empty-msg">No folders match</li>';
    return;
  }

  list.innerHTML = "";
  const frag = document.createDocumentFragment();

  const recentSet = !needle ? new Set(recentIds) : null;
  for (let i = 0; i < filtered.length; i++) {
    const f   = filtered[i];
    const li  = document.createElement("li");
    const cls = [];
    if (i === selIdx) { cls.push("selected"); }
    if (recentSet && recentSet.has(f.id)) { cls.push("recent"); }
    if (cls.length) { li.className = cls.join(" "); }
    li.setAttribute("role", "option");

    // Path span with highlighted chars
    const span = document.createElement("span");
    span.className = "folder-path";
    span.innerHTML = highlight(f.displayPath, needle);
    li.appendChild(span);

    // Pin star button
    const pinBtn = document.createElement("button");
    pinBtn.className = "pin-btn" + (pinnedIds.has(f.id) ? " pinned" : "");
    pinBtn.title = pinnedIds.has(f.id) ? "Unpin folder" : "Pin folder to bar";
    pinBtn.textContent = "★";
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePin(f);
    });
    li.appendChild(pinBtn);

    // Click on row → select (but not the pin button)
    li.addEventListener("click", (e) => {
      if (!e.target.classList.contains("pin-btn")) {
        selIdx = i;
        selectFolder(f);
      }
    });

    frag.appendChild(li);
  }

  list.appendChild(frag);

  // Scroll selected into view
  const sel = list.querySelector(".selected");
  if (sel) { sel.scrollIntoView({ block: "nearest" }); }
}

// Build HTML string with <mark> around fuzzy-matched characters
function highlight(path, needle) {
  if (!needle) { return escHtml(path); }
  const hits = fuzzyMatch(needle, path);
  if (!hits || hits.length === 0) { return escHtml(path); }
  const hitSet = new Set(hits);
  return path.split("").map((ch, i) =>
    hitSet.has(i) ? `<mark>${escHtml(ch)}</mark>` : escHtml(ch)
  ).join("");
}

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Actions ────────────────────────────────────────────────────────────
async function selectFolder(folder) {
  try {
    await browser.runtime.sendMessage({ action: "executeAction", folderId: folder.id });
  } catch (_) {}
  window.close();
}

async function togglePin(folder) {
  try {
    const resp = await browser.runtime.sendMessage({
      action: "togglePin",
      folder: { id: folder.id, name: folder.name, displayPath: folder.displayPath }
    });
    if (resp?.pinnedIds) {
      pinnedIds = new Set(resp.pinnedIds);
      renderList(); // refresh ★ state in-place without re-filtering
    }
  } catch (_) {}
}
