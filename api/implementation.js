"use strict";

/* =====================================================================
 * WebExtension Experiment — folderjump
 *
 * Runs in Thunderbird's privileged (parent) process.
 * Injects the pinned-folder bar into every open mail:3pane window
 * and fires extension events back to background.js.
 *
 * Requires Thunderbird 115+.
 * ===================================================================== */

/* globals ExtensionAPI, ExtensionCommon, Services */

const BAR_ID = "folderjump-bar";
const MENU_ID = "folderjump-ctx";

this.folderjump = class extends ExtensionAPI {
  // ── Lifecycle ───────────────────────────────────────────────────────

  onStartup() {
    // Nothing needed here; bar is created on first updateBar() call.
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown) { return; }
    // Remove bar and context menu from every open 3-pane window.
    for (const win of Services.wm.getEnumerator("mail:3pane")) {
      _cleanup(win.document);
    }
  }

  getAPI(context) {
    const clickListeners = new Set();
    const dropListeners  = new Set();
    const unpinListeners = new Set();

    // Persist latest folder list so new windows can be populated.
    let _lastFolders = [];

    // ── Window observer — inject bar into newly opened windows ────────
    const windowObserver = {
      observe(subject, topic) {
        if (topic !== "domwindowopened") { return; }
        const win = (subject && typeof subject.QueryInterface === "function")
          ? subject.QueryInterface(Ci.nsIDOMWindow)
          : subject;
        if (!win || !win.addEventListener) { return; }
        win.addEventListener("load", () => {
          if (win.document.documentElement.getAttribute("windowtype") === "mail:3pane") {
            _injectBar(win.document, _lastFolders, clickListeners, dropListeners, unpinListeners);
          }
        }, { once: true });
      }
    };
    Services.ww.registerNotification(windowObserver);
    context.callOnClose({
      close() {
        Services.ww.unregisterNotification(windowObserver);
      }
    });

    return {
      folderjump: {

        // ── updateBar(folders) ───────────────────────────────────────
        async updateBar(folders) {
          _lastFolders = folders;
          for (const win of Services.wm.getEnumerator("mail:3pane")) {
            _injectBar(win.document, folders, clickListeners, dropListeners, unpinListeners);
          }
        },

        // ── Events ───────────────────────────────────────────────────
        onFolderClicked: new ExtensionCommon.EventManager({
          context,
          name: "folderjump.onFolderClicked",
          register(fire) {
            const fn = id => fire.async(id);
            clickListeners.add(fn);
            return () => clickListeners.delete(fn);
          }
        }).api(),

        onFolderDropped: new ExtensionCommon.EventManager({
          context,
          name: "folderjump.onFolderDropped",
          register(fire) {
            const fn = id => fire.async(id);
            dropListeners.add(fn);
            return () => dropListeners.delete(fn);
          }
        }).api(),

        onFolderUnpinRequested: new ExtensionCommon.EventManager({
          context,
          name: "folderjump.onFolderUnpinRequested",
          register(fire) {
            const fn = id => fire.async(id);
            unpinListeners.add(fn);
            return () => unpinListeners.delete(fn);
          }
        }).api()
      }
    };
  }
};

// ── DOM helpers ─────────────────────────────────────────────────────────

function _cleanup(doc) {
  doc.getElementById(BAR_ID)?.remove();
  doc.getElementById(MENU_ID)?.remove();
}

function _injectBar(doc, folders, clickListeners, dropListeners, unpinListeners) {
  _cleanup(doc);

  // ── Shared context menu ───────────────────────────────────────────
  const ctxMenu = _el(doc, "div", { id: MENU_ID });
  Object.assign(ctxMenu.style, {
    position: "fixed",
    zIndex:   "100000",
    background: "#252526",
    border:   "1px solid #454545",
    borderRadius: "4px",
    padding:  "4px 0",
    minWidth: "140px",
    boxShadow: "0 4px 12px rgba(0,0,0,.5)",
    display:  "none",
    fontFamily: "'Segoe UI', sans-serif",
    fontSize: "12px",
    color:    "#cccccc"
  });

  const ctxRemove = _el(doc, "div");
  ctxRemove.textContent = "Remove from bar";
  Object.assign(ctxRemove.style, {
    padding: "5px 12px",
    cursor:  "pointer"
  });
  ctxRemove.onmouseenter = () => { ctxRemove.style.background = "#094771"; };
  ctxRemove.onmouseleave = () => { ctxRemove.style.background = ""; };
  ctxMenu.appendChild(ctxRemove);
  doc.body.appendChild(ctxMenu);

  let ctxTargetId = null;
  ctxRemove.addEventListener("click", () => {
    ctxMenu.style.display = "none";
    if (ctxTargetId) {
      for (const fn of unpinListeners) { fn(ctxTargetId); }
      ctxTargetId = null;
    }
  });
  doc.addEventListener("click", () => { ctxMenu.style.display = "none"; }, true);

  // ── Bar shell ─────────────────────────────────────────────────────
  const bar = _el(doc, "div", { id: BAR_ID });
  Object.assign(bar.style, {
    display:     "flex",
    alignItems:  "center",
    gap:         "4px",
    padding:     "0 8px",
    height:      "30px",
    background:   "#1e1e1e",
    borderBottom: "1px solid #007acc",
    position:     "fixed",
    top:          "0",
    left:         "0",
    right:        "0",
    zIndex:      "9999",
    fontFamily:  "'Segoe UI', Tahoma, sans-serif",
    fontSize:    "12px",
    flexShrink:  "0",
    boxSizing:   "border-box",
    userSelect:  "none"
  });

  // Label
  const label = _el(doc, "span");
  label.textContent = "📁";
  Object.assign(label.style, {
    color:       "#666",
    marginRight: "4px",
    flexShrink:  "0"
  });
  bar.appendChild(label);

  if (!folders || folders.length === 0) {
    const hint = _el(doc, "span");
    hint.textContent = "No pinned folders — pin one with ★ in the palette";
    hint.style.color = "#555";
    hint.style.fontStyle = "italic";
    bar.appendChild(hint);
  }

  for (const folder of (folders || [])) {
    const btn = _el(doc, "button");
    btn.textContent = folder.name;
    btn.title = folder.displayPath;
    Object.assign(btn.style, {
      background:   "#2d2d2d",
      color:        "#cccccc",
      border:       "1px solid #3c3c3c",
      borderRadius: "3px",
      padding:      "2px 9px",
      cursor:       "pointer",
      fontSize:     "12px",
      fontFamily:   "inherit",
      whiteSpace:   "nowrap",
      transition:   "background .1s, border-color .1s"
    });

    btn.addEventListener("mouseenter", () => {
      btn.style.background   = "#094771";
      btn.style.borderColor  = "#007acc";
      btn.style.color        = "#fff";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background  = btn.dataset.dragOver === "1" ? "#388a34" : "#2d2d2d";
      btn.style.borderColor = "#3c3c3c";
      btn.style.color       = "#cccccc";
    });

    // Click → jump
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      for (const fn of clickListeners) { fn(folder.id); }
    });

    // Right-click → context menu
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctxTargetId = folder.id;
      ctxMenu.style.display = "block";
      ctxMenu.style.left    = e.clientX + "px";
      ctxMenu.style.top     = (e.clientY + 4) + "px";
    });

    // Drag-over highlight
    btn.addEventListener("dragenter", (e) => {
      e.preventDefault();
      btn.dataset.dragOver  = "1";
      btn.style.background  = "#388a34";
      btn.style.borderColor = "#388a34";
      btn.style.color       = "#fff";
    });
    btn.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    btn.addEventListener("dragleave", () => {
      btn.dataset.dragOver  = "0";
      btn.style.background  = "#2d2d2d";
      btn.style.borderColor = "#3c3c3c";
      btn.style.color       = "#cccccc";
    });
    btn.addEventListener("drop", (e) => {
      e.preventDefault();
      btn.dataset.dragOver  = "0";
      btn.style.background  = "#2d2d2d";
      btn.style.borderColor = "#3c3c3c";
      btn.style.color       = "#cccccc";
      for (const fn of dropListeners) { fn(folder.id); }
    });

    bar.appendChild(btn);
  }

  // Insert bar at the top of the window (before the tab strip if found).
  const anchor = doc.getElementById("tabmail-tabbox")
               || doc.getElementById("messengerBody")
               || doc.querySelector("[id$='TabBox']")
               || null;
  if (anchor && anchor.parentNode) {
    anchor.parentNode.insertBefore(bar, anchor);
  } else if (doc.body.firstChild) {
    doc.body.insertBefore(bar, doc.body.firstChild);
  } else {
    doc.body.appendChild(bar);
  }
}

function _el(doc, tag, attrs) {
  const el = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) { el.setAttribute(k, v); }
  }
  return el;
}
