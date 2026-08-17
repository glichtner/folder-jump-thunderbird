"use strict";

/* =====================================================================
 * background.js — Folder Jump
 *
 * Coordinates keyboard commands, the palette popup, and the pinned bar.
 * All folder references use MailFolderId strings (the `id` property on
 * MailFolder objects returned by browser.accounts.list(true)).
 * ===================================================================== */

// ── State ──────────────────────────────────────────────────────────────
// Holds context for the popup while it is open. Each palette session gets a
// token so a stale popup can never execute against a newer (or cleared)
// context.
let pendingCtx = null;
let paletteWindowId = null;
let ctxToken = 0;

// ── Init ───────────────────────────────────────────────────────────────
(async () => {
  const { pinnedFolders = [] } = await browser.storage.local.get("pinnedFolders");
  await browser.folderjump.updateBar(pinnedFolders);
})();

// ── Keyboard commands ──────────────────────────────────────────────────
browser.commands.onCommand.addListener(async (command) => {
  console.log("[FolderJump] command fired:", command);
  if (command !== "move-to-folder" && command !== "jump-to-folder") { return; }
  const mode = command === "move-to-folder" ? "move" : "jump";
  try {
    await openPalette(mode);
  } catch (err) {
    console.error("[FolderJump] openPalette failed:", err);
  }
});

// ── Move history (for Ctrl+Z undo) ─────────────────────────────────────
// Listen to every move (whether triggered by us or by Thunderbird's UI)
// and keep a stack of recent ones. Undo pops the top and moves the
// affected messages back to their previous folder.
//
// The Ctrl+Z key itself is intercepted by the experiment
// (api/implementation.js) rather than via the `commands` API: a command
// shortcut is global and would also swallow Ctrl+Z in the composer and in
// text fields. The experiment only fires onUndoRequested when a mail tab of
// the main window has focus outside an editable element — and only while we
// have something to undo (see syncUndoAvailable), so Thunderbird's own undo
// keeps working the rest of the time.
const MAX_HISTORY = 25;
const moveHistory = [];

// Message ids we handed to messages.move() as part of an undo. The onMoved
// event that results from it must not be recorded as a new history entry,
// otherwise a second Ctrl+Z would just redo the move instead of undoing the
// one before it.
const undoMovedIds = new Set();
const UNDO_ID_TTL_MS = 60000;

function syncUndoAvailable() {
  browser.folderjump.setUndoAvailable(moveHistory.length > 0)
    .catch(err => console.warn("[FolderJump] setUndoAvailable failed:", err));
}

browser.messages.onMoved.addListener((originals, moveds) => {
  const orig = originals?.messages ?? [];
  const moved = moveds?.messages ?? [];
  if (!orig.length || !moved.length) { return; }
  if (orig.every(m => undoMovedIds.has(m.id))) {
    for (const m of orig) { undoMovedIds.delete(m.id); }
    return;
  }
  const fromFolder = orig[0].folder;
  if (!fromFolder) { return; }
  moveHistory.push({
    fromFolder: {
      id:        fromFolder.id,
      accountId: fromFolder.accountId,
      path:      fromFolder.path
    },
    newIds: moved.map(m => m.id)
  });
  while (moveHistory.length > MAX_HISTORY) { moveHistory.shift(); }
  syncUndoAvailable();
});

async function undoLastMove() {
  const last = moveHistory.pop();
  syncUndoAvailable();
  if (!last) { console.log("[FolderJump] undo: history empty"); return; }
  const dest = last.fromFolder.id
    ?? { accountId: last.fromFolder.accountId, path: last.fromFolder.path };
  for (const id of last.newIds) { undoMovedIds.add(id); }
  // Drop the marker eventually in case onMoved never fires for these ids.
  setTimeout(() => { for (const id of last.newIds) { undoMovedIds.delete(id); } }, UNDO_ID_TTL_MS);
  try {
    await browser.messages.move(last.newIds, dest);
  } catch (err) {
    console.error("[FolderJump] undo failed:", err);
    for (const id of last.newIds) { undoMovedIds.delete(id); }
  }
}

browser.folderjump.onUndoRequested.addListener(undoLastMove);

async function openPalette(mode) {
  console.log("[FolderJump] openPalette start, mode =", mode);

  const [mailTab] = await browser.mailTabs.query({ active: true, currentWindow: true });
  console.log("[FolderJump] mailTab:", mailTab);
  if (!mailTab) { console.warn("[FolderJump] no active mail tab"); return; }

  let accountId = null;
  let messageIds = null;

  if (mode === "move") {
    // Use the list selection as the source of truth: it reflects the click
    // immediately, while the "displayed" message lags behind for messages
    // that are still being downloaded (e.g. a slow EWS fetch) — in that
    // window getDisplayedMessages() can still report the previously shown
    // message, and the move would target the wrong mail.
    let msgs = [];
    try {
      msgs = await collectMessages(await browser.mailTabs.getSelectedMessages(mailTab.id));
    } catch (err) {
      console.error("[FolderJump] getSelectedMessages threw:", err);
    }
    if (!msgs.length) {
      try {
        const result = await browser.messageDisplay.getDisplayedMessages(mailTab.id);
        msgs = result?.messages ?? (Array.isArray(result) ? result : []);
      } catch (err) {
        console.error("[FolderJump] getDisplayedMessages threw:", err);
      }
    }
    console.log("[FolderJump] messages to move:", msgs.length);
    if (!msgs.length) { console.warn("[FolderJump] no selected or displayed message"); return; }
    messageIds = msgs.map(m => m.id);
    accountId = msgs[0].folder?.accountId ?? msgs[0].folder?.account?.id;
  } else {
    accountId = mailTab.displayedFolder?.accountId;
    if (!accountId) { console.warn("[FolderJump] no displayedFolder accountId"); return; }
  }

  console.log("[FolderJump] accountId:", accountId, "messageIds:", messageIds);
  const folders = await getFlatFolders(accountId);
  console.log("[FolderJump] folders found:", folders.length);

  // Load pinned + recent IDs for the popup
  const { pinnedFolders = [], recentFolderIds = [] } =
    await browser.storage.local.get(["pinnedFolders", "recentFolderIds"]);
  const pinnedIds = new Set(pinnedFolders.map(f => f.id));

  pendingCtx = {
    mode, accountId, messageIds, messageCount: messageIds?.length ?? 0,
    tabId: mailTab.id,
    folders, pinnedIds: [...pinnedIds], recentIds: recentFolderIds,
    token: ++ctxToken
  };

  // Center palette on the visible Thunderbird window.
  // getCurrent() from a background script returns the background page itself
  // (wrong coordinates), so use getLastFocused() instead.
  const pw = 580, ph = 440;
  const createProps = {
    type:   "popup",
    url:    browser.runtime.getURL("popup.html"),
    width:  pw,
    height: ph
  };

  try {
    const win = await browser.windows.getLastFocused({ populate: false });
    if (win && win.left != null && win.width != null) {
      createProps.left = Math.round(win.left + (win.width  - pw) / 2);
      createProps.top  = Math.round(win.top  + (win.height - ph) / 3);
    }
  } catch (_) {
    // If positioning fails, let the OS place the window — it will still appear.
  }

  const popup = await browser.windows.create(createProps);
  paletteWindowId = popup?.id ?? null;

  // Bring popup to the front (it can open behind the main window on some builds).
  if (popup?.id) {
    await browser.windows.update(popup.id, { focused: true });
  }
}

// Drop the pending context when the palette window closes without a
// selection, so a later popup can't act on stale data.
browser.windows.onRemoved.addListener((windowId) => {
  if (windowId === paletteWindowId) {
    paletteWindowId = null;
    pendingCtx = null;
  }
});

// ── Recent folders (MRU) ───────────────────────────────────────────────
const MAX_RECENT = 15;
async function recordRecent(folderId) {
  if (!folderId) { return; }
  const { recentFolderIds = [] } = await browser.storage.local.get("recentFolderIds");
  const next = [folderId, ...recentFolderIds.filter(id => id !== folderId)].slice(0, MAX_RECENT);
  await browser.storage.local.set({ recentFolderIds: next });
}

// ── Message lists ──────────────────────────────────────────────────────
// MessageList results are paged (100 messages per page). Follow the
// continuation id so a large multi-selection is handled in full.
async function collectMessages(list) {
  const out = [...(list?.messages ?? [])];
  let id = list?.id;
  while (id) {
    const next = await browser.messages.continueList(id);
    out.push(...(next?.messages ?? []));
    id = next?.id;
  }
  return out;
}

// ── Folder enumeration ─────────────────────────────────────────────────
async function getFlatFolders(accountId) {
  const accounts = await browser.accounts.list(true); // true = include subFolders
  const account  = accounts.find(a => a.id === accountId);
  if (!account) { return []; }

  const result = [];

  function walk(folders, prefix) {
    for (const f of folders) {
      const displayPath = prefix ? `${prefix}/${f.name}` : f.name;
      result.push({
        id:          f.id ?? `${f.accountId}:${f.path}`, // stable key for UI
        accountId:   f.accountId,
        path:        f.path,         // MV2 MailFolder key
        name:        f.name,
        displayPath
      });
      if (f.subFolders?.length) {
        walk(f.subFolders, displayPath);
      }
    }
  }

  walk(account.folders ?? [], "");
  result.sort((a, b) => a.displayPath.localeCompare(b.displayPath));
  return result;
}

// ── Message handling (from popup.js) ───────────────────────────────────
browser.runtime.onMessage.addListener(async (msg) => {
  // ── Popup requests context ─────────────────────────────────────────
  if (msg.action === "getContext") {
    return pendingCtx ?? null;
  }

  // ── User selected a folder in the popup ───────────────────────────
  if (msg.action === "executeAction") {
    if (!pendingCtx || msg.token !== pendingCtx.token) {
      console.warn("[FolderJump] stale palette context, ignoring executeAction");
      return;
    }
    const { mode, messageIds, tabId, folders = [] } = pendingCtx;
    pendingCtx = null;
    if (!mode) { return; }

    const folder = folders.find(f => f.id === msg.folderId);
    if (!folder) { console.warn("[FolderJump] folder not found for id", msg.folderId); return; }
    const mailFolder = { accountId: folder.accountId, path: folder.path };

    // Don't await the move/jump: the popup waits for this reply before it
    // closes, and messages.move() only resolves once the server round-trip
    // (IMAP/EWS) has completed — which can take seconds, e.g. while the
    // message body is still being downloaded. Kick it off, reply at once,
    // and log failures.
    if (mode === "move" && messageIds?.length) {
      // TB 121+ wants the MailFolderId string here.
      browser.messages.move(messageIds, folder.id)
        .catch(err => console.error("[FolderJump] move failed:", err));
    } else if (mode === "jump") {
      // MV2 mailTabs.update still wants the {accountId, path} MailFolder object.
      browser.mailTabs.update(tabId, { displayedFolder: mailFolder })
        .catch(err => console.error("[FolderJump] jump failed:", err));
    }
    await recordRecent(folder.id);
    return { ok: true };
  }

  // ── Popup toggled a pin ────────────────────────────────────────────
  if (msg.action === "togglePin") {
    const { pinnedFolders = [] } = await browser.storage.local.get("pinnedFolders");
    const idx = pinnedFolders.findIndex(f => f.id === msg.folder.id);
    if (idx >= 0) {
      pinnedFolders.splice(idx, 1);
    } else {
      pinnedFolders.push(msg.folder); // {id, name, displayPath}
    }
    await browser.storage.local.set({ pinnedFolders });
    await browser.folderjump.updateBar(pinnedFolders);
    return { pinnedIds: pinnedFolders.map(f => f.id) };
  }
});

// ── Pinned bar events (from experiment) ────────────────────────────────
browser.folderjump.onFolderClicked.addListener(async (folderId) => {
  const [mailTab] = await browser.mailTabs.query({ active: true, currentWindow: true });
  if (!mailTab) { return; }
  const folder = await pinnedFolderById(folderId);
  if (!folder) { return; }
  await browser.mailTabs.update(mailTab.id, {
    displayedFolder: { accountId: folder.accountId, path: folder.path }
  });
  await recordRecent(folderId);
});

async function pinnedFolderById(id) {
  const { pinnedFolders = [] } = await browser.storage.local.get("pinnedFolders");
  return pinnedFolders.find(f => f.id === id);
}

browser.folderjump.onFolderDropped.addListener(async (folderId) => {
  const [mailTab] = await browser.mailTabs.query({ active: true, currentWindow: true });
  if (!mailTab) { return; }
  const msgs = await collectMessages(await browser.mailTabs.getSelectedMessages(mailTab.id));
  const ids = msgs.map(m => m.id);
  if (!ids.length) { return; }
  await browser.messages.move(ids, folderId);
});

browser.folderjump.onFolderUnpinRequested.addListener(async (folderId) => {
  const { pinnedFolders = [] } = await browser.storage.local.get("pinnedFolders");
  const updated = pinnedFolders.filter(f => f.id !== folderId);
  await browser.storage.local.set({ pinnedFolders: updated });
  await browser.folderjump.updateBar(updated);
});
