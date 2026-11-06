"use strict";
(() => {
  let state={}, initialized=false, revision=0, status=null;
  const el=id=>document.getElementById(id);
  const t=(key,fallback)=>window.i18nUi?.getString(`recordReplay.${key}`,fallback) || fallback;
  const native=()=>el("settings-recordBackendSelect")?.value==="native";
  function render() {
    const isNative=native(); el("settings-replayControls").hidden=isNative;
    for(const id of ["settings-recordFpsSelect","settings-recordDurationSelect"]) {
      const field=el(id); if(field) field.closest(".settings-control").hidden=!isNative;
    }
    const hdr=el("settings-enableHdrRecordsCheckbox"); if(hdr) hdr.disabled=!isNative;
  }
  async function save(patch) {
    state={...state,...patch};
    await window.api.savePreferences(patch);
  }
  async function check() {
    if(native()) return;
    const token=++revision, button=el("settings-replayCheck"), output=el("settings-replayStatus");
    button.disabled=true; output.textContent=t("checking","Reading GPU replay settings…");
    try {
      const result=await window.api.getReplayStatus();
      if(token!==revision || native()) return;
      status=result;
      const issue=window.ReplayStatusMessages?.getReplayStatusIssue(result,(key,fallback)=>window.i18nUi?.getString(key,fallback) || fallback);
      output.textContent=result.ok ? `${t("ready","Replay settings detected")}: ${result.bufferSeconds}s\n${result.root}`
        : `${issue || t("unavailable","Replay is not ready. Check the prerequisites and records.log for details.")}\n${result.code || ""}`;
      el("settings-replayMonitorControl").hidden=!result.ok || !result.monitorVerificationRequired;
      el("settings-replayMonitorConfirmed").checked=result.ok && result.monitorConfirmed;
    } catch { if(token===revision) output.textContent=t("unavailable","Replay is not ready. Check the prerequisites and record.log for details."); }
    finally {if(token===revision) button.disabled=false;}
  }
  function snapshot() {
    if(!initialized) return {};
    return {recordBackend:el("settings-recordBackendSelect").value,recordReplayBeforeSeconds:Number(el("settings-replayBefore").value),
      recordReplayAfterSeconds:Number(el("settings-replayAfter").value),recordReplayMonitorSignature:state.recordReplayMonitorSignature || ""};
  }
  function init(prefs={}) {
    state={...prefs}; status=null; ++revision;
    const select=el("settings-recordBackendSelect"); if(!select) return;
    select.value=["nvidia","amd"].includes(prefs.recordBackend) ? prefs.recordBackend : "native";
    const half=Number(prefs.recordDurationSeconds||20)/2;
    el("settings-replayBefore").value=prefs.recordReplayBeforeSeconds ?? half;
    el("settings-replayAfter").value=prefs.recordReplayAfterSeconds ?? half;
    el("settings-replayMonitorControl").hidden=true;
    el("settings-replayStatus").textContent="";
    el("settings-replayCheck").disabled=false;
    render();
    if(!native()) void check();
    if(!initialized) {
      initialized=true;
      select.addEventListener("change",async()=>{
        ++revision;status=null;render();el("settings-replayCheck").disabled=false;
        el("settings-replayStatus").textContent="";el("settings-replayMonitorControl").hidden=true;
        try {await save({...snapshot(),recordReplayMonitorSignature:""}); await check();} catch {el("settings-replayStatus").textContent=t("unavailable","Replay is not ready. Check the prerequisites and record.log for details.");}
      });
      for(const [id,key] of [["settings-replayBefore","recordReplayBeforeSeconds"],["settings-replayAfter","recordReplayAfterSeconds"]]) {
        el(id).addEventListener("change",async()=>{
          const number=Math.max(1,Math.min(120,Number(el(id).value)||1));el(id).value=number;
          try {await save({[key]:number}); await check();} catch {}
        });
      }
      el("settings-replayCheck").addEventListener("click",check);
      el("settings-replayMonitorConfirmed").addEventListener("change",async e=>{
        if(!status?.ok) return;
        try {await save({recordReplayMonitorSignature:e.target.checked ? status.monitorSignature : ""});} catch {e.target.checked=false;}
      });
    }
  }
  window.ReplayRecordingControls={init,snapshot};
})();
