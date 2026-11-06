"use strict";
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { setTimeout: delay } = require("timers/promises");

function inside(root, file) {
  const relative=path.relative(root.toLowerCase(),file.toLowerCase());
  return !!relative && !relative.startsWith(`..${path.sep}`) && relative!==".." && !path.isAbsolute(relative);
}
function isReplayFile(root,file,provider) {
  if(!inside(root,file) || path.relative(root,file).split(path.sep)[0].toLowerCase()==="replay_cache") return false;
  return provider==="nvidia" ? /\.DVR\.mp4$/i.test(file) : /_replay_[^\\/]+\.mp4$/i.test(file);
}

// One bounded inventory of the configured media folder, never the game tree or
// Watched Folders. Afterwards only filesystem events are inspected.
async function observeReplayFolder(root, provider, signal) {
  root=await fs.promises.realpath(root);
  const seen=new Set(), candidates=new Map(); let watcherError, rescanNeeded=false,closed=false;
  const watcher=fs.watch(root,{recursive:true},(kind,name)=>{
    if(closed)return;
    if(!name) { rescanNeeded=true; return; }
    const file=path.resolve(root,String(name));
    if(isReplayFile(root,file,provider)) candidates.set(file,performance.now());
  });
  watcher.on("error",error=>{if(!closed)watcherError=error;});
  async function inventory() {
    let count=0, entries=0; const files=[];
    const queue=[{dir:root,depth:0}];
    for(let i=0;i<queue.length;i++) {
      signal?.throwIfAborted();
      const {dir,depth}=queue[i];
      if(depth>8 || ++count>10_000) throw new Error("Replay media folder is too large to inventory safely");
      for(const entry of await fs.promises.readdir(dir,{withFileTypes:true})) {
        if(++entries>50_000) throw new Error("Replay media folder exceeds the file inventory limit");
        const file=path.join(dir,entry.name);
        if(entry.isSymbolicLink()) continue;
        if(entry.isDirectory() && !(dir===root && entry.name.toLowerCase()==="replay_cache")) queue.push({dir:file,depth:depth+1});
        else if(entry.isFile() && isReplayFile(root,file,provider)) files.push(file);
      }
    }
    return files;
  }
  try {
    for(const file of await inventory()) seen.add(file.toLowerCase());
    candidates.clear();
    return { root, close:()=>{closed=true;watcher.close();}, async wait(sentAt, {probe,signal,timeout=60_000}={}) {
      const deadline=performance.now()+timeout, stable=new Map(); let selectedSince=null;
      while(performance.now()<deadline) {
        signal?.throwIfAborted();
        if(watcherError) throw watcherError;
        if(rescanNeeded) {
          rescanNeeded=false;
          for(const file of await inventory()) if(!seen.has(file.toLowerCase())) candidates.set(file,performance.now());
        }
        const fresh=[...candidates].filter(([file,at])=>at>=sentAt && !seen.has(file.toLowerCase()));
        if(fresh.length>1) throw Object.assign(new Error("Multiple new replay files appeared. Sources were preserved."), {code:"replay-source-ambiguous"});
        for(const [file] of fresh) {
          try {
            const real=await fs.promises.realpath(file);
            if(real.toLowerCase()!==file.toLowerCase() || !inside(root,real)) throw new Error("Replay source is a redirected path");
            const stat=await fs.promises.lstat(file);
            if(!stat.isFile() || stat.size<1024) continue;
            const previous=stable.get(file);
            if(!previous || previous.size!==stat.size || previous.mtimeMs!==stat.mtimeMs) {
              stable.set(file,{size:stat.size,mtimeMs:stat.mtimeMs,since:performance.now()}); selectedSince=null; continue;
            }
            if(performance.now()-previous.since<2000) continue;
            const metadata=await probe(file,{signal});
            if(selectedSince===null) selectedSince=performance.now();
            if(performance.now()-selectedSince<1000) continue;
            return {file,stat,metadata, assertUnambiguous() {
              if(watcherError || [...candidates].some(([f,t])=>t>=sentAt && !seen.has(f.toLowerCase()) && f!==file)) throw new Error("Replay source association became ambiguous; original retained");
            }};
          } catch(error) { if(error.code==="ABORT_ERR" || signal?.aborted) throw error; if(!["ENOENT","EBUSY","EPERM"].includes(error.code) && !/incomplete|unsupported video|ffprobe/i.test(error.message)) throw error; }
        }
        await delay(250,undefined,{signal});
      }
      throw Object.assign(new Error("No completed replay file was detected. Check the GPU overlay and Desktop Capture settings."),{code:"replay-save-timeout"});
    }};
  } catch(error) { watcher.close(); throw error; }
}
module.exports={inside,isReplayFile,observeReplayFolder};
