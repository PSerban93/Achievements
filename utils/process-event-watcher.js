"use strict";

const nativeProvider = require("./windows-process-native-provider");

function startProcessEventWatcher(options = {}) {
  return nativeProvider.subscribe(options);
}

function subscribeLumaPlayRegistryEvents(options = {}) {
  const {
    subscribeLumaPlayRegistryEvents: subscribeDedicatedLumaPlayHost,
  } = require("./lumaplay-event-watcher");
  return subscribeDedicatedLumaPlayHost(options);
}

module.exports = {
  startProcessEventWatcher,
  subscribeLumaPlayRegistryEvents,
};
