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
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>.</kbd> | Open the palette and **move** the open message |
| **Fuzzy ranking** | Contiguous matches and word-boundary hits rank above scattered matches; `CLL` finds `…/CLL/` before `Cycle/Loaner/List` |
| **Recent folders** | Empty search shows your most-recently-used folders first |
| **★ pin** | Star a folder in the palette to pin it to the top bar |
| **Pinned bar** | Click to jump · drag selected messages to move · right-click to unpin |
| **Rebindable shortcuts** | Options page or *Manage Extension Shortcuts* |

Shortcuts default to `Ctrl+.` / `Ctrl+Shift+.` to avoid collisions with
Thunderbird built-ins and AltGr combinations on non-US keyboards.

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
   Compress-Archive -Path .\manifest.json,.\background.js,.\popup.*,.\options.*,.\api,.\icons -DestinationPath ..\folder-jump.xpi -Force
   ```
3. **Add-ons Manager** → cog ⚙ → **Install Add-on From File…** → pick `folder-jump.xpi`.

### Configuring shortcuts

Two places, both work:

- **Options page:** Add-ons Manager → Folder Jump → *Preferences*
  (click a field, press the key combo).
- **Manage Extension Shortcuts:** Add-ons Manager → cog ⚙ → same name.

---

## Publishing to [addons.thunderbird.net](https://addons.thunderbird.net) (ATN)

ATN accepts WebExtension Experiments but reviews them more strictly
than pure MailExtensions, since an experiment runs with privileged
access. Expect a longer review cycle and possible rework requests.

Steps:

1. **Create an ATN account** at https://addons.thunderbird.net and verify email.
2. **Bump the version** in `manifest.json` for every upload (ATN rejects duplicate versions).
3. **Build the XPI** (same `zip` command as above). Keep the archive
   under 10 MB and ensure `manifest.json` is at the *root* of the zip,
   not inside a subfolder.
4. **Submit** via *Developer Hub → Submit a New Add-on*:
   - Choose **On this site** for public listing (or **On your own** to
     get a signed XPI you distribute yourself — recommended while
     iterating).
   - Upload the XPI, pick supported Thunderbird versions.
   - Provide a source-code link (GitHub repo) — required for any
     add-on using experiments.
5. **Respond to the reviewer** — they usually ask about the privileged
   code in `api/implementation.js` and why a standard MailExtension API
   isn't sufficient.

See the official guide: https://extensionworkshop.com/documentation/publish/submitting-an-add-on/

---

## Automated releases (GitHub Actions)

This repo ships two workflows:

- `.github/workflows/ci.yml` — builds an unsigned XPI on every push/PR.
- `.github/workflows/release.yml` — builds **and signs** the XPI via
  ATN's unlisted channel, then attaches it to a GitHub Release.

Signed via the unlisted channel means the resulting XPI installs on
any Thunderbird without requiring users to flip
`xpinstall.signatures.required`.

### One-time setup

1. **Get ATN API credentials**
   Log in at https://addons.thunderbird.net → *Developer Hub* →
   *Manage API Keys*. Generate a JWT issuer + secret.

2. **Add them as GitHub secrets**
   Repo → *Settings* → *Secrets and variables* → *Actions* → *New secret*:
   - `ATN_JWT_ISSUER` — the "JWT issuer" string
   - `ATN_JWT_SECRET` — the "JWT secret" string

3. **Publish the add-on listing once** (first time only)
   ATN requires the add-on ID (`folder-jump@personal` in
   `manifest.json`) to be registered under your account before the
   signing API will accept uploads. Submit once manually via the
   Developer Hub (pick *On your own* / unlisted). After that, all
   future version uploads are handled by the workflow.

### Cutting a release

```bash
# 1. Bump manifest.json "version" (e.g. 1.0.0 → 1.0.1)
# 2. Commit
git commit -am "Release v1.0.1"
# 3. Tag and push
git tag v1.0.1
git push origin main --tags
```

The `release.yml` workflow:

1. Verifies the tag matches `manifest.json` version.
2. Runs `web-ext lint` (non-blocking — experiments trip warnings).
3. Calls `web-ext sign` against ATN (`--channel=unlisted`).
4. Attaches the signed `.xpi` to a GitHub Release with auto-generated notes.

Users can now download the XPI from the Releases page and drag it into
Thunderbird — no preferences changes needed.

### Alternative: fully public ATN listing

If you want the add-on discoverable on ATN (not just self-hosted), drop
`--channel=unlisted` from `release.yml` or change it to `listed`.
Expect manual review; the first version must still be submitted
through the Developer Hub UI.

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
│   └── implementation.js  Privileged code: injects pinned bar, fires events
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
| **Exchange via OWL** | OWL accounts work for move/jump, but Thunderbird's undo (<kbd>Ctrl</kbd>+<kbd>Z</kbd>) does not reverse moves because OWL doesn't register them as undoable transactions. |
| **Signature for ATN listing** | Experiments face stricter ATN review; for internal use, self-sign or disable `xpinstall.signatures.required`. |

---

## License

MIT. See `LICENSE` (add one if publishing publicly).

## Contributing

Issues and PRs welcome. Please include your Thunderbird version and OS
in bug reports; mail-account backend (IMAP / POP / Exchange-OWL / Owl)
also matters when move/jump behaves oddly.
