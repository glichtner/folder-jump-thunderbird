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
    for (const win of Services.wm.getEnumerator("mail:3pane")) {
      _cleanup(win.document);
      // Also clean bars inside any loaded about3Pane docs.
      const tabmail = win.document.getElementById("tabmail");
      for (const tab of (tabmail?.tabInfo || [])) {
        const b = tab.browser || tab.linkedBrowser;
        const innerDoc = b?.contentDocument;
        if (innerDoc?.URL?.includes("about3Pane")) { _cleanup(innerDoc); }
      }
      tabmail?.removeAttribute?.("data-folderjump-hooked");
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

// Entry point — refresh the bar in every relevant document inside `outerDoc`
// (the messenger.xhtml chrome window). Tries to dock the bar above the
// thread pane in each about3Pane; falls back to a fixed-top bar.
function _injectBar(outerDoc, folders, clickListeners, dropListeners, unpinListeners, _retries) {
  _cleanup(outerDoc);

  const targets = _findThreadPaneTargets(outerDoc);

  if (targets.length === 0) {
    const tries = _retries || 0;
    if (tries < 6) {
      // about3Pane probably still loading — retry shortly.
      const win = outerDoc.defaultView;
      win.setTimeout(() => {
        _injectBar(outerDoc, folders, clickListeners, dropListeners, unpinListeners, tries + 1);
      }, 500);
    } else {
      _log("giving up after retries; using top-fixed fallback");
      _renderBarInDoc(outerDoc, null, folders, clickListeners, dropListeners, unpinListeners, /*fixedTop=*/true);
    }
  } else {
    for (const t of targets) {
      _renderBarInDoc(t.doc, t.beforeNode, folders, clickListeners, dropListeners, unpinListeners, /*fixedTop=*/false);
    }
  }

  _attachTabListeners(outerDoc, () => folders, { clickListeners, dropListeners, unpinListeners });
}

// Walk the tabmail and collect every loaded about3Pane document plus the
// node we want to insert the bar in front of (the thread pane).
function _findThreadPaneTargets(outerDoc) {
  const out = [];
  // TB 115+: each mail tab is hosted in <browser id="mail3PaneTabBrowserN">
  // whose contentDocument is the about3Pane.xhtml document.
  const mailBrowsers = outerDoc.querySelectorAll('browser[id^="mail3PaneTabBrowser"]');
  _log("mail3Pane browsers:", mailBrowsers.length);

  for (const b of mailBrowsers) {
    const innerDoc = b.contentDocument;
    const url = innerDoc?.URL ?? "(null)";
    const ready = innerDoc?.readyState ?? "(n/a)";
    _log(b.id, "url:", url, "readyState:", ready);

    if (!innerDoc || !innerDoc.URL || !innerDoc.URL.includes("about3Pane")) { continue; }

    const anchor =
         innerDoc.getElementById("threadPane")
      || innerDoc.getElementById("threadPaneBrowser")
      || innerDoc.getElementById("threadPaneHeader")
      || innerDoc.getElementById("threadTree")
      || innerDoc.getElementById("messagePaneSplitter")
      || innerDoc.body?.firstChild
      || null;

    if (!anchor) {
      // Dump inner ids so we can pick a real anchor next round.
      const ids = [];
      for (const el of innerDoc.querySelectorAll("[id]")) {
        if (/thread|pane|message/i.test(el.id)) { ids.push(el.id); }
      }
      _log("  inner candidate ids:", ids.join(", ") || "(none)");
    } else {
      _log("  inner anchor:", anchor.id ? "#" + anchor.id : anchor.tagName);
    }

    if (anchor && anchor.parentNode) {
      out.push({ doc: innerDoc, beforeNode: anchor });
    } else if (innerDoc.body) {
      out.push({ doc: innerDoc, beforeNode: innerDoc.body.firstChild });
    }
  }
  return out;
}

function _log(...args) {
  try { Services.console.logStringMessage("[FolderJump] " + args.map(String).join(" ")); } catch (_) {}
}

// Hook tab open/select events so newly-loaded about3Panes also get the bar.
function _attachTabListeners(outerDoc, getFolders, listeners) {
  const tabmail = outerDoc.getElementById("tabmail");
  if (!tabmail || tabmail.dataset.folderjumpHooked === "1") { return; }
  tabmail.dataset.folderjumpHooked = "1";

  const refresh = () => {
    const win = outerDoc.defaultView;
    win.setTimeout(() => {
      _injectBar(outerDoc, getFolders(),
        listeners.clickListeners, listeners.dropListeners, listeners.unpinListeners);
    }, 150);
  };
  tabmail.addEventListener("TabOpen",   refresh);
  tabmail.addEventListener("TabSelect", refresh);
}

// Build and insert the bar inside `doc`. If `beforeNode` is given, the bar
// is inserted in normal flow before it. If null and `fixedTop` is true, the
// bar is fixed-positioned at the top of the document.
function _renderBarInDoc(doc, beforeNode, folders, clickListeners, dropListeners, unpinListeners, fixedTop) {
  // Clean any stale bar already in this doc.
  doc.getElementById(BAR_ID)?.remove();
  doc.getElementById(MENU_ID)?.remove();

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
    display:      "flex",
    alignItems:   "center",
    gap:          "4px",
    padding:      "4px 8px",
    minHeight:    "30px",
    background:   "#1e1e1e",
    borderBottom: "1px solid #007acc",
    fontFamily:   "'Segoe UI', Tahoma, sans-serif",
    fontSize:     "12px",
    flexShrink:   "0",
    boxSizing:    "border-box",
    userSelect:   "none",
    overflow:     "hidden"
  });
  if (fixedTop) {
    Object.assign(bar.style, {
      position: "fixed",
      top:      "0",
      left:     "0",
      right:    "0",
      zIndex:   "9999"
    });
  }

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

  // Insert.
  if (beforeNode && beforeNode.parentNode) {
    beforeNode.parentNode.insertBefore(bar, beforeNode);
  } else if (doc.body && doc.body.firstChild) {
    doc.body.insertBefore(bar, doc.body.firstChild);
  } else if (doc.body) {
    doc.body.appendChild(bar);
  } else {
    doc.documentElement.appendChild(bar);
  }
}

function _el(doc, tag, attrs) {
  const el = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) { el.setAttribute(k, v); }
  }
  return el;
}
