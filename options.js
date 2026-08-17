"use strict";

const DEFAULTS = {
  "jump-to-folder": "Ctrl+Period",
  "move-to-folder": "Ctrl+Shift+Period"
};

const FIELDS = {
  "jump-to-folder": "sc-jump",
  "move-to-folder": "sc-move"
};

const statusEl = document.getElementById("status");

function setStatus(msg, isError) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", !!isError);
  if (msg) { setTimeout(() => { if (statusEl.textContent === msg) { statusEl.textContent = ""; } }, 2500); }
}

async function loadShortcuts() {
  const cmds = await browser.commands.getAll();
  for (const c of cmds) {
    const inp = document.getElementById(FIELDS[c.name]);
    if (inp) { inp.value = c.shortcut || ""; }
  }
}

// Convert a KeyboardEvent to WebExtension shortcut string, or null if invalid.
function eventToShortcut(e) {
  const mods = [];
  if (e.ctrlKey)  { mods.push("Ctrl"); }
  if (e.altKey)   { mods.push("Alt"); }
  if (e.shiftKey) { mods.push("Shift"); }

  let key = e.key;
  if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") { return null; }

  // Normalise to WebExtension key names
  const map = {
    " ": "Space", "ArrowUp": "Up", "ArrowDown": "Down",
    "ArrowLeft": "Left", "ArrowRight": "Right",
    ".": "Period", ",": "Comma", "-": "Minus",
    "Escape": null, "Backspace": null
  };
  if (key in map) { key = map[key]; }
  if (key === null) { return null; }

  if (key.length === 1) { key = key.toUpperCase(); }
  // Function keys (F1..F24), Home/End/PageUp/PageDown/Insert/Delete/Tab pass through.

  if (mods.length === 0 && !/^F\d+$/.test(key)) { return null; } // need a modifier
  return [...mods, key].join("+");
}

async function updateShortcut(name, shortcut) {
  try {
    await browser.commands.update({ name, shortcut });
    setStatus(`Saved: ${name} → ${shortcut || "(none)"}`, false);
  } catch (err) {
    setStatus(`Failed: ${err.message}`, true);
    await loadShortcuts();
  }
}

for (const [name, id] of Object.entries(FIELDS)) {
  const inp = document.getElementById(id);

  inp.addEventListener("keydown", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape")    { inp.blur(); return; }
    if (e.key === "Backspace") {
      inp.value = "";
      await browser.commands.reset(name).catch(() => {});
      await browser.commands.update({ name, shortcut: "" }).catch(() => {});
      setStatus(`Cleared: ${name}`, false);
      return;
    }

    const sc = eventToShortcut(e);
    if (!sc) { return; }
    inp.value = sc;
    await updateShortcut(name, sc);
  });
}

document.querySelectorAll("button.reset").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const name = btn.dataset.reset;
    try {
      await browser.commands.reset(name);
    } catch (_) {
      await browser.commands.update({ name, shortcut: DEFAULTS[name] });
    }
    await loadShortcuts();
    setStatus(`Reset ${name}`, false);
  });
});

loadShortcuts();
