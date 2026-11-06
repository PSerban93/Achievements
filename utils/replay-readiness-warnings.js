"use strict";
const {performance}=require("perf_hooks");
const {getReplayStatusIssue}=require("./replay-status-messages");

// One read-only preflight per external-backend activation, plus explicit checks
// and normal job failures. No polling, GPU toggles, or retry/capture commands.
class ReplayReadinessWarnings {
  constructor({getPreferences,inspect,notify,translate,log=()=>{},isQuitting=()=>false,platform=process.platform,now=()=>performance.now(),cooldownMs=60_000}) {
    Object.assign(this,{getPreferences,inspect,notify,translate,log,isQuitting,platform,now,cooldownMs});
    this.active=null;this.generation=0;this.checkSequence=0;this.last=null;this.pending=null;
  }
  key(prefs=this.getPreferences()) {
    return this.platform==="win32" && prefs?.disableAchievementRecords===false && ["amd","nvidia"].includes(prefs.recordBackend) ? prefs.recordBackend : null;
  }
  observe(result,expected=this.key()) {
    const current=this.key();
    if(result?.ok) {
      if(expected===current){this.last=null;this.pending=null;}
      return false;
    }
    const message=getReplayStatusIssue(result,this.translate);
    if(!message)return false;
    if(this.isQuitting() || !current || expected!==current || (result.provider && result.provider!==current))return true;
    this.pending={result,expected};
    const signature=JSON.stringify([current,result.code,result.hotkeyIssue,result.apiCode,
      Object.entries(result.prerequisites || {}).sort(([a],[b])=>a.localeCompare(b))]);
    if(this.last?.signature===signature && this.now()-this.last.at<this.cooldownMs)return true;
    if(this.notify(message)!==false)this.last={signature,at:this.now()};
    return true;
  }
  flush() {if(this.pending)this.observe(this.pending.result,this.pending.expected);}
  async check(prefs=this.getPreferences(),reason="manual") {
    const expected=this.key(prefs),generation=this.generation,sequence=++this.checkSequence;
    let result;
    try {result=await this.inspect({...prefs});}
    catch(error) {result={ok:false,code:error.code || "replay-unavailable",error:error.message,...error.details};}
    this.log(result,reason);
    if(sequence===this.checkSequence && generation===this.generation)this.observe(result,expected);
    return result;
  }
  sync(prefs=this.getPreferences()) {
    if(this.isQuitting()){this.generation++;this.checkSequence++;this.pending=null;return Promise.resolve(null);}
    const key=this.key(prefs);
    if(key===this.active)return Promise.resolve(null);
    this.active=key;this.generation++;this.checkSequence++;this.last=null;this.pending=null;
    return key ? this.check(prefs,"activation") : Promise.resolve(null);
  }
}
module.exports={ReplayReadinessWarnings};
