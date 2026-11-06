"use strict";
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { performance } = require("perf_hooks");
const { randomUUID, createHash } = require("crypto");
const { readNvidia,readAmd,validateSettings,closeReplayProviders } = require("./replay-providers");
const media = require("./replay-media");
const { observeReplayFolder } = require("./replay-files");
const { ReplaySourceHistory, RETAIN_MS } = require("./replay-source-history");

function replayTimings(prefs={}) {
  const half=Number(prefs.recordDurationSeconds || 20)/2;
  const n=(v,f)=>v!=null && Number.isFinite(Number(v)) ? Math.min(120,Math.max(1,Number(v))) : f;
  return {before:n(prefs.recordReplayBeforeSeconds,half),after:n(prefs.recordReplayAfterSeconds,half)};
}
function backend(prefs) {return ["nvidia","amd"].includes(prefs?.recordBackend) ? prefs.recordBackend : "native";}
function monitorSignature(provider,target,displays) {
  return JSON.stringify([provider,target.id,target.deviceName||"",displays.map(d=>[d.id,d.bounds]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]);
}

class ExternalReplayController extends EventEmitter {
  constructor({getPreferences,getMonitor,prepareOutput,ensureNativeStopped=async()=>{},journalRoot,readers={nvidia:readNvidia,amd:readAmd},tools,observe=observeReplayFolder,probe=media.probe,trim=media.trimReplay,now=()=>performance.now()}={}) {
    super(); Object.assign(this,{getPreferences,getMonitor,prepareOutput,ensureNativeStopped,journalRoot,readers,tools,observe,probe,trim,now});
    this.jobs=new Map(); this.chain=Promise.resolve(); this.accepting=true; this.recent=new Map();
    this.draining=false; this.processing=false; this.processingQueue=[]; this.processingChain=Promise.resolve();this.historyChain=Promise.resolve();
    this.history=new ReplaySourceHistory({root:journalRoot,emit:(event,data)=>this.emit(event,data),now});
    this.recoverySeen=new Map();
  }
  get status() {return {running:this.jobs.size>0,closing:!this.accepting && (this.draining || this.processing || this.jobs.size>0)};}
  getQuitTimeoutMs() {
    if(!this.jobs.size) return 75_000;
    const remaining=Math.max(0,...[...this.jobs.values()].map(job=>job.visibleAt+job.after*1000+1000-this.now()));
    // Settings/API/file detection plus FFmpeg and probes have separate bounded
    // timeouts. Budget accepted jobs conservatively; this is not a fixed wait.
    return Math.min(30*60_000,Math.max(75_000,remaining+this.jobs.size*250_000+5000));
  }
  async settings(prefs,signal) {
    if(process.platform!=="win32") throw new Error("External replay requires Windows");
    const provider=backend(prefs); if(provider==="native") throw new Error("Select NVIDIA or AMD Replay first");
    const timing=replayTimings(prefs), {target,displays}=this.getMonitor();
    const raw=await this.readers[provider]({signal,onDiagnostic:(stage,details)=>this.emit("stage",{stage,...details})});
    try {
      const settings=validateSettings(raw,{...timing,deviceName:target.deviceName,displayCount:displays.length});
      const folder=await fs.promises.stat(settings.root);
      if(!folder.isDirectory()) throw Object.assign(new Error("GPU replay save location is not a directory."),{code:"replay-folder-missing"});
      const signature=monitorSignature(provider,target,displays);
      return {...settings,...timing,monitorSignature:signature,monitorConfirmed:settings.monitorVerified || prefs.recordReplayMonitorSignature===signature};
    } catch(error) {
      if(raw.registrySources) error.details={...error.details,provider,registrySources:raw.registrySources,hotkeySource:raw.hotkeySource,
        ...(raw.registryReadErrors?.length ? {registryReadErrors:raw.registryReadErrors} : {})};
      throw error;
    }
  }
  async inspect(prefs=this.getPreferences()) {
    try {
      const settings=await this.settings(prefs);
      const tools=media.mediaTools(this.tools?.root); // Only bundled tools; never PATH.
      return {ok:true,provider:settings.provider,root:settings.root,bufferSeconds:settings.bufferSeconds,before:settings.before,after:settings.after,
        monitor:settings.monitor || "",monitorConfirmed:settings.monitorConfirmed,monitorVerificationRequired:!settings.monitorVerified,monitorSignature:settings.monitorSignature,codec:settings.codec || "",fps:settings.fps || "",toolsReady:!!tools,
        ...(settings.apiProtocol ? {apiProtocol:settings.apiProtocol,apiSessionRenewals:settings.apiSessionRenewals} : {}),
        ...(settings.hotkeySource ? {hotkeySource:settings.hotkeySource,registrySources:settings.registrySources,
          ...(settings.registryReadErrors?.length ? {registryReadErrors:settings.registryReadErrors} : {})} : {})};
    } catch(error) {return {ok:false,code:error.code || "replay-unavailable",error:error.message,...error.details};}
  }
  enqueue(notification,{visibleAt=performance.now(),preferences}={}) {
    const current=this.getPreferences(), prefs={...(preferences || current)}, provider=backend(prefs);
    if(!this.accepting || provider==="native" || provider!==backend(current) || current.disableAchievementRecords!==false || prefs.disableAchievementRecords!==false || notification.isTest || notification.notificationType==="progress") return null;
    const key=JSON.stringify([provider,notification.config_path||notification.configName,notification.name||notification.displayName,notification.isPlatinum===true]);
    const now=this.now(); for(const [k,t] of this.recent) if(now-t>60_000) this.recent.delete(k);
    if(this.recent.has(key)) return null;
    if(this.jobs.size>=16) {this.emit("failed",{code:"replay-queue-full",config:notification.config_path});return null;}
    this.recent.set(key,now);
    const job={id:randomUUID(),provider,prefs,notification:{...notification},visibleAt,abort:new AbortController(),state:"queued",...replayTimings(prefs)};
    const promise=new Promise(resolve=>{job.resolve=resolve;});
    this.jobs.set(job.id,job);
    this.emit("queued",{id:job.id,provider,config:notification.config_path,displayName:notification.displayName});
    this.wake?.(); this.startDrain();
    return {id:job.id,promise};
  }
  async journal(job,stage,extra={}) {
    job.stage=stage;
    this.emit("stage",{id:job.id,provider:job.provider,stage,...extra});
    if(!this.journalRoot) return;
    await fs.promises.mkdir(this.journalRoot,{recursive:true});
    const file=path.join(this.journalRoot,`${job.id}.json`), temp=`${file}.tmp`;
    await fs.promises.writeFile(temp,JSON.stringify({id:job.id,provider:job.provider,stage,updatedAt:new Date().toISOString(),output:job.output||"",source:job.source||"",config:job.notification.config_path,...extra}));
    await fs.promises.rename(temp,file);
  }
  startDrain() {
    if(this.draining) return;
    clearTimeout(this.cleanupTimer); this.draining=true;
    this.chain=Promise.resolve().then(async()=>{
      do {
        let seed;
        while((seed=[...this.jobs.values()].find(j=>j.state==="queued"))) await this.executeBatch(seed);
        await this.cleanupHistory();
      } while([...this.jobs.values()].some(j=>j.state==="queued"));
    }).catch(error=>this.emit("failed",{code:"replay-drain-failed",error:error.message})).finally(()=>{
      this.draining=false;
      if([...this.jobs.values()].some(j=>j.state==="queued")) this.startDrain();
      else this.scheduleCleanup();
    });
  }
  withHistory(action) {
    const task=this.historyChain.then(action);this.historyChain=task.catch(()=>{});return task;
  }
  cleanupHistory(force=false) {
    // Read the live references inside the same critical section as selection,
    // marking and deletion. Pending media work may use an older source even
    // when its requested interval no longer overlaps that source.
    return this.withHistory(()=>this.history.cleanup({force,jobs:[...this.jobs.values()]}));
  }
  scheduleCleanup() {
    if(!this.accepting || this.jobs.size || !this.history.entries.some(e=>e.published && !e.pinned))return;
    clearTimeout(this.cleanupTimer);
    this.cleanupTimer=setTimeout(()=>this.startDrain(),RETAIN_MS);this.cleanupTimer.unref();
  }
  startProcessing() {
    if(this.processing)return;
    this.processing=true;
    this.processingChain=Promise.resolve().then(async()=>{
      while(this.processingQueue.length)await this.processBatch(this.processingQueue.shift());
      await this.cleanupHistory();
    }).catch(error=>this.emit("failed",{code:"replay-processing-drain-failed",error:error.message})).finally(()=>{
      this.processing=false;
      if(this.processingQueue.length)this.startProcessing();
      else this.scheduleCleanup();
    });
  }
  async waitForChange(ms,signal) {
    signal.throwIfAborted();
    await new Promise(resolve=>{
      const finish=()=>{clearTimeout(timer);signal.removeEventListener("abort",finish);if(this.wake===finish)this.wake=null;resolve();};
      const timer=setTimeout(finish,ms); this.wake=finish; signal.addEventListener("abort",finish,{once:true});
    });
    signal.throwIfAborted();
  }
  async fail(job,error) {
    if(job.output && !job.published) {
      const stat=await fs.promises.lstat(job.output).catch(()=>null);
      if(stat?.isFile() && stat.size===0) await fs.promises.unlink(job.output).catch(()=>{});
    }
    this.emit(job.abort.signal.aborted ? "cancelled" : "failed",{id:job.id,provider:job.provider,config:job.notification.config_path,code:error.code||"replay-failed",error:error.message,source:job.source||null,...error.details});
    await this.journal(job,"failed",{code:error.code||"replay-failed",error:error.message,...error.details}).catch(()=>{});
  }
  compatible(seed,job) {
    return seed.provider===job.provider && seed.prefs.recordReplayMonitorSignature===job.prefs.recordReplayMonitorSignature;
  }
  saveDue(group,settings) {
    const wanted=Math.max(...group.map(job=>job.visibleAt+job.after*1000))+1000;
    // Preserve the full interval when it fits. If it cannot fit, sacrifice
    // post-roll before allowing the desired action history to be overwritten.
    // Already retained continuous history can extend the safe deadline.
    const margin=Math.min(3,settings.bufferSeconds/4)*1000;
    const deadlines=group.map(job=>this.history.coveredUntil(settings,job.visibleAt-job.before*1000)+settings.bufferSeconds*1000-margin);
    return Math.min(wanted,...deadlines);
  }
  assertMonitor(provider,signature) {
    const {target,displays}=this.getMonitor();
    if(monitorSignature(provider,target,displays)!==signature) throw Object.assign(new Error("Monitor selection changed during replay processing."),{code:"replay-monitor-changed"});
  }
  async executeBatch(seed) {
    const group=[seed],signal=seed.abort.signal; seed.state="batched";
    let observer,source,settings,handedOff=false;
    try {
      signal.throwIfAborted(); await this.ensureNativeStopped();
      settings=await this.settings(seed.prefs,signal);
      if(!settings.monitorConfirmed) throw Object.assign(new Error("Confirm in Recording settings that GPU Replay captures the notification monitor."),{code:"replay-monitor-unconfirmed"});
      const tools=this.tools || media.mediaTools();
      await this.journal(seed,"waiting",{batchId:seed.id});
      // A later notification may share the save, but must not postpone it past
      // the first event's protected history deadline.
      let due;
      for(;;) {
        signal.throwIfAborted();
        for(const candidate of this.jobs.values()) {
          if(candidate.state!=="queued" || candidate.abort.signal.aborted || !this.compatible(seed,candidate)) continue;
          const all=[...group,candidate],previousDue=this.saveDue(group,settings),combinedDue=this.saveDue(all,settings);
          if(combinedDue<previousDue || combinedDue<candidate.visibleAt) continue;
          candidate.state="batched";group.push(candidate);
          await this.journal(candidate,"waiting",{batchId:seed.id});
        }
        due=this.saveDue(group,settings);
        if(this.now()>=due) break;
        await this.waitForChange(due-this.now(),signal);
      }
      const latest=await this.settings(seed.prefs,signal);
      if(latest.fingerprint!==settings.fingerprint || latest.monitorSignature!==settings.monitorSignature) throw Object.assign(new Error("GPU replay settings or monitors changed during this batch; no save command was sent."),{code:"replay-settings-changed"});
      await this.withHistory(async()=>{await this.history.cleanup({jobs:[...this.jobs.values()]});this.history.checkCapacity();});
      observer=await this.observe(settings.root,seed.provider,signal);
      // A delayed request still saves what remains. Actual coverage is decided
      // from the resulting file's duration, not the configured buffer length.
      for(const job of group) {
        await this.journal(job,"saving",{batchId:seed.id,batchSize:group.length,
          requestedBeforeSeconds:job.before,requestedAfterSeconds:job.after,bufferSeconds:settings.bufferSeconds,
          earlySave:this.now()<job.visibleAt+job.after*1000});
      }
      signal.throwIfAborted();
      let command,saveError;
      try {command=await latest.save(signal);}
      catch(error) {
        const details=error.details;
        if(signal.aborted || details?.outcomeUncertain!==true || details.transport!=="nvidia-api" || !Number.isFinite(details.captureSentAt))throw error;
        saveError=error;
        command={sentAt:details.captureSentAt,transport:"nvidia-api",sourcePath:null,outcomeUncertain:true};
        for(const job of group)await this.journal(job,"save-outcome-uncertain",{batchId:seed.id,code:error.code,error:error.message,...details});
      }
      for(const job of group) await this.journal(job,"detecting",{batchId:seed.id,batchSize:group.length,transport:command.transport,saveDelayMs:command.sentAt-job.visibleAt,
        ...(command.outcomeUncertain ? {saveOutcomeUncertain:true} : {}),...(command.providerMessage ? {providerMessage:command.providerMessage} : {})});
      let found;
      try {found=await observer.wait(command.sentAt,{signal,probe:(file,opt)=>this.probe(file,{...opt,tools})});}
      catch(error) {
        if(saveError)error.details={...error.details,saveOutcomeUncertain:true,originalApiCode:saveError.code,originalApiError:saveError.message};
        throw error;
      }
      for(const job of group) job.source=found.file;
      found.assertUnambiguous();
      if(command.outcomeUncertain)for(const job of group)await this.journal(job,"save-file-recovered",{batchId:seed.id,source:found.file,saveOutcomeUncertain:true});
      let sourceConfirmed=false;
      if(typeof command.sourcePath==="string" && path.isAbsolute(command.sourcePath)) {
        const receipt=await fs.promises.realpath(command.sourcePath);
        if(receipt.toLowerCase()!==path.resolve(found.file).toLowerCase()) throw Object.assign(new Error("GPU capture response points to another file; observed source preserved."),{code:"replay-source-receipt-mismatch"});
        sourceConfirmed=true;
      }
      // Seal this association before another save can create a second file.
      // Later publication still checks file identity, mutation and the monitor.
      found.assertUnambiguous();observer.close();observer=null;
      await this.withHistory(async()=>{
        source=await this.history.add(found,settings,command.sentAt,{sourceConfirmed});
        for(const job of group) {
          job.protectedSources=[source];
          try {
            job.selection=this.history.planAvailable(settings,job.visibleAt-job.before*1000,job.visibleAt+job.after*1000,job.visibleAt);
            job.protectedSources=[...new Set([source,...job.selection.sources])];
          } catch(error) {job.selectionError=error;}
          job.state="processing-queued";
        }
      });
      for(const job of group)await this.journal(job,"processing-queued",{batchId:seed.id,batchSize:group.length,source:source.file});
      this.processingQueue.push({group,seed,settings,tools,found,source,command});handedOff=true;this.startProcessing();
    } catch(error) {
      if(source)await this.withHistory(()=>this.history.mark([...new Set([source,...group.flatMap(job=>job.protectedSources || [])])],false));
      for(const job of group)if(!job.published)await this.fail(job,error);
    } finally {
      observer?.close();
      if(!handedOff)for(const job of group){this.jobs.delete(job.id);job.resolve();}
      await this.pruneJournals().catch(()=>{});
    }
  }
  async processBatch({group,seed,settings,tools,found,source,command}) {
    try {
      for(const job of group) {
        let sources;
        try {
          job.state="processing";
          job.abort.signal.throwIfAborted(); found.assertUnambiguous();
          if(job.selectionError)throw job.selectionError;
          const selected=job.selection;
          sources=selected.sources;
          await this.history.assertUnchanged(sources);
          job.output=await this.prepareOutput(job.notification,job.prefs);
          const start=Math.max(0,(selected.start-sources[0].start)/1000),duration=(selected.end-selected.start)/1000;
          await this.journal(job,"trimming",{batchId:seed.id,sources:sources.map(s=>s.file),start,duration,...selected.coverage});
          const mediaResult=await this.trim({source:sources[0].file,sources:sources.map(s=>({file:s.file,start:s.start,end:s.end})),output:job.output,start,duration,tools,signal:job.abort.signal,beforePublish:async()=>{
            found.assertUnambiguous(); this.assertMonitor(job.provider,settings.monitorSignature);
            await this.history.assertUnchanged(sources);
          }});
          const result={...mediaResult,...selected.coverage,...(command.outcomeUncertain ? {saveOutcomeUncertain:true} : {})};
          job.published=true; await this.withHistory(()=>this.history.mark(sources,true));
          let journalOk=true;
          try {await this.journal(job,"published",result);} catch(error) {journalOk=false;await this.withHistory(()=>this.history.mark(sources,false));this.emit("source-retained",{id:job.id,reason:`journal-write-failed: ${error.message}`});}
          this.emit("saved",{id:job.id,outputPath:job.output,...result});
          if(this.journalRoot && journalOk) await fs.promises.rm(path.join(this.journalRoot,`${job.id}.json`),{force:true}).catch(()=>{});
        } catch(error) {await this.withHistory(()=>this.history.mark(sources||job.protectedSources,false));await this.fail(job,error);}
      }
      if(group.every(job=>job.published)) await this.withHistory(()=>this.history.mark([source],true));
      this.emit("source-retained",{source:source.file,reason:"history-for-following-notifications",retainSeconds:RETAIN_MS/1000,batchSize:group.length,sourceConfirmed:source.sourceConfirmed});
    } catch(error) {
      await this.withHistory(()=>this.history.mark([source],false));
      for(const job of group) if(!job.published) await this.fail(job,error);
    } finally {
      for(const job of group) {this.jobs.delete(job.id);job.resolve();}
      await this.pruneJournals().catch(()=>{});
    }
  }
  cancel(reason="settings-changed") {for(const job of this.jobs.values()) job.abort.abort(new Error(reason));this.wake?.();}
  stop() {
    if(this.stopPromise) return this.stopPromise;
    this.accepting=false;clearTimeout(this.cleanupTimer);
    this.emit("stage",{stage:"shutdown-draining",pendingJobs:this.jobs.size,timeoutMs:this.getQuitTimeoutMs()});
    return this.stopPromise=(async()=>{
      for(;;) {
        if(!this.draining && [...this.jobs.values()].some(j=>j.state==="queued")) this.startDrain();
        if(this.processingQueue.length && !this.processing)this.startProcessing();
        const chain=this.chain,processing=this.processingChain,history=this.historyChain;
        await Promise.all([chain,processing,history]);
        if(this.chain===chain && this.processingChain===processing && !this.draining && !this.processing && !this.jobs.size && !this.processingQueue.length)break;
      }
      await this.cleanupHistory(true);
      await closeReplayProviders();
    })();
  }
  forceStop(reason) {this.accepting=false;clearTimeout(this.cleanupTimer);this.cancel(reason);void closeReplayProviders();}
  async pruneJournals() {
    if(!this.journalRoot) return;
    const files=(await fs.promises.readdir(this.journalRoot)).filter(n=>/^[a-f0-9-]+\.json$/.test(n));
    if(files.length<=50) return;
    const entries=await Promise.all(files.map(async name=>({name,stat:await fs.promises.lstat(path.join(this.journalRoot,name))})));
    for(const entry of entries.filter(e=>e.stat.isFile() && !this.jobs.has(e.name.slice(0,-5))).sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs).slice(50)) {
      await fs.promises.unlink(path.join(this.journalRoot,entry.name));
    }
  }
  async recover() {
    if(!this.journalRoot) return;
    const names=await fs.promises.readdir(this.journalRoot).catch(()=>[]);
    const jobs=names.filter(n=>/^[a-f0-9-]+\.json$/.test(n)).slice(-50);
    const sources=names.filter(n=>/^source-[a-f0-9-]+\.json$/.test(n)).slice(-32);
    for(const name of [...jobs,...sources]) {
      try {
        if(this.jobs.has(name.slice(0,-5))) continue;
        const file=path.join(this.journalRoot,name), stat=await fs.promises.lstat(file);
        if(!stat.isFile() || stat.isSymbolicLink()) continue;
        const content=await fs.promises.readFile(file,"utf8"), signature=createHash("sha256").update(content).digest("hex");
        if(this.recoverySeen.get(name)===signature) continue;
        const record=JSON.parse(content), isSource=name.startsWith("source-");
        const classification=isSource ? "retained-source" : record.stage==="published" ? "published-journal" :
          record.stage==="cancelled" ? "previous-job-cancelled" : record.stage==="failed" ? "previous-job-failed" : "previous-job-interrupted";
        const reason=isSource ? "Historical GPU source journal; timing cannot be reused. Source left untouched." :
          record.stage==="published" ? "Historical published job journal remains. No replay command or source deletion will be retried." :
          "Historical unfinished job journal; not a failure in the current session. No replay command or source deletion will be retried.";
        this.emit("recovery",{...(isSource ? {source:record.file} : {id:record.id,stage:record.stage,source:record.source,code:record.code}),
          classification,historical:true,currentSessionFailure:false,automaticRetry:false,sourceAction:"none",previousUpdatedAt:record.updatedAt||null,reason});
        if(this.recoverySeen.size>=128) this.recoverySeen.delete(this.recoverySeen.keys().next().value);
        this.recoverySeen.set(name,signature);
      } catch {} // Keep unreadable journals and source files untouched as well.
    }
  }
}
module.exports={ExternalReplayController,replayTimings,backend,monitorSignature};
