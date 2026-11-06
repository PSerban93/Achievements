"use strict";

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { run } = require("./replay-media");
const fail = (code, message) => Object.assign(new Error(message), { code });
const read = async file => JSON.parse((await fs.promises.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
const on = value => value === true || Number(value) === 1;
const switchState = value => value===true || value===1 || value==="1" ? true : value===false || value===0 || value==="0" ? false : null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const replayModifiers={CTRL:17,CONTROL:17,SHIFT:16,ALT:18,MENU:18,WIN:91,WINDOWS:91,LWIN:91,RWIN:92,
  LCTRL:162,LEFTCTRL:162,LCONTROL:162,LEFTCONTROL:162,RCTRL:163,RIGHTCTRL:163,RCONTROL:163,RIGHTCONTROL:163,
  LSHIFT:160,LEFTSHIFT:160,RSHIFT:161,RIGHTSHIFT:161,LALT:164,LEFTALT:164,LMENU:164,RALT:165,RIGHTALT:165,RMENU:165};
const modifierFamily=vk=>[16,160,161].includes(vk)?"shift":[17,162,163].includes(vk)?"ctrl":[18,164,165].includes(vk)?"alt":[91,92].includes(vk)?"win":null;
const replayNamedKeys={BACK:8,BACKSPACE:8,TAB:9,CLEAR:12,RETURN:13,ENTER:13,PAUSE:19,CAPITAL:20,CAPSLOCK:20,
  ESC:27,ESCAPE:27,SPACE:32,SPACEBAR:32,PRIOR:33,PAGEUP:33,PGUP:33,NEXT:34,PAGEDOWN:34,PGDN:34,
  END:35,HOME:36,LEFT:37,ARROWLEFT:37,UP:38,ARROWUP:38,RIGHT:39,ARROWRIGHT:39,DOWN:40,ARROWDOWN:40,
  SNAPSHOT:44,PRINTSCREEN:44,PRTSC:44,INSERT:45,INS:45,DELETE:46,DEL:46,APPS:93,CONTEXTMENU:93,
  MULTIPLY:106,NUMPADMULTIPLY:106,ADD:107,NUMPADADD:107,SEPARATOR:108,SUBTRACT:109,NUMPADSUBTRACT:109,
  DECIMAL:110,NUMPADDECIMAL:110,DIVIDE:111,NUMPADDIVIDE:111,NUMLOCK:144,SCROLL:145,SCROLLLOCK:145,
  OEM1:186,OEMSEMICOLON:186,OEMPLUS:187,OEMCOMMA:188,OEMMINUS:189,OEMPERIOD:190,OEM2:191,OEMQUESTION:191,
  OEM3:192,OEMTILDE:192,OEM4:219,OEMOPENBRACKETS:219,OEM5:220,OEMPIPE:220,OEM6:221,OEMCLOSEBRACKETS:221,
  OEM7:222,OEMQUOTES:222,OEM8:223,OEM102:226,OEMBACKSLASH:226,
  PLUS:187,"+":187,COMMA:188,",":188,MINUS:189,"-":189,PERIOD:190,".":190};
const keyName=text=>text.trim().toUpperCase().replace(/^VK_/,"").replace(/[\s_]/g,"");
const extendedReplayKeys=new Set([33,34,35,36,37,38,39,40,44,45,46,91,92,93,111,144,163,165]);

function parseAmdHotkey(raw) {
  const invalid=(reason,message)=>Object.assign(fail("replay-hotkey-invalid",message),{details:{
    registryPath:"HKCU\\Software\\AMD\\DVR",registryValue:"SaveInstantReplayHotkey",hotkeyIssue:reason,
    hotkeyType:raw==null ? "missing" : Array.isArray(raw) ? "array" : typeof raw,
    hotkeyValue:typeof raw==="string" ? raw.slice(0,128) : null}});
  // Keep previously accepted string-array representations, but never
  // reinterpret binary/numeric values as a guessed virtual-key encoding.
  const text=typeof raw==="string" ? raw.trim() : Array.isArray(raw) && raw.length<=5 && raw.every(v=>typeof v==="string") ? raw.join(",").trim() : "";
  if(raw==null || (typeof raw==="string" && !text))throw invalid("missing","AMD Save Instant Replay shortcut is missing or unsupported.");
  if(!text || text.length>256)throw invalid("unsupported-format","AMD Save Instant Replay shortcut is missing or unsupported.");
  const comma=text.indexOf(",");let modifiers,key;
  if(text.length===1 && ["+",",","-","."].includes(text)) {modifiers=[];key=text;}
  else if(comma>=0) {
    const mainText=text.slice(comma+1).trim();
    if(mainText.includes(",") && mainText!==",")throw invalid("unsupported-format","AMD Save Instant Replay shortcut is missing or unsupported.");
    modifiers=text.slice(0,comma).trim()?text.slice(0,comma).split("+"):[];key=keyName(mainText);
  } else if(text.endsWith("++") && text.slice(0,-2).trim()) {modifiers=text.slice(0,-2).split("+");key="+";}
  else {const tokens=text.split("+");key=keyName(tokens.pop());modifiers=tokens;}
  if(!key)throw invalid("unsupported-format","AMD Save Instant Replay shortcut is missing or unsupported.");
  const keys=modifiers.map(m=>replayModifiers[keyName(m)]),families=keys.map(modifierFamily);
  const main=/^[A-Z0-9]$/.test(key)?key.charCodeAt(0):/^F(?:[1-9]|1\d|2[0-4])$/.test(key)?111+Number(key.slice(1)):
    /^NUMPAD[0-9]$/.test(key)?96+Number(key.at(-1)):replayNamedKeys[key] || 0;
  if(!main || modifierFamily(main))throw invalid("unsupported-key","Unsupported AMD replay shortcut; no keys were sent.");
  if(keys.some(k=>!k) || new Set(families).size!==families.length)throw invalid("unsupported-modifiers","Unsupported AMD replay shortcut; no keys were sent.");
  return [...keys, main];
}

let keyboard;
function nativeKeyboard() {
  if (keyboard) return keyboard;
  if (process.platform !== "win32") throw new Error("Replay shortcuts require Windows");
  const koffi = require("koffi"), user32 = koffi.load("user32.dll");
  const Mouse = koffi.struct("REPLAY_MOUSEINPUT", { dx:"int32", dy:"int32", mouseData:"uint32", dwFlags:"uint32", time:"uint32", dwExtraInfo:"uintptr_t" });
  const Key = koffi.struct("REPLAY_KEYBDINPUT", { wVk:"uint16", wScan:"uint16", dwFlags:"uint32", time:"uint32", dwExtraInfo:"uintptr_t" });
  const Union = koffi.union("REPLAY_INPUT_UNION", { mi:Mouse, ki:Key });
  const Input = koffi.struct("REPLAY_INPUT", { type:"uint32", u:Union });
  keyboard = { size:koffi.sizeof(Input), held:user32.func("short __stdcall GetAsyncKeyState(int vKey)"),
    send:user32.func("uint32 __stdcall SendInput(uint32 cInputs, _In_ REPLAY_INPUT *pInputs, int cbSize)") };
  return keyboard;
}

async function sendShortcut(keys, signal, keyboardApi) {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 5 || keys.some(k => !Number.isInteger(k) || k < 1 || k > 254) ||
      keys.slice(0,-1).some(k => !modifierFamily(k)) || modifierFamily(keys.at(-1)) ||
      new Set(keys.slice(0,-1).map(modifierFamily)).size!==keys.length-1) throw fail("replay-hotkey-invalid", "Invalid replay shortcut.");
  const api = keyboardApi || nativeKeyboard();
  const watched = [...new Set([...keys,16,17,18,91,92])];
  const deadline = performance.now() + 2000;
  while (watched.some(vk => (api.held(vk) & 0x8000) !== 0)) {
    signal?.throwIfAborted();
    if (performance.now() >= deadline) throw fail("replay-hotkey-held", "Release the replay shortcut and modifier keys before saving.");
    await pause(25);
  }
  const injected = [];
  let sentAt;
  const send = (vk, up) => {
    if (api.send(1, [{ type:1, u:{ ki:{ wVk:vk, wScan:0, dwFlags:(up ? 2 : 0) | (extendedReplayKeys.has(vk) ? 1 : 0), time:0, dwExtraInfo:0 } } }], api.size) !== 1) throw fail("replay-input-rejected", "Windows rejected the replay shortcut.");
  };
  try {
    for (let i=0; i<keys.length; i++) {
      signal?.throwIfAborted();
      if (i === keys.length-1) sentAt = performance.now();
      send(keys[i], false); injected.push(keys[i]); await pause(70);
    }
  } finally { for (const key of injected.reverse()) { try { send(key, true); } catch {} } }
  return { sentAt, transport:"shortcut" };
}

class NvidiaClient {
  constructor(endpoint) {
    this.endpoint = endpoint; this.protocol = "2025-11-25"; this.id = 0;
    this.generation = 0; this.renewals = 0; this.lifetime = new AbortController();
  }
  assertOpen(signal) {
    signal?.throwIfAborted();
    if(this.closed) throw fail("replay-api-closed", "The NVIDIA replay connection is closed.");
  }
  // A caller cancelling its settings check must not cancel another caller's
  // shared initialization. Closing the client aborts that initialization instead.
  async waitFor(task, signal) {
    this.assertOpen(signal);
    if(!signal) return task;
    let abort;
    const cancelled=new Promise((_,reject)=>{
      abort=()=>reject(signal.reason);
      signal.addEventListener("abort",abort,{once:true});
    });
    try {return await Promise.race([task,cancelled]);}
    finally {signal.removeEventListener("abort",abort);}
  }
  async request(method, params, signal, notification = false) {
    const operation=method==="tools/call" ? `${params.name}:${params.arguments?.action || "read"}` : method;
    try {return await this.requestOnce(method,params,signal,notification);}
    catch(error) {
      if(signal?.aborted || this.closed) throw error;
      if(typeof error.code==="string" && error.code.startsWith("replay-")) throw error;
      const timeout=error.name==="TimeoutError";
      const transportCode=error.cause?.code;
      const notSent=["ECONNREFUSED","ENOTFOUND","EAI_AGAIN","UND_ERR_CONNECT_TIMEOUT","ERR_INVALID_URL"].includes(transportCode);
      throw Object.assign(fail(timeout ? "replay-api-timeout" : "replay-api-error",timeout ? "NVIDIA replay API timed out; the command was not repeated." : `NVIDIA replay API failed: ${error.message}`),
        {details:{operation,...(typeof transportCode==="string" ? {transportCode} : {}),
          ...(operation==="nvapp_overlay_capture:save_instant_replay" && !notSent ? {outcomeUncertain:true} : {})}});
    }
  }
  async requestOnce(method, params, signal, notification = false) {
    this.assertOpen(signal);
    const id = ++this.id, headers = { "content-type":"application/json", accept:"application/json, text/event-stream", "MCP-Protocol-Version":this.protocol };
    if (this.session) headers["Mcp-Session-Id"] = this.session;
    const operation=method==="tools/call" ? `${params.name}:${params.arguments?.action || "read"}` : method;
    const response = await fetch(this.endpoint, { method:"POST", headers, redirect:"error", signal: AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(15_000)]),
      body:JSON.stringify({ jsonrpc:"2.0", ...(notification ? {} : {id}), method, params }) });
    // Only InitializeResult assigns a session. Late responses from an expired
    // generation must never overwrite a newly initialized session.
    if(method==="initialize" && response.ok) this.session=response.headers.get("mcp-session-id") || null;
    if (!response.ok) {
      await response.body?.cancel().catch(()=>{});
      throw Object.assign(fail("replay-api-error", `NVIDIA returned HTTP ${response.status}`),
        {httpStatus:response.status,details:{httpStatus:response.status,operation}});
    }
    if (notification) { await response.body?.cancel(); return null; }
    let value;
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer="", bytes=0, data=[];
      try {
        while (!value) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.length; if (bytes > 1024*1024) throw new Error("Oversized NVIDIA response");
          buffer += decoder.decode(part.value, {stream:true});
          let newline;
          while ((newline=buffer.indexOf("\n")) >= 0) {
            const line=buffer.slice(0,newline).replace(/\r$/,""); buffer=buffer.slice(newline+1);
            if(line.startsWith("data:")) data.push(line.slice(5).replace(/^ /,""));
            if(line!=="" || !data.length) continue;
            const event=data.join("\n");data=[];
            if(!event.trim()) continue; // MCP can prime an SSE stream with empty data.
            const item=JSON.parse(event); if (item.id === id) { value=item; break; }
          }
        }
      } finally { await reader.cancel().catch(()=>{}); }
    } else { const body=await response.text(); if (body.length>1024*1024) throw new Error("Oversized NVIDIA response"); value=JSON.parse(body); }
    const result=value?.result;
    const payloads=[value?.error?.data,value?.error,result?.structuredContent,result];
    for(const content of result?.content || []) {
      if(content.type==="text") {try {payloads.push(JSON.parse(content.text));} catch {}}
    }
    const errorData=payloads.find(p=>p && (p.errorCode || p.status==="error" || p.success===false || p.error)) || {};
    if (!value || value.id !== id || value.error || result?.isError || errorData.errorCode || errorData.status==="error" || errorData.success===false || errorData.error) {
      const apiCode=typeof errorData.errorCode==="string" ? errorData.errorCode.slice(0,100) : undefined;
      const raw=errorData.message || value?.error?.message || result?.content?.find(c=>c.type==="text")?.text;
      let message=typeof raw==="string" ? raw.slice(0,1000) : "NVIDIA replay request failed. It will not be retried through a shortcut.";
      if(this.session) message=message.replaceAll(this.session,"<session>");
      throw Object.assign(fail("replay-api-error", message),{details:{operation,
        ...(apiCode ? {apiCode} : {}),...(typeof value?.error?.code==="number" ? {rpcCode:value.error.code} : {}),
        ...(typeof errorData.retriable==="boolean" ? {retriable:errorData.retriable} : {})}});
    }
    if(!result || typeof result!=="object") throw fail("replay-api-error","NVIDIA returned an invalid replay response.");
    return value.result;
  }
  async init(signal) {
    this.assertOpen(signal);
    if(this.initialized) return;
    if(!this.initializing) {
      this.generation++;
      this.initializing=this.initialize().then(()=>{this.assertOpen();this.initialized=true;})
        .catch(async error=>{await this.releaseSession();throw error;}).finally(()=>{this.initializing=null;});
      this.initializing.catch(()=>{}); // The last waiter may have been cancelled.
    }
    return this.waitFor(this.initializing,signal);
  }
  async initialize(signal) {
    const init=await this.request("initialize", {protocolVersion:this.protocol, capabilities:{}, clientInfo:{name:"Achievements",version:"1"}}, signal);
    if(!["2025-11-25","2025-03-26","2024-11-05"].includes(init.protocolVersion)) throw fail("replay-api-unsupported","NVIDIA negotiated an unsupported MCP protocol.");
    this.protocol=init.protocolVersion;
    await this.request("notifications/initialized", {}, signal, true);
    const names=new Set(),cursors=new Set(); let cursor;
    do {
      const list=await this.request("tools/list", cursor ? {cursor} : {}, signal);
      for(const tool of list.tools || []) names.add(tool.name);
      cursor=list.nextCursor;
      if(cursor && (typeof cursor!=="string" || cursors.has(cursor) || cursors.size>=20)) throw fail("replay-api-unsupported","NVIDIA tool discovery did not finish.");
      if(cursor) cursors.add(cursor);
    } while(cursor);
    if (!names.has("nvapp_overlay_get_status") || !names.has("nvapp_overlay_capture")) throw fail("replay-api-unsupported", "NVIDIA replay API is unavailable.");
  }
  async status(signal, onDiagnostic) {
    await this.init(signal);
    const session=this.session,generation=this.generation;
    const readStatus=()=>this.request("tools/call", {name:"nvapp_overlay_get_status",arguments:{}}, signal);
    let result;
    try {result=await readStatus();}
    catch(error) {
      this.assertOpen(signal);
      if(error.httpStatus!==404 || !session) throw error;
      // One renewal per expired generation, shared even by late concurrent 404s.
      // Only the read is repeated. Capture requests never enter this recovery.
      if(this.recovery?.generation!==generation && this.generation===generation) {
        this.session=null;this.initialized=false;
        const report=(event,details)=>{try {onDiagnostic?.(event,{provider:"nvidia",...details});} catch {}};
        report("api-session-renewing",{httpStatus:404,operation:"nvapp_overlay_get_status"});
        this.recovery={generation,promise:this.init().then(()=>{
          this.renewals++;
          report("api-session-renewed",{renewals:this.renewals,protocol:this.protocol});
        },failure=>{report("api-session-renewal-failed",{code:failure.code || "replay-api-error",...failure.details});throw failure;})};
        this.recovery.promise.catch(()=>{});
      }
      await this.waitFor(this.recovery?.generation===generation ? this.recovery.promise : this.init(),signal);
      this.assertOpen(signal);
      try {result=await readStatus();}
      catch(failure) {failure.details={...failure.details,sessionRenewed:true};throw failure;}
    }
    if (result.structuredContent && typeof result.structuredContent==="object" && !Array.isArray(result.structuredContent)) return result.structuredContent;
    for (const c of result.content || []) { try {const status=JSON.parse(c.text);if(status && typeof status==="object" && !Array.isArray(status)) return status;} catch {} }
    throw fail("replay-api-status", "NVIDIA did not return a readable replay status.");
  }
  async save(signal) {
    const sentAt=performance.now();
    let result;
    try {result=await this.request("tools/call", {name:"nvapp_overlay_capture",arguments:{action:"save_instant_replay"}}, signal);}
    catch(error) {
      if(!signal?.aborted && !this.closed && (error.details?.outcomeUncertain===true || error.details?.apiCode==="overlay_timeout")) {
        error.details={...error.details,outcomeUncertain:true,captureSentAt:sentAt,transport:"nvidia-api"};
      }
      throw error;
    }
    // Only a machine-readable path from this exact capture response can prove
    // which source the provider saved. A success acknowledgement alone cannot.
    const receipts=[result?.structuredContent];
    for(const content of result?.content || []) {
      if(content.type!=="text") continue;
      try {receipts.push(JSON.parse(content.text));} catch {}
    }
    const paths=receipts.filter(receipt=>receipt && !Array.isArray(receipt) && receipt.success!==false && !receipt.error)
      .flatMap(receipt=>[receipt.filePath,receipt.outputPath])
      .filter(value=>typeof value==="string" && path.isAbsolute(value));
    const unique=[...new Set(paths.map(value=>path.resolve(value)))];
    let providerMessage=(result?.content || []).filter(c=>c.type==="text" && typeof c.text==="string").map(c=>c.text).join("\n").slice(0,1000);
    if(this.session) providerMessage=providerMessage.replaceAll(this.session,"<session>");
    return {sentAt, transport:"nvidia-api",sourcePath:unique.length===1 ? unique[0] : null,...(providerMessage ? {providerMessage} : {})};
  }
  async releaseSession() {
    const session=this.session;this.session=null;this.initialized=false;
    if(session) {
      const response=await fetch(this.endpoint,{method:"DELETE",redirect:"error",headers:{"Mcp-Session-Id":session,"MCP-Protocol-Version":this.protocol},signal:AbortSignal.timeout(3000)}).catch(()=>null);
      await response?.body?.cancel().catch(()=>{});
    }
  }
  close() {
    if(!this.closing) {
      this.closed=true;this.lifetime.abort();
      this.closing=(async()=>{await this.initializing?.catch(()=>{});await this.releaseSession();})();
    }
    return this.closing;
  }
}

let sharedNvidiaClient=null;
let nvidiaLifecycle=Promise.resolve();
function withNvidiaLifecycle(action) {
  const task=nvidiaLifecycle.then(action);
  nvidiaLifecycle=task.catch(()=>{});
  return task;
}
async function discoverNvidia(local = process.env.LOCALAPPDATA) {
  return withNvidiaLifecycle(async()=>{
    for (const relative of ["NVIDIA Corporation/NvAppMcpServer/server.json", "NVIDIA Corporation/NVIDIA App/McpServer/server.json"]) {
      let info; try { info=await read(path.join(local,relative)); } catch(error) { if(error.code==="ENOENT") continue; throw error; }
      if(!info.http) throw fail("replay-api-unavailable","NVIDIA MCP HTTP is unavailable. Check NVIDIA App MCP server access and restart NVIDIA App.");
      const endpoint=new URL(info.http);
      if(endpoint.protocol!=="http:" || endpoint.hostname!=="127.0.0.1" || endpoint.username || endpoint.password || !["/mcp","/mcp/"].includes(endpoint.pathname) || endpoint.search || endpoint.hash) throw new Error("Invalid NVIDIA local API endpoint");
      endpoint.pathname="/mcp";
      if(!sharedNvidiaClient || sharedNvidiaClient.closed || sharedNvidiaClient.endpoint.href!==endpoint.href || sharedNvidiaClient.serverPid!==info.pid) {
        await sharedNvidiaClient?.close();
        sharedNvidiaClient=new NvidiaClient(endpoint);
        sharedNvidiaClient.serverPid=info.pid;
      }
      return sharedNvidiaClient;
    }
    await sharedNvidiaClient?.close();sharedNvidiaClient=null;
    return null;
  });
}

async function readNvidia({ signal, local=process.env.LOCALAPPDATA, onDiagnostic } = {}) {
  const root=path.join(local,"NVIDIA Corporation/NVIDIA Overlay");
  const [share,gallery]=await Promise.all([read(path.join(root,"ShareSettings.json")), read(path.join(root,"GallerySettings.json"))]);
  const s=share.settings, g=gallery.settings;
  const client=await discoverNvidia(local);
  let status=null;
  if(client) {
    status=await client.status(signal,onDiagnostic);
    const missing=["desktopCapture","instantReplayEnabled"].filter(key=>typeof status[key]!=="boolean");
    if(missing.length) throw Object.assign(fail("replay-api-status","NVIDIA did not return all required replay status fields."),{details:{missingStatusFields:missing}});
  }
  // Older overlays can use their configured shortcut, but need an explicit
  // current-user Desktop Capture flag; never assume it is on.
  let desktop = status?.desktopCapture;
  if (!client) {
    const text=await run(path.join(process.env.SystemRoot,"System32","reg.exe"), ["query","HKCU\\Software\\NVIDIA Corporation\\Global\\ShadowPlay\\NVSPCAPS","/v","DwmEnabled"], {signal,timeout:5000});
    const flag=text.match(/DwmEnabled\s+REG_DWORD\s+0x([01])\b/i);
    desktop=flag ? flag[1]==="1" : null;
  }
  const settings={ provider:"nvidia", root:g.currentDirectoryV2, bufferSeconds:Number(s.video?.irBufferLength),
    enabled:on(s.video?.irEnabled) && (!status || status.instantReplayEnabled===true), desktop:desktop===true,
    keys:s.shortcuts?.DVRSave, monitor:"", monitorVerified:false, codec:s.codec, fps:s.fps };
  const configuredReplay=switchState(s.video?.irEnabled),reportedReplay=client ? status.instantReplayEnabled : configuredReplay;
  const prerequisites={instantReplay:client ? reportedReplay===false ? false : configuredReplay===true ? true : null : configuredReplay,
    desktopCapture:typeof desktop==="boolean" ? desktop : null};
  return { ...settings, prerequisites, fingerprint:JSON.stringify(settings), ...(client ? {apiProtocol:client.protocol,apiSessionRenewals:client.renewals} : {}), save:sig => client ? client.save(sig) : sendShortcut(settings.keys,sig) };
}

async function readAmd({ signal } = {}) {
  const script=path.join(__dirname.replace(/app\.asar(?=[\\/]|$)/i,"app.asar.unpacked"),"replay-amd-settings.ps1");
  const powershell=path.join(process.env.SystemRoot,"System32","WindowsPowerShell","v1.0","powershell.exe");
  // A read-only command does not change execution policy or registry values.
  const command=await fs.promises.readFile(script,"utf8");
  const data=JSON.parse(await run(powershell,["-NoProfile","-NonInteractive","-Command",command],{signal,timeout:8000}));
  const {prerequisites,hotkeySource,registrySources,registryReadErrors,...settings}=normalizeAmdProfile(data);
  // A source change with identical effective settings must not cancel a replay.
  return {...settings, prerequisites, hotkeySource, registrySources, registryReadErrors,
    fingerprint:JSON.stringify(settings), save:sig=>sendShortcut(settings.keys,sig)};
}

const amdSettingNames=["CaptureFileOutput","SaveInstantReplayHotkey","InstantReplayEnabled","InstantReplayDuration","DesktopRecordingEnabled",
  "DvrEnabled","HotkeysDisabled","DvrDesktops","FileEncoderType","FileCustomFrameRate"];
const optionalAmdSettings=new Set(["HotkeysDisabled","DvrDesktops","FileEncoderType","FileCustomFrameRate"]);
function mergeAmdRegistryProfiles(data) {
  const profiles=data.profiles || [];
  const machineProfiles=data.machineProfiles || [],errors=data.machineErrors || [];
  if(!profiles.length && !machineProfiles.length && !errors.length) throw fail("replay-provider-missing","No AMD replay settings were found in the user or machine registry.");
  const values={},sources={};
  for(const name of amdSettingNames) {
    let candidates=profiles.map((value,i)=>({value:value[name],view:data.profileViews?.[i]})).filter(entry=>entry.value!=null);
    const fallback=!candidates.length;
    if(fallback)candidates=machineProfiles.map(entry=>({value:entry.values[name],view:entry.view})).filter(entry=>entry.value!=null);
    const source={registryPath:fallback ? "HKLM\\SOFTWARE\\AMD\\DVR" : "HKCU\\Software\\AMD\\DVR",registryValue:name,fallback,
      ...(candidates.some(entry=>entry.view) ? {registryViews:candidates.map(entry=>entry.view).filter(Boolean)} : {})};
    if(fallback && errors.length && (candidates.length || !optionalAmdSettings.has(name))) {
      const hotkey=name==="SaveInstantReplayHotkey";
      throw Object.assign(fail(hotkey ? "replay-hotkey-invalid" : "replay-settings-unreadable","AMD machine recording settings could not be read."),
        {details:{...source,provider:"amd",fallbackRegistryErrors:errors,...(hotkey ? {hotkeyIssue:"missing",hotkeyType:"missing",hotkeyValue:null} : {})}});
    }
    if(!candidates.length)continue;
    if(candidates.some(entry=>JSON.stringify(entry.value)!==JSON.stringify(candidates[0].value)))
      throw Object.assign(fail("replay-settings-ambiguous",`AMD ${fallback ? "machine" : "user"} setting ${name} conflicts between registry views.`),
        {details:{...source,provider:"amd"}});
    values[name]=candidates[0].value;sources[name]=source;
  }
  return {values,sources,errors};
}

function normalizeAmdProfile(data) {
  const {values:s,sources:registrySources,errors:registryReadErrors}=mergeAmdRegistryProfiles(data);
  const disabledHotkeys=switchState(s.HotkeysDisabled);
  const prerequisites={instantReplay:switchState(s.InstantReplayEnabled),desktopCapture:switchState(s.DesktopRecordingEnabled),
    recordingFeature:switchState(s.DvrEnabled),recordingService:switchState(data.running),hotkeys:disabledHotkeys===null ? null : !disabledHotkeys};
  let keys;
  const hotkeySource=registrySources.SaveInstantReplayHotkey || {registryPath:"HKCU\\Software\\AMD\\DVR",registryValue:"SaveInstantReplayHotkey",fallback:false};
  try {keys=parseAmdHotkey(s.SaveInstantReplayHotkey);}
  catch(error) {error.details={...error.details,...hotkeySource,provider:"amd",prerequisites,registrySources};throw error;}
  const root=String(s.CaptureFileOutput || "").replace(/%([^%]+)%/g, (_,n)=>process.env[n] || `%${n}%`);
  const settings={provider:"amd", root, bufferSeconds:Number(s.InstantReplayDuration), enabled:on(s.InstantReplayEnabled) && on(s.DvrEnabled) && data.running===true,
    desktop:on(s.DesktopRecordingEnabled), keys, hotkeysDisabled:on(s.HotkeysDisabled),
    monitor:String(s.DvrDesktops || ""), monitorVerified:false, codec:s.FileEncoderType, fps:s.FileCustomFrameRate};
  return {...settings,prerequisites,hotkeySource,registrySources,registryReadErrors};
}

function validateSettings(s, {before,after,deviceName,displayCount} = {}) {
  if(!s.enabled || !s.desktop || s.hotkeysDisabled) throw Object.assign(fail("replay-not-enabled","Enable Overlay, Desktop Capture and Instant Replay in the GPU recording software first."),
    {details:{provider:s.provider,prerequisites:s.prerequisites || {}}});
  if(!Number.isFinite(s.bufferSeconds) || s.bufferSeconds<=0) throw fail("replay-buffer-short","The GPU Instant Replay buffer length is missing or invalid.");
  if(!path.isAbsolute(s.root || "")) throw fail("replay-folder-missing","The GPU replay save folder is unavailable.");
  if(s.provider==="amd" && s.monitor && deviceName && s.monitor.toLowerCase()!==deviceName.toLowerCase()) throw fail("replay-monitor-mismatch","AMD Replay is configured for another monitor. Select the notification monitor in AMD first.");
  // NVIDIA exposes no verified display identity in this API. Multiple displays
  // require the explicit acknowledgement in Settings, not a guessed mapping.
  s.monitorVerified=displayCount===1 || !!(s.provider==="amd" && s.monitor && deviceName);
  return s;
}

async function closeReplayProviders() {
  await withNvidiaLifecycle(async()=>{
    const client=sharedNvidiaClient;sharedNvidiaClient=null;
    await client?.close();
  });
}
module.exports={ parseAmdHotkey, normalizeAmdProfile, nativeKeyboard, sendShortcut, NvidiaClient, discoverNvidia, readNvidia, readAmd, validateSettings, closeReplayProviders };
