"use strict";

window.Dashboard3DControls = {
  create({ container, getPreferences, save, preview }) {
    const settings = window.Dashboard3DSettings;
    const controls = new Map(), dirty = new Set(), revisions = new Map();
    let saves = Promise.resolve();
    function read() {
      return settings.normalize(Object.fromEntries([...controls].map(([key, control]) => [key, control.number.value])));
    }
    function hydrate(preferences) {
      const values = settings.normalize(preferences);
      const enabled = preferences.dashboard3dEffects === true;
      container.hidden = !enabled;
      for (const [key, control] of controls) {
        if (!dirty.has(key)) control.range.value = control.number.value = String(values[key]);
        control.range.disabled = control.number.disabled = !enabled;
      }
      reset.disabled = !enabled;
    }
    function persist(patch) {
      const tickets = Object.keys(patch).map(key => {
        dirty.add(key);
        const ticket = (revisions.get(key) || 0) + 1;
        revisions.set(key, ticket);
        return [key, ticket];
      });
      saves = saves.then(() => save(patch)).catch(error => {
        console.error("Dashboard 3D settings save failed:", error);
      }).finally(() => {
        for (const [key, ticket] of tickets) if (revisions.get(key) === ticket) dirty.delete(key);
        hydrate(getPreferences());
        preview(read());
      });
    }
    for (const field of settings.fields) {
      const group = document.createElement("div"); group.className = "dashboard-3d-control";
      const label = document.createElement("label");
      label.id = `settings-${field.key}Label`; label.htmlFor = `settings-${field.key}`;
      const text = document.createElement("span"); text.dataset.i18n = `settings.dashboard3d.${field.label}`;
      text.textContent = window.i18nUi?.getString(text.dataset.i18n, field.text) || field.text;
      label.append(text, document.createTextNode(` (${field.unit})`));
      const row = document.createElement("div"); row.className = "dashboard-3d-control-inputs";
      const range = document.createElement("input"), number = document.createElement("input");
      for (const [input, type, suffix] of [[range, "range", ""], [number, "number", "Number"]]) {
        input.type = type; input.id = `settings-${field.key}${suffix}`;
        input.min = String(field.min); input.max = String(field.max); input.step = String(field.step);
        input.value = String(field.value); input.setAttribute("aria-labelledby", label.id);
        input.addEventListener("input", () => {
          dirty.add(field.key);
          revisions.set(field.key, (revisions.get(field.key) || 0) + 1);
          number.value = input.value;
          range.value = String(settings.normalize({ [field.key]: input.value })[field.key]);
          preview(read());
        });
        input.addEventListener("change", () => {
          const value = settings.normalize({ [field.key]: input.value })[field.key];
          number.value = range.value = String(value);
          persist({ [field.key]: value });
        });
      }
      controls.set(field.key, { range, number });
      row.append(range, number); group.append(label, row); container.append(group);
    }
    const reset = document.createElement("button"); reset.type = "button";
    reset.id = "settings-dashboard3dReset";
    reset.dataset.i18n = "settings.dashboard3d.reset";
    reset.textContent = window.i18nUi?.getString(reset.dataset.i18n, "Reset 3D effects") || "Reset 3D effects";
    reset.addEventListener("click", () => {
      for (const [key, control] of controls) control.range.value = control.number.value = String(settings.defaults[key]);
      preview(read()); persist(settings.defaults);
    });
    container.append(reset);
    return { read, hydrate };
  },
};
