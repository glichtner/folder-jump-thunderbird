"use strict";

/* =====================================================================
 * background.js — Folder Jump
 *
 * Coordinates keyboard commands, the palette popup, and the pinned bar.
 * All folder references use MailFolderId strings (the `id` property on
 * MailFolder objects returned by browser.accounts.list(true)).
 * ===================================================================== */

// ── State ──────────────────────────────────────────────────────────────
// Holds context for the popup while it is open.
let pendingCtx = null;

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

async function openPalette(mode) {
  console.log("[FolderJump] openPalette start, mode =", mode);

  const [mailTab] = await browser.mailTabs.query({ active: true, currentWindow: true });
  console.log("[FolderJump] mailTab:", mailTab);
  if (!mailTab) { console.warn("[FolderJump] no active mail tab"); return; }

  let accountId = null;
  let messageId = null;

  if (mode === "move") {
    let result;
    try {
      result = await browser.messageDisplay.getDisplayedMessages(mailTab.id);
    } catch (err) {
      console.error("[FolderJump] getDisplayedMessages threw:", err);
      return;
    }
    console.log("[FolderJump] displayedMessages:", result);
    const msg = result?.messages?.[0] ?? result?.[0];
    if (!msg) { console.warn("[FolderJump] no displayed message"); return; }
    messageId = msg.id;
    accountId = msg.folder?.accountId ?? msg.folder?.account?.id;
  } else {
    accountId = mailTab.displayedFolder?.accountId;
    if (!accountId) { console.warn("[FolderJump] no displayedFolder accountId"); return; }
  }

  console.log("[FolderJump] accountId:", accountId, "messageId:", messageId);
  const folders = await getFlatFolders(accountId);
  console.log("[FolderJump] folders found:", folders.length);

  // Load pinned + recent IDs for the popup
  const { pinnedFolders = [], recentFolderIds = [] } =
    await browser.storage.local.get(["pinnedFolders", "recentFolderIds"]);
  const pinnedIds = new Set(pinnedFolders.map(f => f.id));

  pendingCtx = {
    mode, accountId, messageId, tabId: mailTab.id,
    folders, pinnedIds: [...pinnedIds], recentIds: recentFolderIds
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

  // Bring popup to the front (it can open behind the main window on some builds).
  if (popup?.id) {
    await browser.windows.update(popup.id, { focused: true });
  }
}

// ── Recent folders (MRU) ───────────────────────────────────────────────
const MAX_RECENT = 15;
async function recordRecent(folderId) {
  if (!folderId) { return; }
  const { recentFolderIds = [] } = await browser.storage.local.get("recentFolderIds");
  const next = [folderId, ...recentFolderIds.filter(id => id !== folderId)].slice(0, MAX_RECENT);
  await browser.storage.local.set({ recentFolderIds: next });
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
    const { mode, messageId, tabId, folders = [] } = pendingCtx ?? {};
    pendingCtx = null;
    if (!mode) { return; }

    const folder = folders.find(f => f.id === msg.folderId);
    if (!folder) { console.warn("[FolderJump] folder not found for id", msg.folderId); return; }
    const mailFolder = { accountId: folder.accountId, path: folder.path };

    if (mode === "move" && messageId != null) {
      await browser.messages.move([messageId], mailFolder);
    } else if (mode === "jump") {
      await browser.mailTabs.update(tabId, { displayedFolder: mailFolder });
    }
    await recordRecent(folder.id);
    return;
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
  await browser.mailTabs.update(mailTab.id, { displayedFolderId: folderId });
});

browser.folderjump.onFolderDropped.addListener(async (folderId) => {
  const [mailTab] = await browser.mailTabs.query({ active: true, currentWindow: true });
  if (!mailTab) { return; }
  const result = await browser.mailTabs.getSelectedMessages(mailTab.id);
  const ids = result?.messages?.map(m => m.id) ?? [];
  if (!ids.length) { return; }
  await browser.messages.move(ids, folderId);
});

browser.folderjump.onFolderUnpinRequested.addListener(async (folderId) => {
  const { pinnedFolders = [] } = await browser.storage.local.get("pinnedFolders");
  const updated = pinnedFolders.filter(f => f.id !== folderId);
  await browser.storage.local.set({ pinnedFolders: updated });
  await browser.folderjump.updateBar(updated);
});
