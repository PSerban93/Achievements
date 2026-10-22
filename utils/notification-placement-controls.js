"use strict";

window.createNotificationPlacementControls = function (options) {
  const placement = window.AchievementsNotificationPlacement;
  const states = new Map();
  let saves = Promise.resolve();
  const text = (key, fallback) => options.translate(`settings.notificationPlacement.${key}`, fallback);
  function read(profileKey) {
    const state = states.get(profileKey);
    return state ? Object.fromEntries(["X", "Y"].map((axis) => [
      `notificationOffset${axis}`, placement.normalizeOffset(state[axis].number.value),
    ])) : {};
  }
  function save(profile) {
    const state = states.get(profile.key);
    state.dirty = true;
    const revision = ++state.revision;
    const values = read(profile.key);
    const patch = Object.fromEntries(["X", "Y"].map((axis) => [placement.preferenceKey(profile.key, axis), values[`notificationOffset${axis}`]]));
    saves = saves.then(async () => {
      await options.save(patch);
      if (state.revision === revision) state.dirty = false;
    }).catch((error) => console.error("Notification placement save failed:", error));
  }
  function refresh() {
    for (const profile of options.profiles) {
      const state = states.get(profile.key);
      if (!state) continue;
      const anchor = placement.axes(options.position(profile));
      const labels = {
        X: anchor.horizontal === "left" ? ["fromLeft", "Additional distance from left"]
          : anchor.horizontal === "right" ? ["fromRight", "Additional distance from right"]
          : ["horizontalCenter", "Horizontal offset (− left / + right)"],
        Y: anchor.vertical === "top" ? ["fromTop", "Additional distance from top"]
          : anchor.vertical === "bottom" ? ["fromBottom", "Additional distance from bottom"]
          : ["verticalCenter", "Vertical offset (− up / + down)"],
      };
      const disabled = options.disabled(profile);
      state.group.classList.toggle("is-disabled", disabled);
      for (const axis of ["X", "Y"]) {
        const control = state[axis];
        const centered = (axis === "X" ? anchor.horizontal : anchor.vertical) === "center";
        const label = `${text(...labels[axis])} (px)`;
        control.label.textContent = label;
        for (const input of [control.range, control.number]) {
          input.min = String(centered ? -placement.limit : 0);
          input.setAttribute("aria-label", label);
          input.disabled = disabled;
        }
        const value = Math.max(Number(control.number.min), placement.normalizeOffset(control.number.value));
        control.range.value = control.number.value = String(value);
      }
      state.reset.disabled = disabled;
    }
  }
  function hydrate(prefs = {}) {
    for (const profile of options.profiles) {
      const state = states.get(profile.key);
      if (!state || state.dirty) continue;
      const values = placement.read(profile.key, prefs);
      for (const axis of ["X", "Y"]) state[axis].range.value = state[axis].number.value = String(values[`notificationOffset${axis}`]);
    }
    refresh();
  }
  for (const profile of options.profiles) {
    const timing = options.durationControl(profile)?.closest(".settings-slider");
    if (!timing) continue;
    const group = document.createElement("div");
    group.className = "notification-placement-controls";
    group.dataset.notificationPlacementProfile = profile.key;
    const heading = document.createElement("h4");
    heading.dataset.i18n = "settings.notificationPlacement.title";
    heading.textContent = text("title", "Notification Placement");
    group.appendChild(heading);
    const state = { group, dirty: false, revision: 0 };
    states.set(profile.key, state);
    for (const axis of ["X", "Y"]) {
      const row = document.createElement("div");
      row.className = "settings-slider";
      const label = document.createElement("label");
      const pair = document.createElement("div");
      pair.className = "slider-control notification-placement-pair";
      const range = document.createElement("input");
      range.type = "range";
      range.id = `settings-${profile.key}NotificationOffset${axis}Slider`;
      const number = document.createElement("input");
      number.type = "number";
      number.id = `settings-${profile.key}NotificationOffset${axis}Input`;
      label.htmlFor = number.id;
      for (const input of [range, number]) {
        input.min = String(-placement.limit);
        input.max = String(placement.limit);
        input.step = "1";
        input.value = "0";
        input.addEventListener("input", () => {
          state.dirty = true;
          if (input === number && (number.value === "" || !number.validity.valid)) return;
          range.value = number.value = String(placement.normalizeOffset(input.value));
        });
        input.addEventListener("change", () => {
          range.value = number.value = String(Math.max(Number(input.min), placement.normalizeOffset(input.value)));
          save(profile);
        });
      }
      state[axis] = { range, number, label };
      pair.append(range, number);
      row.append(label, pair);
      group.appendChild(row);
    }
    const hint = document.createElement("p");
    hint.className = "notification-placement-hint";
    hint.dataset.i18n = "settings.notificationPlacement.hint";
    hint.textContent = text("hint", "Additional distance in logical px, independent of Scale. Center offsets can be negative. 0 keeps the current position.");
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "settings-action-btn";
    reset.dataset.i18n = "settings.notificationPlacement.reset";
    reset.textContent = text("reset", "Reset placement");
    reset.addEventListener("click", () => {
      for (const axis of ["X", "Y"]) state[axis].range.value = state[axis].number.value = "0";
      save(profile);
    });
    state.reset = reset;
    group.append(hint, reset);
    timing.after(group);
    options.positionControl(profile)?.addEventListener("change", () => { refresh(); save(profile); });
    if (profile.presetId) document.getElementById(profile.presetId)?.addEventListener("change", refresh);
  }
  return {
    read, refresh, hydrate, flush: () => saves,
    collect: () => Object.fromEntries(options.profiles.flatMap((profile) => {
      const values = read(profile.key);
      return ["X", "Y"].map((axis) => [placement.preferenceKey(profile.key, axis), values[`notificationOffset${axis}`] ?? 0]);
    })),
  };
};
