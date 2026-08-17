# Folder Jump

A keyboard-first folder navigator for Thunderbird. Jump to any folder or
move the current message with a VS Code-style fuzzy palette, and pin
favourite folders to a quick-access bar at the top of the window.

![Thunderbird 115+](https://img.shields.io/badge/Thunderbird-115%2B-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-green)

---

## Why

Deep folder hierarchies in Thunderbird are slow to navigate by mouse,
and the built-in *Move to* menu requires hunting through nested submenus
every time. Folder Jump replaces both with a single keystroke and
subsequence fuzzy-matching — type `pa` to reach
`INBOX/Projects/Acme/` without spelling out the full name.

The pinned bar gives the same speed to mouse users: click to jump, or
drag selected messages onto a folder button to move them there.

---

## Features

| | |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>.</kbd> | Open the palette and **jump** to a folder |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>.</kbd> | Open the palette and **move** the selected message(s) — multi-select works, the palette shows how many |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> | **Undo** the last move (any move — palette, pinned bar or Thunderbird's own UI). Only active in the main mail window while the message list / folder pane has focus, so it never steals <kbd>Ctrl</kbd>+<kbd>Z</kbd> from the composer or text fields |
| **Fuzzy ranking** | Contiguous matches and word-boundary hits rank above scattered matches; `CLL` finds `…/CLL/` before `Cycle/Loaner/List` |
| **Recent folders** | Empty search shows your most-recently-used folders first |
| **★ pin** | Star a folder in the palette to pin it to the top bar |
| **Pinned bar** | Click to jump · drag selected messages to move · right-click to unpin |
| **Rebindable shortcuts** | Options page or *Manage Extension Shortcuts* |

Shortcuts default to `Ctrl+.` / `Ctrl+Shift+.` to avoid collisions with
Thunderbird built-ins and AltGr combinations on non-US keyboards.
Undo is fixed to <kbd>Ctrl</kbd>+<kbd>Z</kbd> (<kbd>⌘</kbd>+<kbd>Z</kbd> on
macOS) and is not a global `commands` shortcut on purpose — see
[Why an experiment for the bar?](#why-an-experiment-for-the-bar).

---

## Install

### Quick try (temporary — cleared on restart)

1. **Tools → Add-ons and Themes** (or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>)
2. Cog ⚙ → **Debug Add-ons** (or open `about:debugging`)
3. **Load Temporary Add-on…** → select `manifest.json`

### Permanent (unsigned, personal use)

Thunderbird requires signed add-ons by default. To install unsigned:

1. Open `about:config` and set `xpinstall.signatures.required` → `false`.
2. Build the `.xpi` from the repo root:
   ```bash
   zip -r ../folder-jump.xpi manifest.json background.js popup.* options.* api icons
   ```
   or on PowerShell:
   ```powershell
   Compress-Archive -Path .\manifest.json,.\background.js,.\popup.*,.\options.*,.\api,.\icons -DestinationPath ..\folder-jump.zip -Force
   Move-Item -Force ..\folder-jump.zip ..\folder-jump.xpi
   ```
3. **Add-ons Manager** → cog ⚙ → **Install Add-on From File…** → pick `folder-jump.xpi`.

### Configuring shortcuts

Two places, both work:

- **Options page:** Add-ons Manager → Folder Jump → *Preferences*
  (click a field, press the key combo).
- **Manage Extension Shortcuts:** Add-ons Manager → cog ⚙ → same name.

Only the two palette shortcuts are rebindable. Undo (<kbd>Ctrl</kbd>+<kbd>Z</kbd>)
is handled by the experiment so it can be scoped to the mail window.

---

## Releases (GitHub Actions)

This repo ships two workflows:

- `.github/workflows/ci.yml` — builds an unsigned XPI on every push/PR
  and uploads it as a workflow artifact.
- `.github/workflows/release.yml` — on a `v*` tag push, builds the XPI
  and attaches it to a GitHub Release.

Since Thunderbird requires signed add-ons by default and this project
is **self-hosted** (not published to addons.thunderbird.net), users
installing the XPI must flip `xpinstall.signatures.required` to `false`
in `about:config`. See the install section above.

### Cutting a release

```bash
# 1. Bump manifest.json "version" (e.g. 1.0.1 → 1.0.2)
# 2. Commit
git commit -am "Release v1.0.2"
# 3. Tag and push
git tag v1.0.2
git push origin main --tags
```

The workflow verifies the tag matches `manifest.json`, builds the XPI,
and publishes a GitHub Release with auto-generated notes.

---

## Development

### File layout

```
folder-jump/
├── manifest.json          WebExtension manifest (MV2, Thunderbird 115+)
├── background.js          Command handler, folder fetching, action routing
├── popup.html/css/js      Fuzzy-finder palette (VS Code dark theme)
├── options.html/css/js    Shortcut-rebinding preferences page
├── api/
│   ├── schema.json        Experiment API schema
│   └── implementation.js  Privileged code: injects pinned bar, hooks Ctrl+Z, fires events
└── icons/
    └── icon.svg           Extension icon (dark folder + arrow)
```

### API references

| Topic | Docs |
|---|---|
| `browser.accounts.list(includeSubFolders)` | https://webextension-api.thunderbird.net/en/stable/accounts.html |
| `browser.messages.move(ids, destination)` | https://webextension-api.thunderbird.net/en/stable/messages.html |
| `browser.mailTabs.update` / `getSelectedMessages` | https://webextension-api.thunderbird.net/en/stable/mailTabs.html |
| `browser.messageDisplay.getDisplayedMessages` | https://webextension-api.thunderbird.net/en/stable/messageDisplay.html |
| `browser.commands` (shortcuts) | https://webextension-api.thunderbird.net/en/stable/commands.html |
| WebExtension Experiments | https://webextension-api.thunderbird.net/en/mv3/guides/experiments.html |

### Why an experiment for the bar?

There is no stable MailExtension API for injecting persistent UI into
Thunderbird's 3-pane window. The `messenger_window_scripts` manifest
key does **not** exist. The experiment in `api/implementation.js` is
the documented path — it grants access to Thunderbird's privileged JS
context (`Services.wm`, chrome DOM, `nsIWindowWatcher`, etc.).

The same experiment also hosts the <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo hook.
A `commands` shortcut would be the "proper" API, but command shortcuts are
global to every Thunderbird window: bound to <kbd>Ctrl</kbd>+<kbd>Z</kbd> it
swallows undo in the composer, the quick-filter box and every other text
field. The experiment instead adds a capturing `keydown` listener to
`mail:3pane` windows only and steps aside when the active tab is not a mail
tab, when focus is in an editable element, or when there is nothing to undo
(`folderjump.setUndoAvailable(false)`) — in which case Thunderbird's own
undo runs as usual.

Moves triggered from the palette are fire-and-forget: the background replies
to the popup immediately and lets `messages.move()` finish on its own. That
call only resolves after the server round-trip, and for IMAP/EWS/OWL that can
take a few seconds (especially when the message body is still being
downloaded on the same connection) — the add-on can't speed the round-trip
up, but it no longer keeps the palette open while waiting.

### Debugging

- Open the **Browser Console** (Tools → Developer Tools → Browser Console,
  or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd>) — all log output is
  prefixed `[FolderJump]`.
- Reload quickly via `about:debugging` → this extension → **Reload**.

---

## Known limitations

| Limitation | Detail |
|---|---|
| **Single mailbox scope** | The palette lists folders from the *current* account only (the account owning the displayed message or folder). |
| **Bar position** | Fixed to the top of the window (`position: fixed; top: 0`). It sits above the tab strip when the DOM anchor isn't found. |
| **Drag-and-drop** | The drop handler reads selected messages from the list — select messages *before* dragging to the bar. |
| **Thunderbird version** | Requires 115+. Some internal APIs shift on 128+; test on your build. |
| **Move latency** | The palette closes immediately, but the message only leaves the list once the backend (IMAP/EWS/OWL) has completed the move — that can take a few seconds, e.g. while a large message is still downloading. Compare with a drag-and-drop move in Thunderbird itself: if that is equally slow, it's the server/backend, not the add-on. |
| **Undo scope** | <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo only listens in the main mail window (mail tabs, non-editable focus). Moves done from a standalone message window can still be undone from the main window afterwards. History is per session (last 25 moves). |
| **Exchange via OWL** | OWL accounts work for move/jump. Thunderbird's built-in undo doesn't reverse OWL moves (OWL doesn't register undoable transactions), but the add-on's own <kbd>Ctrl</kbd>+<kbd>Z</kbd> does. |
| **Signature for ATN listing** | Experiments face stricter ATN review; for internal use, self-sign or disable `xpinstall.signatures.required`. |

---

## License

MIT. See `LICENSE` (add one if publishing publicly).

## Contributing

Issues and PRs welcome. Please include your Thunderbird version and OS
in bug reports; mail-account backend (IMAP / POP / Exchange-OWL / Owl)
also matters when move/jump behaves oddly.
