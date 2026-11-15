"use strict";

/* =====================================================================
 * background.js — Folder Jump
 *
 * Coordinates keyboard commands, the palette popup, and the pinned bar.
 * UI keys use folder IDs. API calls get the MailFolderId on TB 121+ and
 * an accountId/path pair on TB 115 (see folderDestination).
 * ===================================================================== */

// ── State ──────────────────────────────────────────────────────────────
// Holds context for the popup while it is open. Each palette session gets a
// token so a stale popup can never execute against a newer (or cleared)
// context.
let pendingCtx = null;
let paletteWindowId = null;
let ctxToken = 0;
let openingPalette = null;

// TB 137 added user-action moves, including the mail window needed by
// backends for progress/authentication and native undo. Never retry a failed
// move with different arguments: the server may already have moved some mail.
const moveOptions = browser.runtime.getBrowserInfo().then(info =>
  parseInt(info.version, 10) >= 137 ? { isUserAction: true } : null
).catch(err => {
  console.warn("[FolderJump] Could not determine Thunderbird version:", err);
  return null;
});

// TB 121+ returns MailFolderId strings and warns about (MV3: rejects) full
// MailFolder objects. TB 115 has no folder IDs, so the palette synthesises
// `${accountId}:${path}` keys; those must never reach the API. A key like
// that can also survive in storage (pinned on 115, then upgraded).
const nativeFolderIds = typeof browser.folders?.getFolderCapabilities === "function";

function folderDestination(folder) {
  const hasMailFolder = folder.accountId && folder.path != null;
  const synthetic = hasMailFolder ? `${folder.accountId}:${folder.path}` : null;
  if (nativeFolderIds && folder.id && folder.id !== synthetic) { return folder.id; }
  if (hasMailFolder) { return { accountId: folder.accountId, path: folder.path }; }
  return folder.id;
}

// ── Native Exchange accounts ───────────────────────────────────────────
// Thunderbird's Exchange backend addresses folders and messages on the
// server by an ID it stores locally. When one is missing, or the server
// rejects the request, messages.move() fails with the same opaque text —
// "Aborted with status: 2147549183" (NS_ERROR_UNEXPECTED) — and so does
// Thunderbird's own Move To, silently. The experiment can read the stored
// IDs, so check them first and say which folder or message is at fault.
const UNLINKED_FOLDER_REASON = "Thunderbird has no Exchange ID stored for this folder, so it cannot move mail into it (its own Move To fails here too).";

// An error whose message already tells the user what to do; startAction adds
// no generic hint to it.
function explained(message) {
  return Object.assign(new Error(message), { explained: true });
}

async function inspectMove(ids, folder) {
  if (!browser.folderjump.inspectMove || !folder.accountId || folder.path == null) { return null; }
  try {
    return await browser.folderjump.inspectMove(ids, { accountId: folder.accountId, path: folder.path });
  } catch (err) {
    // Diagnostics only: never let them block a move Thunderbird could do.
    console.warn("[FolderJump] move inspection failed:", err);
    return null;
  }
}

// messages.move() reports a backend failure only as the decimal nsresult.
const NS_ERROR_UNEXPECTED = 0x8000ffff;
const NS_ERROR_NAMES = {
  [NS_ERROR_UNEXPECTED]: "NS_ERROR_UNEXPECTED",
  0x80004005: "NS_ERROR_FAILURE",
  0x80004004: "NS_ERROR_ABORT",
  0x80040111: "NS_ERROR_NOT_AVAILABLE",
  0x804b000e: "NS_ERROR_NET_TIMEOUT",
  0x804b0010: "NS_ERROR_OFFLINE"
};

function describeMoveFailure(err, inspection) {
  const status = Number(/Aborted with status: (\d+)/.exec(err?.message ?? String(err))?.[1]);
  if (!status) { return err; }
  const hex = `0x${status.toString(16).toUpperCase().padStart(8, "0")}`;
  const code = NS_ERROR_NAMES[status] ? `${NS_ERROR_NAMES[status]}, ${hex}` : hex;
  if (inspection?.exchange && status === NS_ERROR_UNEXPECTED) {
    // The stored IDs were present, which leaves the server round-trip.
    return explained(`Thunderbird's Exchange backend aborted the move (${code}). The folder and the selected mail are linked to the server, so the server rejected the request or Thunderbird could not record the result. The mail may already have moved on the server: use Get Messages on both folders before trying again.`);
  }
  return new Error(`Thunderbird aborted the move (${code})`);
}

async function moveMessages(ids, folder, isUserAction = true) {
  if (folder.moveUnavailableReason) { throw new Error(folder.moveUnavailableReason); }
  const destination = folderDestination(folder);
  // Recheck at execution time: ACLs can change while the palette is open,
  // and pinned folders may have been saved long before this move.
  if (browser.folders?.getFolderCapabilities) {
    const capabilities = await browser.folders.getFolderCapabilities(destination);
    if (capabilities.canAddMessages === false) {
      throw new Error("Thunderbird reports that this folder cannot receive messages. It may be read-only or only contain subfolders.");
    }
  }
  const inspection = await inspectMove(ids, folder);
  if (inspection?.destinationUnlinked) { throw explained(UNLINKED_FOLDER_REASON); }
  if (inspection?.unlinkedMessages) {
    // Thunderbird would leave these out of the server request, move the
    // rest, and then fail to record the result — so move nothing.
    const some = inspection.unlinkedMessages < ids.length ? `${inspection.unlinkedMessages} of the ${ids.length}` : "The";
    throw explained(`${some} selected message(s) have no Exchange ID in Thunderbird, so the server cannot be told to move them. Nothing was moved. Get Messages on the source folder may link them again.`);
  }
  const options = await moveOptions;
  try {
    return await (options && isUserAction
      ? browser.messages.move(ids, destination, options)
      : browser.messages.move(ids, destination));
  } catch (err) {
    throw describeMoveFailure(err, inspection);
  }
}

// Accepted actions outlive their popup. Keep feedback in the main window
// until completion, and lock the captured IDs against overlapping moves.
const movingIds = new Set();
const activeActions = new Map();
let actionSequence = 0;
let actionErrors = [];

function publishStatus(state, text) {
  browser.folderjump.setActionStatus(state, text)
    .catch(err => console.error("[FolderJump] status display failed:", err));
}

// Only pending work and failures are shown. Success needs no message: the
// mail itself leaves the list, or the folder opens.
function refreshActionStatus() {
  const count = activeActions.size;
  const runningText = count > 1
    ? `${count} actions in progress…`
    : (activeActions.values().next().value ?? "");
  if (actionErrors.length) {
    publishStatus("error", `${actionErrors.join(" | ")}${count ? ` — ${runningText}` : ""}`);
  } else if (count) {
    publishStatus("running", runningText);
  } else {
    publishStatus("", "");
  }
}

function showActionError(text) {
  actionErrors.push(text);
  refreshActionStatus();
}

function startAction({ label, ids = [], folderId, run }) {
  if (ids.some(id => movingIds.has(id))) {
    throw new Error("These messages are already being moved. Wait for the current move to finish.");
  }
  if (!activeActions.size) { actionErrors = []; }
  const actionId = ++actionSequence;
  const started = Date.now();
  for (const id of ids) { movingIds.add(id); }
  activeActions.set(actionId, label);
  refreshActionStatus();
  console.log(`[FolderJump] action ${actionId} started:`, label);

  // The receipt means accepted, not completed. Storage and server latency
  // must not delay the popup's acknowledgement.
  void (async () => {
    try {
      await run();
      console.log(`[FolderJump] action ${actionId} completed in ${Date.now() - started} ms`);
      if (folderId) {
        recordRecent(folderId).catch(err => console.warn("[FolderJump] recent folders:", err));
      }
    } catch (err) {
      console.error(`[FolderJump] action ${actionId} failed after ${Date.now() - started} ms:`, err);
      const reason = (err.message ?? String(err)).replace(/\.$/, "");
      const hint = err.explained ? "" : " Check the source and destination before trying again.";
      actionErrors.push(`${label.replace(/…$/, "")} failed: ${reason}.${hint}`);
    } finally {
      for (const id of ids) { movingIds.delete(id); }
      activeActions.delete(actionId);
      refreshActionStatus();
    }
  })();
}

function startMove(ids, folder) {
  const name = folder.displayPath ?? folder.path ?? folder.id;
  startAction({
    label: `Moving ${ids.length} message(s) to ${name}…`,
    ids, folderId: folder.id,
    run: () => moveMessages(ids, folder)
  });
}

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
    showActionError(`Could not open Folder Jump: ${err.message ?? String(err)}`);
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
  for (const id of last.newIds) { undoMovedIds.add(id); }
  // Drop the marker eventually in case onMoved never fires for these ids.
  setTimeout(() => { for (const id of last.newIds) { undoMovedIds.delete(id); } }, UNDO_ID_TTL_MS);
  try {
    // Reversing our own history must not create another native undo action.
    await moveMessages(last.newIds, last.fromFolder, false);
  } catch (err) {
    console.error("[FolderJump] undo failed:", err);
    showActionError(`Undo failed: ${err.message ?? String(err)}`);
    for (const id of last.newIds) { undoMovedIds.delete(id); }
  }
}

browser.folderjump.onUndoRequested.addListener(undoLastMove);

async function openPalette(mode) {
  if (openingPalette) { return openingPalette; }
  openingPalette = openPaletteWindow(mode);
  try {
    await openingPalette;
  } finally {
    openingPalette = null;
  }
}

async function openPaletteWindow(mode) {
  if (paletteWindowId != null && pendingCtx) {
    try {
      await browser.windows.update(paletteWindowId, { focused: true });
      return;
    } catch (_) {
      // The window may have closed before onRemoved reached us.
      paletteWindowId = null;
      pendingCtx = null;
    }
  }
  // A previous palette may still be closing after its action was accepted.
  if (paletteWindowId != null) {
    try { await browser.windows.remove(paletteWindowId); } catch (_) {}
    paletteWindowId = null;
  }
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
    const msgs = await collectMessages(await browser.mailTabs.getSelectedMessages(mailTab.id));
    console.log("[FolderJump] messages to move:", msgs.length);
    if (!msgs.length) { throw new Error("Select at least one message first."); }
    messageIds = msgs.map(m => m.id);
    accountId = msgs[0].folder?.accountId ?? msgs[0].folder?.account?.id;
  } else {
    accountId = mailTab.displayedFolder?.accountId;
    if (!accountId) { console.warn("[FolderJump] no displayedFolder accountId"); return; }
  }

  console.log("[FolderJump] accountId:", accountId, "messageIds:", messageIds);
  const folders = await getFlatFolders(accountId, mode);
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
    url:    browser.runtime.getURL(`popup.html?token=${pendingCtx.token}`),
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

  let popup;
  try {
    popup = await browser.windows.create(createProps);
    // The popup can load, execute or close before windows.create resolves.
    if (!pendingCtx) {
      if (popup?.id != null) {
        try { await browser.windows.remove(popup.id); } catch (_) {}
      }
      return;
    }
    paletteWindowId = popup?.id ?? null;
  } catch (err) {
    pendingCtx = null;
    paletteWindowId = null;
    throw err;
  }

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
let recentWrite = Promise.resolve();
function recordRecent(folderId) {
  if (!folderId) { return Promise.resolve(); }
  const write = recentWrite.then(async () => {
    const { recentFolderIds = [] } = await browser.storage.local.get("recentFolderIds");
    const next = [folderId, ...recentFolderIds.filter(id => id !== folderId)].slice(0, MAX_RECENT);
    await browser.storage.local.set({ recentFolderIds: next });
  });
  recentWrite = write.catch(() => {});
  return write;
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
async function getFlatFolders(accountId, mode = "jump") {
  const accounts = await browser.accounts.list(true); // true = include subFolders
  const account  = accounts.find(a => a.id === accountId);
  if (!account) { return []; }

  // One local query avoids a capability request for every folder. Keep
  // unavailable targets in the palette so searching for one explains why
  // it cannot be used. TB 115 has neither query nor capability APIs.
  const unavailableIds = new Set();
  if (mode === "move" && browser.folders?.query) {
    const unavailable = await browser.folders.query({ accountId, canAddMessages: false });
    for (const folder of unavailable) { unavailableIds.add(folder.id); }
  }
  // Native Exchange only: folders Thunderbird cannot address on the server.
  const unlinkedPaths = new Set();
  if (mode === "move" && browser.folderjump.getUnlinkedFolders) {
    try {
      for (const path of await browser.folderjump.getUnlinkedFolders(accountId)) { unlinkedPaths.add(path); }
    } catch (err) {
      console.warn("[FolderJump] Exchange folder check failed:", err);
    }
  }
  const result = [];

  function walk(folders, prefix) {
    for (const f of folders) {
      const displayPath = prefix ? `${prefix}/${f.name}` : f.name;
      let moveUnavailableReason = null;
      if (mode === "move") {
        if (f.isRoot || f.path === "/") {
          moveUnavailableReason = "Account roots cannot receive messages. Choose a mail folder below this account.";
        } else if (f.isVirtual || f.isTag || f.isUnified) {
          moveUnavailableReason = "This is a virtual folder. Choose a real mail folder as the destination.";
        } else if (unavailableIds.has(f.id)) {
          moveUnavailableReason = "This folder cannot receive messages. It may be read-only or only contain subfolders.";
        } else if (unlinkedPaths.has(f.path)) {
          moveUnavailableReason = UNLINKED_FOLDER_REASON;
        }
      }
      result.push({
        id:          f.id ?? `${f.accountId}:${f.path}`, // stable key for UI
        accountId:   f.accountId,
        path:        f.path,         // MV2 MailFolder key
        name:        f.name,
        displayPath,
        moveUnavailableReason
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
browser.runtime.onMessage.addListener(async (msg, sender) => {
  // ── Popup requests context ─────────────────────────────────────────
  if (msg.action === "getContext") {
    if (!pendingCtx || msg.token !== pendingCtx.token) { return null; }
    // Bind early so closing a quickly loaded popup always clears its context.
    if (sender?.tab?.windowId != null) { paletteWindowId = sender.tab.windowId; }
    return pendingCtx;
  }

  // ── User selected a folder in the popup ───────────────────────────
  if (msg.action === "executeAction") {
    if (!pendingCtx || msg.token !== pendingCtx.token) {
      console.warn("[FolderJump] stale palette context, ignoring executeAction");
      return { ok: false, error: "This palette has expired. Close it and open Folder Jump again." };
    }
    const { mode, messageIds, tabId, folders = [] } = pendingCtx;

    const folder = folders.find(f => f.id === msg.folderId);
    if (!folder) { return { ok: false, error: "Folder not found. Reopen Folder Jump to refresh the list." }; }
    if (mode === "move" && folder.moveUnavailableReason) {
      return { ok: false, error: folder.moveUnavailableReason };
    }
    const mailFolder = { accountId: folder.accountId, path: folder.path };

    try {
      if (mode === "move" && messageIds?.length) {
        startMove(messageIds, folder);
      } else if (mode === "jump") {
        startAction({
          label: `Opening ${folder.displayPath}…`,
          folderId: folder.id,
          run: () => browser.mailTabs.update(tabId, { displayedFolder: mailFolder })
        });
      } else {
        return { ok: false, error: "No messages selected. Reopen Folder Jump." };
      }
    } catch (err) {
      return { ok: false, error: err.message ?? String(err) };
    }
    pendingCtx = null;
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
  try {
    const [mailTab] = await browser.mailTabs.query({ active: true, currentWindow: true });
    if (!mailTab) { return; }
    const msgs = await collectMessages(await browser.mailTabs.getSelectedMessages(mailTab.id));
    const ids = msgs.map(m => m.id);
    if (!ids.length) { return; }
    const folder = await pinnedFolderById(folderId);
    if (!folder) { throw new Error("Pinned folder not found. Pin it again from the palette."); }
    startMove(ids, folder);
  } catch (err) {
    showActionError(`Could not start move: ${err.message ?? String(err)}`);
  }
});

browser.folderjump.onFolderUnpinRequested.addListener(async (folderId) => {
  const { pinnedFolders = [] } = await browser.storage.local.get("pinnedFolders");
  const updated = pinnedFolders.filter(f => f.id !== folderId);
  await browser.storage.local.set({ pinnedFolders: updated });
  await browser.folderjump.updateBar(updated);
});
