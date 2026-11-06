"use strict";

// Renderer-only text entry. No credentials or draft text leave this module.
(() => {
  let setting;
  let enabled = false, modal, display, keys, target, originalFocus, draft = "", start = 0, end = 0;
  let upper = false, symbols = false, accents = false, frame = 0, nextMove = 0, previousDirection = "", previousButtons = [], saving = Promise.resolve();
  const background = new Map();
  let editor, mirror, mirrorContent, cursor, navigationX = null;
  let preferenceRevision = 0, preferencePending = false;
  const controller = window.AchievementsMainControllerNavigation.createInputSession();
  const text = (key, fallback) => window.i18nUi?.getString(({cancel:"appConfirmCancelBtn",clear:"dashboard.selection.clear",done:"appConfirmOkBtn"})[key] || "osk." + key, fallback) || fallback;
  const isOpen = () => !!modal && !modal.hidden;
  const eligible = el => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement && ["text", "search", "password", "email", "url", "tel"].includes(el.type);
  const available = el => eligible(el) && el.isConnected && !el.disabled && !el.readOnly && !el.closest("[hidden],.hidden") &&
    el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const make = (tag, cls, value) => { const el = document.createElement(tag); el.className = cls; if (value != null) el.textContent = value; return el; };
  function renderHint(id = "") {
    const ps = /dualshock|dualsense|playstation|sony/i.test(id);
    const rows = [[[["↑↓←→", "kbd"], ["D-pad", "btn stick"]], window.i18nUi?.getString("shortcutsCommonMove", "Move") || "Move"],
      [[["Enter", "kbd"], [ps ? "✕" : "A", ps ? "btn ps-cross" : "btn xb-a"]], window.i18nUi?.getString("shortcutsCommonSelect", "Select") || "Select"],
      [[[ps ? "☐" : "X", ps ? "btn ps-square" : "btn xb-x"]], text("backspace", "Backspace")],
      [[[ps ? "△" : "Y", ps ? "btn ps-triangle" : "btn xb-y"]], text("space", "Space")],
      [[[ps ? "Options" : "Menu", "btn stick"]], text("done", "OK")],
      [[["Esc", "kbd"], [ps ? "◯" : "B", ps ? "btn ps-circle" : "btn xb-b"]], text("cancel", "Cancel")]];
    modal.querySelector(".osk-hint").replaceChildren(...rows.map(([tokens, label]) => {
      const group=make("span","ctl " + (ps?"ctl-ps":"ctl-xb"));
      for(const [value,cls] of tokens)group.append(make(cls==="kbd"?"kbd":"span",cls==="kbd"?"":cls,value));
      group.append(document.createTextNode(label)); return group;
    }));
  }
  function hydrate(prefs) { if (!preferencePending) enabled = prefs?.onScreenKeyboardEnabled === true; if (setting) setting.checked = enabled; if (!enabled) close(); }
  function mountSettings(parent) {
    if (setting) return;
    const control = make("div", "osk-setting"), row = make("div", "checkbox-control");
    setting = make("input", ""); setting.type = "checkbox"; setting.id = "settings-onScreenKeyboardCheckbox"; setting.checked = enabled;
    const label = make("label", "", text("enabled", "On-screen keyboard")); label.htmlFor = setting.id; label.dataset.i18n = "osk.enabled";
    const help = make("p", "hint", text("help", "On a text field, press Enter / A / ✕ or Ctrl+Shift+K. For multiline fields, use Ctrl+Shift+K or the controller.")); help.dataset.i18n = "osk.help";
    row.append(setting, label); control.append(row, help); parent.append(control);
    setting.addEventListener("change", saveSetting);
  }
  function ensureCursorVisible() {
    if (!isOpen() || !cursor) return;
    mirror.style.width = display.clientWidth + "px";
    const bounds = mirror.getBoundingClientRect(), rect = cursor.getBoundingClientRect();
    if (rect.right > bounds.right - 12) mirror.scrollLeft += rect.right - bounds.right + 12;
    else if (rect.left < bounds.left + 12) mirror.scrollLeft -= bounds.left + 12 - rect.left;
    if (rect.bottom > bounds.bottom - 8) mirror.scrollTop += rect.bottom - bounds.bottom + 8;
    else if (rect.top < bounds.top + 8) mirror.scrollTop -= bounds.top + 8 - rect.top;
    display.scrollLeft = mirror.scrollLeft; display.scrollTop = mirror.scrollTop;
  }
  function renderCursor() {
    const visible = value => target?.type === "password" ? Array.from(value, () => "•").join("") : value;
    const before = make("span", "osk-text-before", visible(draft.slice(0, start)));
    const selected = make("span", "osk-text-selection", visible(draft.slice(start, end)));
    cursor = make("span", "osk-caret"); cursor.dataset.offset = String(end);
    mirrorContent.replaceChildren(before, selected, cursor, document.createTextNode(visible(draft.slice(end))));
    ensureCursorVisible();
  }
  function update() {
    display.value = draft; display.setSelectionRange(start, end);
    renderCursor();
  }
  function insert(value, remove = false) {
    if (!available(target)) { close(); return; }
    if (remove && start === end && start > 0) start -= Array.from(draft.slice(0, start)).at(-1).length;
    const next = draft.slice(0, start) + value + draft.slice(end);
    if (target.maxLength >= 0 && next.length > target.maxLength && next.length > draft.length) return;
    draft = next; start += value.length; end = start; update();
  }
  function caret(direction) {
    if (direction < 0) start = start !== end ? start : Math.max(0, start - (Array.from(draft.slice(0, start)).at(-1)?.length || 0));
    else start = start !== end ? end : Math.min(draft.length, end + (Array.from(draft.slice(end))[0]?.length || 0));
    end = start; update();
  }
  function close() {
    if (!isOpen()) return;
    modal.hidden = true; modal.inert = true; modal.setAttribute("aria-hidden", "true"); cancelAnimationFrame(frame); controller.suspend();
    for (const [el, inert] of background) if (el.isConnected) el.inert = inert;
    background.clear(); draft = ""; display.value = ""; mirrorContent.replaceChildren(); cursor = null; target = null;
    if (originalFocus?.isConnected && !originalFocus.closest("[inert]")) originalFocus.focus({ preventScroll: true });
    originalFocus = null;
  }
  function done() {
    if (!available(target)) { close(); return; }
    const field = target, value = draft, cursor = start;
    if (field.value !== value) {
      const allowed = field.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertReplacementText", data: null }));
      if (!allowed) return;
      close(); field.value = value;
      field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: null }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    } else close();
    try { field.setSelectionRange(cursor, cursor); } catch { /* Email inputs have no selection API. */ }
  }
  function key(value, id, run, wide = false) {
    const button = make("button", "osk-key" + (wide ? " osk-key-wide" : ""), value); button.type = "button";
    button.dataset.oskKey = id; button.addEventListener("click", run); return button;
  }
  function render() {
    navigationX = null;
    const focused = modal.contains(document.activeElement) ? document.activeElement.dataset.oskKey : null;
    const rows = symbols ? ["1234567890", "!@#$%^&*()", "-_=+[]{}", "\\/:;\"'<>?.,"] : ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
    keys.replaceChildren();
    for (const [index, values] of rows.entries()) {
      const row = make("div", "osk-row");
      for (const [column, character] of Array.from(values).entries()) {
        const value = upper && !symbols ? character.toUpperCase() : character;
        row.append(key(value, index + "-" + column, () => insert(value)));
      }
      keys.append(row);
    }
    if (accents && !symbols) {
      const row = make("div", "osk-row");
      for (const character of "ăâîșțàáäçèéêñöüß") { const value = upper ? character.toUpperCase() : character; row.append(key(value, "accent-" + character, () => insert(value))); }
      keys.append(row);
    }
    const edit = make("div", "osk-row osk-edit-row"), actions = make("div", "osk-row osk-action-row");
    const shift = key("⇧", "shift", () => { upper = !upper; render(); }); shift.setAttribute("aria-pressed", String(upper)); shift.setAttribute("aria-label", text("shift", "Uppercase"));
    edit.append(shift, key(symbols ? "ABC" : "123", "layout", () => { symbols = !symbols; render(); }),
      key("ÀÉ", "accents", () => { accents = !accents; symbols = false; render(); }),
      key("←", "caret-left", () => caret(-1)), key(text("space", "Space"), "space", () => insert(" "), true),
      key("→", "caret-right", () => caret(1)), key("⌫", "backspace", () => insert("", true)));
    edit.lastChild.setAttribute("aria-label", text("backspace", "Backspace"));
    if (target instanceof HTMLTextAreaElement) edit.append(key("↵", "newline", () => insert("\n")));
    actions.append(key(text("clear", "Clear"), "clear", () => { draft = ""; start = end = 0; update(); }),
      key(text("cancel", "Cancel"), "cancel", close), key(text("done", "Done"), "done", done));
    actions.lastChild.classList.add("osk-done"); keys.append(edit, actions);
    if (focused) [...keys.querySelectorAll("button")].find(el => el.dataset.oskKey === focused)?.focus({ preventScroll: true });
  }
  function create() {
    modal = make("div", "osk-modal"); modal.id = "onScreenKeyboardModal"; modal.hidden = true; modal.inert = true;
    modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-labelledby", "onScreenKeyboardTitle");
    const panel = make("section", "osk-panel"), header = make("header", "osk-header");
    const title = make("h3", "", ""); title.id = "onScreenKeyboardTitle";
    const closeButton = key("×", "close", close); closeButton.className = "settings-close-button"; closeButton.setAttribute("aria-label", text("cancel", "Cancel"));
    header.append(title, closeButton); display = make("textarea", "osk-display"); display.readOnly = true; display.rows = 2;
    editor = make("div", "osk-editor"); mirror = make("div", "osk-display-mirror"); mirror.setAttribute("aria-hidden", "true");
    mirrorContent = make("div", "osk-mirror-content"); mirror.append(mirrorContent); editor.append(display, mirror);
    new ResizeObserver(ensureCursorVisible).observe(editor);
    keys = make("div", "osk-keys");
    panel.append(header, editor, keys, make("div", "osk-hint", "")); modal.append(panel); document.body.append(modal);
    modal.addEventListener("pointerdown", event => { if (event.target === modal) close(); });
    keys.addEventListener("pointerdown", () => { navigationX = null; });
  }
  function open(field) {
    if (!enabled || isOpen() || !available(field) || field.closest("[inert]")) return false;
    if (!modal) create(); target = field; originalFocus = field;
    draft = field.value; start = field.selectionStart ?? draft.length; end = field.selectionEnd ?? start;
    upper = symbols = accents = false;
    // Password text stays masked in a password input, including in screenshots.
    const multiline = field instanceof HTMLTextAreaElement;
    const replacement = make(multiline ? "textarea" : "input", "osk-display");
    if (multiline) replacement.rows = 3; else replacement.type = field.type === "password" ? "password" : "text";
    replacement.readOnly = true; display.replaceWith(replacement); display = replacement;
    editor.dataset.multiline = String(multiline);
    if (multiline) display.wrap = "soft";
    mirror.scrollTop = mirror.scrollLeft = 0;
    display.addEventListener("select", () => { if (document.activeElement === display) { start = display.selectionStart; end = display.selectionEnd; renderCursor(); } });
    display.addEventListener("scroll", () => { mirror.scrollTop = display.scrollTop; mirror.scrollLeft = display.scrollLeft; });
    const label = field.labels?.[0]?.textContent?.trim() || field.getAttribute("aria-label") || field.placeholder || field.name || "";
    modal.querySelector("h3").textContent = text("title", "On-screen keyboard") + (label ? " · " + label.slice(0, 100) : "");
    display.setAttribute("aria-label", text("title", "On-screen keyboard"));
    delete modal.dataset.controllerId; renderHint();
    for (const el of document.body.children) if (el instanceof HTMLElement && el !== modal && el.id !== "titlebar") { background.set(el, el.inert); el.inert = true; }
    modal.inert = false; modal.hidden = false; modal.setAttribute("aria-hidden", "false"); update(); render(); keys.querySelector("button")?.focus({ preventScroll: true });
    controller.suspend(); previousButtons = []; previousDirection = ""; nextMove = 0; frame = requestAnimationFrame(poll); return true;
  }
  function move(direction) {
    const buttons = [...keys.querySelectorAll("button")].filter(el => !el.disabled && el.getClientRects().length);
    const current = document.activeElement;
    if (!buttons.includes(current)) { navigationX = null; buttons[0]?.focus({ preventScroll: true }); return; }
    // Use rendered rows, including rows wrapped by a narrow window or accent keys.
    const rows = [];
    for (const el of buttons.map(el => ({ el, rect: el.getBoundingClientRect() })).sort((a,b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)) {
      const y = el.rect.top + el.rect.height / 2;
      let row = rows.find(row => Math.abs(row.y - y) < 4);
      if (!row) { row = { y, items: [] }; rows.push(row); }
      row.items.push(el);
    }
    rows.sort((a,b)=>a.y-b.y); rows.forEach(row=>row.items.sort((a,b)=>a.rect.left-b.rect.left));
    const rowIndex = rows.findIndex(row => row.items.some(item => item.el === current)), row = rows[rowIndex];
    let next;
    if (direction === "LEFT" || direction === "RIGHT") {
      navigationX = null;
      const index = row.items.findIndex(item=>item.el===current);
      next = row.items[index + (direction === "LEFT" ? -1 : 1)]?.el;
    } else {
      const adjacent = rows[rowIndex + (direction === "UP" ? -1 : 1)];
      if (!adjacent) return;
      const rect = current.getBoundingClientRect(); navigationX ??= rect.left + rect.width / 2;
      const distance = rect => Math.max(rect.left-navigationX, navigationX-rect.right, 0);
      next = [...adjacent.items].sort((a,b) => distance(a.rect)-distance(b.rect) ||
        Math.abs(a.rect.left+a.rect.width/2-navigationX)-Math.abs(b.rect.left+b.rect.width/2-navigationX))[0]?.el;
    }
    if (next) {
      next.focus({ preventScroll: true });
      const panel = modal.querySelector(".osk-panel"), bounds = panel.getBoundingClientRect(), rect = next.getBoundingClientRect();
      if (rect.bottom > bounds.bottom - 12) panel.scrollTop += rect.bottom - bounds.bottom + 12;
      else if (rect.top < bounds.top + 12) panel.scrollTop -= bounds.top + 12 - rect.top;
    }
  }
  function action(command) {
    if (!isOpen()) return false;
    if (command === "BACK") close();
    else if (command === "CONFIRM") { if (document.activeElement?.tagName === "BUTTON" && modal.contains(document.activeElement)) document.activeElement.click(); else keys.querySelector("button")?.focus(); }
    else if (command === "PLAY") done();
    else if (command === "SEARCH" || command === "OPTIONS") insert("", true);
    else if (command === "MENU") insert(" ");
    else if (["UP","DOWN","LEFT","RIGHT"].includes(command)) move(command);
    return true;
  }
  function poll(now) {
    if (!isOpen()) return;
    if (!available(target)) { close(); return; }
    if (!document.hasFocus() || document.visibilityState === "hidden") { controller.suspend(); previousButtons = []; previousDirection = ""; }
    else {
      const sample = controller.sample(navigator.getGamepads?.() || [], now);
      if (sample.ready && sample.pad) {
        if (modal.dataset.controllerId !== sample.pad.id) { modal.dataset.controllerId=sample.pad.id; renderHint(sample.pad.id); }
        const buttons = sample.pad.buttons.map(button=>button.pressed === true);
        const pressed = index => buttons[index] && !previousButtons[index];
        if (pressed(1)) close(); else if (pressed(9)) done(); else if (pressed(0)) action("CONFIRM");
        else if (pressed(2)) insert("",true); else if (pressed(3)) insert(" "); else if (pressed(4)) caret(-1); else if (pressed(5)) caret(1);
        const [x,y] = sample.pad.axes, horizontal = Math.abs(x) > Math.abs(y);
        const direction = buttons[12] ? "UP" : buttons[13] ? "DOWN" : buttons[14] ? "LEFT" : buttons[15] ? "RIGHT" :
          Math.max(Math.abs(x),Math.abs(y)) <= .4 ? "" : horizontal ? x < 0 ? "LEFT" : "RIGHT" : y < 0 ? "UP" : "DOWN";
        if (isOpen() && direction && (direction!==previousDirection || now>=nextMove)) {
          const fresh = direction !== previousDirection; move(direction); nextMove=now+(fresh?350:110);
        }
        previousDirection=direction; previousButtons=buttons;
      }
    }
    if (isOpen()) frame=requestAnimationFrame(poll);
  }
  document.addEventListener("keydown", event => {
    if (!isOpen()) {
      if ((event.key === "Enter" && !event.ctrlKey && !event.altKey && !event.shiftKey && event.target instanceof HTMLInputElement || event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "k") && open(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); }
      return;
    }
    event.stopImmediatePropagation();
    if (event.key === "Tab") {
      navigationX = null;
      event.preventDefault(); const buttons=[...modal.querySelectorAll("button")], index=buttons.indexOf(document.activeElement);
      buttons[(index+(event.shiftKey?-1:1)+buttons.length)%buttons.length]?.focus({preventScroll:true});
    } else if (event.key === "Escape") { event.preventDefault(); close(); }
    else if (event.key === "Enter") { event.preventDefault(); if (event.ctrlKey) done(); else action("CONFIRM"); }
    else if (event.key === "Backspace" || event.key === "Delete") { event.preventDefault(); if(event.key==="Delete" && start===end) end=Math.min(draft.length,end+(Array.from(draft.slice(end))[0]?.length||0)); insert("",event.key==="Backspace"); }
    else if (event.key.startsWith("Arrow")) { event.preventDefault(); if(document.activeElement===display && ["ArrowLeft","ArrowRight"].includes(event.key)) caret(event.key==="ArrowLeft"?-1:1); else action(event.key.slice(5).toUpperCase()); }
    else if (event.ctrlKey && event.key.toLowerCase()==="a") { event.preventDefault(); start=0;end=draft.length;update(); }
    else if (event.key.length===1 && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); insert(event.key); }
  }, true);
  function saveSetting() {
    enabled=setting.checked; if(!enabled)close(); const value=enabled, ticket=++preferenceRevision; preferencePending=true;
    saving=saving.then(async()=>{
      await window.api.savePreferences({onScreenKeyboardEnabled:value});
      if(ticket===preferenceRevision){preferencePending=false;const prefs=await window.api.loadPreferences();window.__preferencesCache={...(window.__preferencesCache||{}),...prefs};hydrate(prefs);}
    }).catch(error=>{
      console.warn("on-screen-keyboard:preference-save-failed", error);
      if(ticket===preferenceRevision){preferencePending=false;void window.api.loadPreferences().then(hydrate).catch(console.warn);}
    });
  }
  window.OnScreenKeyboard={open,close,action,isOpen,isEditing:field=>isOpen()&&target===field,hydrate,mountSettings};
  void window.api.loadPreferences().then(hydrate).catch(console.warn);
})();
