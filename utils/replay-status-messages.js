"use strict";
// Shared by the settings renderer and recording failure notifications. This
// only explains known diagnostic states; it never chooses or changes a hotkey.
(function(root) {
  function getReplayStatusIssue(result,translate=(key,fallback)=>fallback) {
    if(!result || result.ok)return null;
    const parts=[];
    if(result.code==="replay-hotkey-invalid") {
      if(result.hotkeyIssue==="missing")parts.push(translate("recordReplay.amdHotkeyMissing","AMD Save Instant Replay shortcut is missing."));
      else if(["unsupported-format","unsupported-key","unsupported-modifiers"].includes(result.hotkeyIssue))
        parts.push(translate("recordReplay.amdHotkeyUnsupported","Achievements cannot interpret the AMD Save Instant Replay shortcut it read."));
      if(parts.length)parts.push(translate("recordReplay.amdHotkeyHelp","Clear and reassign Save Instant Replay in AMD Adrenalin, then click Check replay settings. If the issue persists, share records.log."));
    }
    const labels={instantReplay:["instantReplayOff","Instant Replay is turned off."],desktopCapture:["desktopCaptureOff","Desktop Capture / Record Desktop is turned off."],
      recordingFeature:["recordingFeatureOff","The GPU recording feature is turned off."],recordingService:["recordingServiceOff","The GPU recording service is not running."],
      hotkeys:["hotkeysOff","AMD hotkeys are disabled."]};
    const disabled=Object.entries(labels).filter(([key])=>result.prerequisites?.[key]===false).map(([,label])=>translate(`recordReplay.${label[0]}`,label[1]));
    if(result.apiCode==="overlay_not_available")disabled.push(translate("recordReplay.overlayNotReady","NVIDIA In-Game Overlay is not ready. Check that it is enabled and running."));
    if(!disabled.length && (result.code==="replay-not-enabled" || result.code==="replay-api-status"))
      disabled.push(translate("recordReplay.settingsUnverified","The required GPU recording settings could not all be verified."));
    if(disabled.length)parts.push(...disabled,translate("recordReplay.enableHelp","Check these settings in your GPU software, then click Check replay settings. Achievements will not change them automatically."));
    return parts.length ? parts.join("\n") : null;
  }
  const api={getReplayStatusIssue};
  if(typeof module==="object" && module.exports)module.exports=api;
  if(root)root.ReplayStatusMessages=api;
})(typeof window!=="undefined" ? window : null);
