const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const root = resolve(__dirname, "..");
const source = file => readFileSync(resolve(root, file), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function event() {
  let listener;
  return { addListener(fn) { listener = fn; }, fire(...args) { return listener?.(...args); } };
}

function background({ version = "156.0.1", legacy = false } = {}) {
  const folders = ["Inbox", "Archive", "Projects"].map(name => ({
    ...(legacy ? {} : { id: name.toLowerCase() }),
    accountId: "account1", path: `/${name}`, name
  }));
  const folderId = folder => folder.id ?? `${folder.accountId}:${folder.path}`;
  const calls = { moves: [], statuses: [], windows: [], writes: [], queries: 0, folderQueries: [], capabilities: [], inspections: [] };
  // What the experiment reports about Thunderbird's stored Exchange IDs.
  const exchange = { inspection: { exchange: false, destinationUnlinked: false, unlinkedMessages: 0 }, unlinked: [] };
  const flatFolders = (list = folders) => list.flatMap(f => [f, ...flatFolders(f.subFolders ?? [])]);
  const selected = [{ id: 1, folder: folders[0] }, { id: 2, folder: folders[0] }];
  const stored = { pinnedFolders: folders.map(f => ({ ...f, id: folderId(f) })), recentFolderIds: [] };
  const timers = new Map();
  let timerId = 0;
  const browser = {
    runtime: {
      getBrowserInfo: async () => ({ version }),
      getURL: path => `moz-extension://test/${path}`,
      onMessage: event()
    },
    commands: { onCommand: event() },
    storage: { local: {
      get: async () => plain(stored),
      set: async values => { calls.writes.push(plain(values)); Object.assign(stored, plain(values)); }
    } },
    accounts: { list: async () => [{ id: "account1", folders }] },
    ...(parseInt(version, 10) >= 121 ? { folders: {
      query: async query => {
        calls.folderQueries.push(plain(query));
        return flatFolders().filter(f => f.canAddMessages === false);
      },
      getFolderCapabilities: async destination => {
        calls.capabilities.push(plain(destination));
        const folder = flatFolders().find(f => typeof destination === "string"
          ? f.id === destination
          : f.accountId === destination.accountId && f.path === destination.path);
        if (!folder) { throw new Error("Destination folder not found"); }
        return { canAddMessages: folder.canAddMessages !== false };
      }
    } } : {}),
    mailTabs: {
      query: async () => { calls.queries++; return [{ id: 7, displayedFolder: folders[0] }]; },
      getSelectedMessages: async () => ({ messages: selected }),
      update: async () => {}
    },
    messages: {
      onMoved: event(),
      move: async (...args) => { calls.moves.push(plain(args)); },
      continueList: async () => ({ messages: [] })
    },
    windows: {
      onRemoved: event(),
      getLastFocused: async () => ({ left: 0, top: 0, width: 1000, height: 800 }),
      create: async props => { calls.windows.push(props); return { id: calls.windows.length }; },
      update: async () => {},
      remove: async id => browser.windows.onRemoved.fire(id)
    },
    folderjump: {
      updateBar: async () => {}, setUndoAvailable: async () => {},
      setActionStatus: async (state, text) => { calls.statuses.push({ state, text }); },
      inspectMove: async (...args) => { calls.inspections.push(plain(args)); return exchange.inspection; },
      getUnlinkedFolders: async () => exchange.unlinked,
      onUndoRequested: event(), onFolderClicked: event(), onFolderDropped: event(), onFolderUnpinRequested: event()
    }
  };
  vm.runInNewContext(source("background.js"), {
    browser, console: { log() {}, warn() {}, error() {} },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }
  }, { filename: "background.js" });
  const send = msg => browser.runtime.onMessage.fire(msg);
  const token = () => Number(new URL(calls.windows.at(-1).url).searchParams.get("token"));
  return {
    browser, calls, stored, folders, selected, timers, send, exchange,
    open: async (mode = "move") => {
      await browser.commands.onCommand.fire(`${mode === "move" ? "move" : "jump"}-to-folder`);
      return send({ action: "getContext", token: token() });
    },
    execute: (folder = folders[1], sessionToken = token()) => send({
      action: "executeAction", token: sessionToken, folderId: folderId(folder)
    })
  };
}

test("slow moves acknowledge immediately, survive popup close, and lock their captured selection", async () => {
  const h = background();
  const move = deferred();
  h.browser.messages.move = (...args) => { h.calls.moves.push(plain(args)); return move.promise; };
  await h.open();
  assert.equal((await h.execute()).ok, true);
  assert.equal(h.calls.statuses.at(-1).state, "running");
  await tick();
  assert.equal(h.calls.moves.length, 1);
  assert.equal(h.calls.writes.length, 0);
  h.browser.windows.onRemoved.fire(1);
  await h.open();
  const duplicate = await h.execute();
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /already being moved/);
  assert.equal(h.calls.moves.length, 1);
  move.resolve();
  await tick();
  assert.equal(h.calls.statuses.at(-1).state, "", "success clears the row without a message");
  assert.deepEqual(h.stored.recentFolderIds, ["archive"]);
  assert.deepEqual(h.calls.moves[0], [[1, 2], "archive", { isUserAction: true }]);
});

test("a rejected move stays visible after popup close and is never automatically retried", async () => {
  const h = background();
  const move = deferred();
  h.browser.messages.move = (...args) => { h.calls.moves.push(plain(args)); return move.promise; };
  await h.open();
  await h.execute();
  h.browser.windows.onRemoved.fire(1);
  move.reject(new Error("Mailbox unavailable"));
  await tick();
  assert.equal(h.calls.statuses.at(-1).state, "error");
  assert.match(h.calls.statuses.at(-1).text, /Mailbox unavailable/);
  assert.equal(h.calls.moves.length, 1);
  assert.deepEqual(h.stored.recentFolderIds, []);
  assert.equal(h.timers.size, 0, "errors must not disappear on a success timer");
  await h.open();
  assert.equal((await h.execute()).ok, true, "finished move releases the ID lock");
});

test("a later successful operation cannot erase an overlapping failure", async () => {
  const h = background();
  const first = deferred(), second = deferred();
  h.browser.messages.move = ids => ids[0] === 1 ? first.promise : second.promise;
  await h.open();
  await h.execute();
  h.browser.windows.onRemoved.fire(1);
  h.selected.splice(0, h.selected.length, { id: 3, folder: h.folders[0] });
  await h.open();
  await h.execute(h.folders[2]);
  assert.match(h.calls.statuses.at(-1).text, /2 actions/);
  first.reject(new Error("First move failed"));
  await tick();
  second.resolve();
  await tick();
  assert.equal(h.calls.statuses.at(-1).state, "error");
  assert.match(h.calls.statuses.at(-1).text, /First move failed/);
  assert.deepEqual(h.stored.recentFolderIds, ["projects"]);
});

test("slow or failed recent-folder storage does not delay acceptance or turn a completed move into failure", async () => {
  const h = background();
  await h.open();
  const storage = deferred();
  h.browser.storage.local.set = () => storage.promise;
  assert.equal((await h.execute()).ok, true);
  await tick();
  assert.equal(h.calls.statuses.at(-1).state, "", "success clears the row without a message");
  storage.reject(new Error("Disk full"));
  await tick();
  assert.equal(h.calls.statuses.at(-1).state, "", "success clears the row without a message");
});

test("concurrent completions preserve both recent folders", async () => {
  const h = background();
  const first = deferred(), second = deferred();
  h.browser.messages.move = ids => ids[0] === 1 ? first.promise : second.promise;
  await h.open();
  await h.execute();
  h.browser.windows.onRemoved.fire(1);
  h.selected.splice(0, h.selected.length, { id: 3, folder: h.folders[0] });
  await h.open();
  await h.execute(h.folders[2]);
  first.resolve(); second.resolve();
  await tick();
  assert.deepEqual(h.stored.recentFolderIds, ["projects", "archive"]);
});

for (const version of ["115.18.0", "128.0", "137.0", "156.0.1"]) {
  test(`moves use arguments supported by Thunderbird ${version}`, async () => {
    const h = background({ version, legacy: version.startsWith("115") });
    await h.open();
    await h.execute();
    await tick();
    // TB 115 has no MailFolderId; every later version gets the ID string.
    const destination = version.startsWith("115") ? { accountId: "account1", path: "/Archive" } : "archive";
    assert.deepEqual(h.calls.moves[0].slice(0, 2), [[1, 2], destination]);
    assert.equal(h.calls.moves[0].length, parseInt(version) >= 137 ? 3 : 2);
  });
}

test("a pinned folder keyed on Thunderbird 115 still moves after an upgrade to native folder IDs", async () => {
  const h = background();
  const legacyPinned = { id: "account1:/Projects", accountId: "account1", path: "/Projects", name: "Projects", displayPath: "Projects" };
  h.stored.pinnedFolders = [legacyPinned];
  await h.browser.folderjump.onFolderDropped.fire(legacyPinned.id);
  await tick();
  assert.deepEqual(h.calls.moves[0].slice(0, 2), [[1, 2], { accountId: "account1", path: "/Projects" }]);
  assert.deepEqual(h.calls.capabilities.at(-1), { accountId: "account1", path: "/Projects" });
});

test("rapid shortcuts open one session and stale tokens cannot read or execute a newer selection", async () => {
  const h = background();
  const [ctx] = await Promise.all([h.open(), h.open()]);
  assert.equal(h.calls.windows.length, 1);
  assert.equal(h.calls.queries, 1);
  await h.open();
  assert.equal(h.calls.windows.length, 1);
  assert.equal((await h.execute({ id: "missing" })).ok, false);
  h.browser.windows.onRemoved.fire(1);
  const next = await h.open();
  assert.notEqual(ctx.token, next.token);
  assert.equal(await h.send({ action: "getContext", token: ctx.token }), null);
  assert.equal((await h.execute(h.folders[1], ctx.token)).ok, false);
  assert.equal((await h.execute()).ok, true);
  assert.equal((await h.execute()).ok, false);
  await tick();
  assert.equal(h.calls.moves.length, 1);
});

test("all selection pages are captured, without falling back to an older displayed message", async () => {
  const h = background();
  h.browser.mailTabs.getSelectedMessages = async () => ({ id: "page2", messages: h.selected });
  h.browser.messages.continueList = async id => {
    assert.equal(id, "page2");
    return { messages: [{ id: 3, folder: h.folders[0] }] };
  };
  const ctx = await h.open();
  assert.equal(ctx.messageCount, 3);
  await h.execute();
  await tick();
  assert.deepEqual(h.calls.moves[0][0], [1, 2, 3]);
  h.browser.windows.onRemoved.fire(1);
  h.browser.mailTabs.getSelectedMessages = async () => { throw new Error("Selection unavailable"); };
  await h.browser.commands.onCommand.fire("move-to-folder");
  assert.equal(h.calls.windows.length, 1);
  assert.match(h.calls.statuses.at(-1).text, /Selection unavailable/);
});

test("closing a popup before windows.create resolves does not leave a dead session", async () => {
  const h = background();
  const created = deferred();
  const normalCreate = h.browser.windows.create;
  let popupUrl;
  h.browser.windows.create = props => { popupUrl = props.url; return created.promise; };
  const opening = h.browser.commands.onCommand.fire("move-to-folder");
  await tick();
  const token = Number(new URL(popupUrl).searchParams.get("token"));
  await h.browser.runtime.onMessage.fire({ action: "getContext", token }, { tab: { windowId: 41 } });
  h.browser.windows.onRemoved.fire(41);
  created.resolve({ id: 41 });
  await opening;
  assert.equal(await h.send({ action: "getContext", token }), null);
  h.browser.windows.create = normalCreate;
  const next = await h.open();
  assert.notEqual(next.token, token);
  assert.equal((await h.execute()).ok, true);
});

test("a closed window whose removal event was delayed can be reopened", async () => {
  const h = background();
  await h.open();
  h.browser.windows.update = async id => { if (id === 1) { throw new Error("No such window"); } };
  const next = await h.open();
  assert.equal(h.calls.windows.length, 2);
  assert.equal(next.token, 2);
});

test("pinned-bar moves use the same tracked operation and reject duplicate drops", async () => {
  const h = background();
  const move = deferred();
  h.browser.messages.move = (...args) => { h.calls.moves.push(plain(args)); return move.promise; };
  await h.browser.folderjump.onFolderDropped.fire("archive");
  await h.browser.folderjump.onFolderDropped.fire("archive");
  assert.equal(h.calls.moves.length, 1);
  assert.match(h.calls.statuses.at(-1).text, /already being moved/);
  move.resolve();
  await tick();
});

test("move mode explains unavailable folders and keeps writable descendants accessible", async () => {
  const h = background();
  h.folders[1].canAddMessages = false;
  const child = { id: "child", accountId: "account1", path: "/Archive/Child", name: "Child" };
  h.folders[1].subFolders = [child];
  h.folders.push(
    { id: "virtual", accountId: "account1", path: "/SavedSearch", name: "SavedSearch", isVirtual: true },
    { id: "root", accountId: "account1", path: "/", name: "Account", isRoot: true }
  );
  const ctx = await h.open();
  assert.match(ctx.folders.find(f => f.id === "archive").moveUnavailableReason, /cannot receive/);
  assert.match(ctx.folders.find(f => f.id === "virtual").moveUnavailableReason, /virtual/);
  assert.match(ctx.folders.find(f => f.id === "root").moveUnavailableReason, /Account roots/);
  assert.equal(ctx.folders.find(f => f.id === "child").moveUnavailableReason, null);
  assert.equal(ctx.folders.find(f => f.id === "child").displayPath, "Archive/Child");
  assert.deepEqual(h.calls.folderQueries, [{ accountId: "account1", canAddMessages: false }]);
  for (const folder of [h.folders[1], h.folders[3], h.folders[4]]) {
    assert.equal((await h.execute(folder)).ok, false);
  }
  assert.equal(h.calls.moves.length, 0);
  assert.equal((await h.execute(child)).ok, true, "rejected destinations do not consume the session");
  await tick();
  assert.equal(h.calls.moves[0][1], "child");
});

test("jump mode still opens a virtual or read-only folder without a capability scan", async () => {
  const h = background();
  h.folders[1].canAddMessages = false;
  h.folders[1].isVirtual = true;
  const ctx = await h.open("jump");
  assert.equal(ctx.folders.find(f => f.id === "archive").moveUnavailableReason, null);
  assert.equal((await h.execute()).ok, true);
  await tick();
  assert.equal(h.calls.statuses.at(-1).state, "", "success clears the row without a message");
  assert.equal(h.calls.folderQueries.length, 0);
  assert.equal(h.calls.capabilities.length, 0);
});

test("permissions are checked again when executing, even after the popup closes", async () => {
  const h = background();
  await h.open();
  h.folders[1].canAddMessages = false;
  assert.equal((await h.execute()).ok, true);
  h.browser.windows.onRemoved.fire(1);
  await tick();
  assert.equal(h.calls.moves.length, 0);
  assert.equal(h.calls.statuses.at(-1).state, "error");
  assert.match(h.calls.statuses.at(-1).text, /cannot receive messages/);
  assert.deepEqual(h.stored.recentFolderIds, []);
});

test("stale pinned destinations cannot bypass capability checks", async () => {
  const h = background();
  h.folders[1].canAddMessages = false;
  await h.browser.folderjump.onFolderDropped.fire("archive");
  await tick();
  assert.equal(h.calls.moves.length, 0);
  assert.match(h.calls.statuses.at(-1).text, /cannot receive messages/);
  h.folders.splice(1, 1);
  await h.browser.folderjump.onFolderDropped.fire("archive");
  await tick();
  assert.equal(h.calls.moves.length, 0);
  assert.match(h.calls.statuses.at(-1).text, /Destination folder not found/);
});

test("an omitted optional capability does not incorrectly reject a destination", async () => {
  const h = background();
  h.browser.folders.getFolderCapabilities = async () => ({});
  await h.open();
  await h.execute();
  await tick();
  assert.equal(h.calls.moves.length, 1);
});

test("jump failures are visible too", async () => {
  const h = background();
  h.browser.mailTabs.update = async () => { throw new Error("Folder was deleted"); };
  await h.open("jump");
  assert.equal((await h.execute()).ok, true);
  await tick();
  assert.match(h.calls.statuses.at(-1).text, /Folder was deleted/);
  assert.equal(h.calls.writes.length, 0);
});

test("undo reverses the completed move without recording its reversal as a new user action", async () => {
  const h = background();
  await h.browser.messages.onMoved.fire(
    { messages: [{ id: 1, folder: h.folders[0] }] },
    { messages: [{ id: 9, folder: h.folders[1] }] }
  );
  await h.browser.folderjump.onUndoRequested.fire();
  assert.deepEqual(h.calls.moves[0], [[9], "inbox"]);
  await h.browser.messages.onMoved.fire(
    { messages: [{ id: 9, folder: h.folders[1] }] },
    { messages: [{ id: 10, folder: h.folders[0] }] }
  );
  await h.browser.folderjump.onUndoRequested.fire();
  assert.equal(h.calls.moves.length, 1, "undo's onMoved event must not become a redo entry");
});

const linked = { exchange: true, destinationUnlinked: false, unlinkedMessages: 0 };
const aborted = status => new Error(`Error moving message: Aborted with status: ${status}`);

test("an Exchange folder without a stored ID is explained in the palette and never reaches messages.move", async () => {
  const h = background();
  h.exchange.unlinked = ["/Archive"];
  const ctx = await h.open();
  assert.match(ctx.folders.find(f => f.id === "archive").moveUnavailableReason, /no Exchange ID/);
  assert.equal(ctx.folders.find(f => f.id === "projects").moveUnavailableReason, null);
  const reply = await h.execute();
  assert.equal(reply.ok, false);
  assert.match(reply.error, /no Exchange ID/);
  assert.equal(h.calls.moves.length, 0);
  assert.equal((await h.execute(h.folders[2])).ok, true);
  h.browser.windows.onRemoved.fire(1);
  h.exchange.unlinked = [];
  const jump = await h.open("jump");
  assert.equal(jump.folders.find(f => f.id === "archive").moveUnavailableReason, null);
});

test("a pinned Exchange folder that lost its ID fails with the reason instead of an opaque status", async () => {
  const h = background();
  h.exchange.inspection = { ...linked, destinationUnlinked: true };
  await h.browser.folderjump.onFolderDropped.fire("archive");
  await tick();
  assert.deepEqual(h.calls.inspections.at(-1), [[1, 2], { accountId: "account1", path: "/Archive" }]);
  assert.equal(h.calls.moves.length, 0);
  assert.equal(h.calls.statuses.at(-1).state, "error");
  assert.match(h.calls.statuses.at(-1).text, /no Exchange ID stored for this folder/);
  assert.doesNotMatch(h.calls.statuses.at(-1).text, /Check the source and destination/);
});

test("selected mail without an Exchange ID blocks the whole move instead of moving part of it", async () => {
  const h = background();
  h.exchange.inspection = { ...linked, unlinkedMessages: 1 };
  await h.open();
  assert.equal((await h.execute()).ok, true);
  await tick();
  assert.equal(h.calls.moves.length, 0);
  assert.match(h.calls.statuses.at(-1).text, /1 of the 2 selected message\(s\) have no Exchange ID/);
  assert.match(h.calls.statuses.at(-1).text, /Nothing was moved/);
  assert.deepEqual(h.stored.recentFolderIds, []);
});

test("an abort by the Exchange backend is named and explained", async () => {
  const h = background();
  h.exchange.inspection = linked;
  h.browser.messages.move = async () => { throw aborted(2147549183); };
  await h.open();
  await h.execute();
  await tick();
  const { state, text } = h.calls.statuses.at(-1);
  assert.equal(state, "error");
  assert.match(text, /NS_ERROR_UNEXPECTED, 0x8000FFFF/);
  assert.match(text, /server rejected the request/);
  assert.match(text, /Get Messages/);
  assert.doesNotMatch(text, /Aborted with status|Check the source and destination/);
});

test("aborts on other backends name the status and keep the generic hint", async () => {
  const h = background();
  h.browser.messages.move = async () => { throw aborted(2147500037); };
  await h.open();
  await h.execute();
  await tick();
  assert.match(h.calls.statuses.at(-1).text, /NS_ERROR_FAILURE, 0x80004005\)\. Check the source and destination/);
  h.browser.windows.onRemoved.fire(1);
  h.browser.messages.move = async () => { throw aborted(2152398861); };
  await h.open();
  await h.execute();
  await tick();
  assert.match(h.calls.statuses.at(-1).text, /Thunderbird aborted the move \(0x804B000D\)/);
});

for (const [name, inspectMove] of [
  ["fails", async () => { throw new Error("Experiment unavailable"); }],
  ["has no answer", async () => null]
]) {
  test(`a move still runs when the Exchange inspection ${name}`, async () => {
    const h = background();
    h.browser.folderjump.inspectMove = inspectMove;
    await h.open();
    await h.execute();
    await tick();
    assert.equal(h.calls.moves.length, 1);
    assert.equal(h.calls.statuses.at(-1).state, "");
  });
}

test("a failing Exchange folder check does not keep the palette from opening", async () => {
  const h = background();
  h.browser.folderjump.getUnlinkedFolders = async () => { throw new Error("Experiment unavailable"); };
  const ctx = await h.open();
  assert.equal(ctx.folders.length, 3);
  assert.equal((await h.execute()).ok, true);
});

function popup() {
  const status = { textContent: "", hidden: true };
  const calls = { sent: [], closed: 0 };
  const browser = { runtime: { sendMessage: async () => null } };
  const context = vm.createContext({
    browser, URLSearchParams,
    window: { location: { search: "?token=23" }, close() { calls.closed++; } },
    document: { getElementById: id => id === "action-status" ? status : { textContent: "" } }
  });
  vm.runInContext(source("popup.js"), context);
  return { browser, calls, status, select: (folder = { id: "archive" }) => {
    context.selectedFolder = folder;
    return vm.runInContext("selectFolder(selectedFolder)", context);
  } };
}

test("the popup explains disabled destinations without sending an execution request", async () => {
  const h = popup();
  await tick();
  h.browser.runtime.sendMessage = async msg => { h.calls.sent.push(msg); return { ok: true }; };
  await h.select({ id: "readonly", moveUnavailableReason: "This folder cannot receive messages." });
  assert.equal(h.calls.sent.length, 0);
  assert.equal(h.calls.closed, 0);
  assert.equal(h.status.hidden, false);
  assert.match(h.status.textContent, /cannot receive/);
  await h.select();
  assert.equal(h.calls.closed, 1);
});

test("the popup blocks duplicate submissions and closes only for an explicit acceptance", async () => {
  const h = popup();
  await tick();
  const reply = deferred();
  h.browser.runtime.sendMessage = msg => { h.calls.sent.push(msg); return reply.promise; };
  const first = h.select();
  await h.select();
  assert.equal(h.calls.sent.length, 1);
  assert.equal(h.calls.closed, 0);
  reply.resolve({ ok: true });
  await first;
  assert.equal(h.calls.closed, 1);
});

for (const reply of [undefined, { ok: false, error: "Expired palette" }, new Error("Connection lost")]) {
  test(`the popup shows ${reply?.error ?? reply?.message ?? "a missing acknowledgement"} instead of closing`, async () => {
    const h = popup();
    await tick();
    h.browser.runtime.sendMessage = async () => { if (reply instanceof Error) { throw reply; } return reply; };
    await h.select();
    assert.equal(h.calls.closed, 0);
    assert.equal(h.status.hidden, false);
    assert.ok(h.status.textContent);
    h.browser.runtime.sendMessage = async () => ({ ok: true });
    await h.select();
    assert.equal(h.calls.closed, 1);
  });
}

// ── Experiment: what Thunderbird has stored about an Exchange account ──
function experiment() {
  const context = vm.createContext({
    ExtensionAPI: class {}, ExtensionCommon: {}, Services: { console: { logStringMessage() {} } }
  });
  vm.runInContext(source("api/implementation.js"), context, { filename: "implementation.js" });

  const servers = {};
  const byPath = new Map();
  const headers = new Map();
  function server(accountId, type) {
    const root = { path: "/", flags: 0, ewsId: type === "none" ? "" : "msgfolderroot", descendants: [] };
    root.server = servers[accountId] = { key: accountId, type, rootFolder: root };
    byPath.set(`${accountId}:/`, root);
    return root.server;
  }
  function folder(accountId, path, props = {}) {
    const f = { path, flags: 0, ewsId: `id-of-${path}`, server: servers[accountId], ...props };
    servers[accountId].rootFolder.descendants.push(f);
    byPath.set(`${accountId}:${path}`, f);
    return f;
  }
  const readsId = item => ({
    ...item,
    getStringProperty(name) {
      assert.equal(name, "ewsId");
      if (item.missingSummary) { throw new Error("NS_MSG_ERROR_FOLDER_MISSING"); }
      return item.ewsId;
    }
  });
  const native = f => f && Object.assign(readsId(f), {
    server: { ...f.server, rootFolder: undefined },
    descendants: (f.descendants ?? []).map(d => readsId(d))
  });
  const extension = {
    folderManager: {
      get(accountId, path) {
        const f = byPath.get(`${accountId}:${path}`);
        if (!f) { throw new Error(`Folder not found: ${path}`); }
        const result = native(f);
        result.server.rootFolder = native(servers[accountId].rootFolder);
        return result;
      },
      convert: f => ({ path: f.path })
    },
    messageManager: {
      get(id) {
        const hdr = headers.get(id);
        return hdr ? readsId({ ...hdr, folder: { server: servers[hdr.accountId] } }) : null;
      }
    }
  };
  context.extension = extension;
  const call = code => plain(vm.runInContext(code, context));
  return {
    server, folder, headers,
    inspect(ids, accountId, path) {
      context.args = { ids, destination: { accountId, path } };
      return call("_inspectMove(extension, args.ids, args.destination)");
    },
    unlinked(accountId) {
      context.accountId = accountId;
      return call("_unlinkedFolderPaths(extension, accountId)");
    }
  };
}

test("the experiment reports Exchange folders and same-account mail that Thunderbird cannot address", () => {
  const x = experiment();
  x.server("exchange", "ews");
  x.server("other", "imap");
  x.folder("exchange", "/Inbox");
  x.folder("exchange", "/Inbox/Lost", { ewsId: "" });
  x.folder("exchange", "/Inbox/NoSummary", { missingSummary: true });
  x.folder("exchange", "/Saved Search", { ewsId: "", flags: 0x20 });
  x.headers.set(1, { accountId: "exchange", ewsId: "item-1" });
  x.headers.set(2, { accountId: "exchange", ewsId: "" });
  x.headers.set(3, { accountId: "other", ewsId: "" });

  assert.deepEqual(x.inspect([1], "exchange", "/Inbox"),
    { exchange: true, destinationUnlinked: false, unlinkedMessages: 0 });
  assert.deepEqual(x.inspect([1], "exchange", "/Inbox/Lost"),
    { exchange: true, destinationUnlinked: true, unlinkedMessages: 0 });
  assert.equal(x.inspect([1], "exchange", "/Inbox/NoSummary").destinationUnlinked, true);
  // Mail from another account is uploaded, so its missing ID is irrelevant;
  // an unknown message is left for messages.move() to report.
  assert.deepEqual(x.inspect([1, 2, 3, 99], "exchange", "/Inbox"),
    { exchange: true, destinationUnlinked: false, unlinkedMessages: 1 });
  assert.deepEqual(x.unlinked("exchange"), ["/Inbox/Lost", "/Inbox/NoSummary"]);
  assert.throws(() => x.inspect([1], "exchange", "/Deleted"), /Folder not found/);
});

test("the experiment stays out of the way for other account types and unknown ID storage", () => {
  const x = experiment();
  x.server("imap", "imap");
  x.folder("imap", "/Inbox", { ewsId: "" });
  assert.deepEqual(x.inspect([], "imap", "/Inbox"),
    { exchange: false, destinationUnlinked: false, unlinkedMessages: 0 });
  assert.deepEqual(x.unlinked("imap"), []);

  // A Thunderbird release that stores the IDs elsewhere must not make every
  // folder of the account look unusable.
  x.server("renamed", "ews").rootFolder.ewsId = "";
  for (const name of ["A", "B", "C"]) { x.folder("renamed", `/${name}`, { ewsId: "" }); }
  assert.equal(x.inspect([], "renamed", "/A").exchange, false);
  assert.deepEqual(x.unlinked("renamed"), []);
});
