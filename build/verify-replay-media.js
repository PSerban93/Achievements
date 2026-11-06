"use strict";
const fs=require("fs"),path=require("path"),crypto=require("crypto");
const {execFile}=require("child_process");
const {promisify}=require("util");
async function verify(root=path.resolve(__dirname,"../utils/vendor/replay-media")) {
  const m=JSON.parse(await fs.promises.readFile(path.join(root,"manifest.json"),"utf8"));
  if(!m.files?.["ffmpeg.exe"] || !m.files?.["ffprobe.exe"]) throw new Error("Incomplete replay runtime manifest");
  for(const [name,expected] of Object.entries({...m.files,[m.sourceArchive]:m.source.sha256})) {
    if(path.basename(name)!==name) throw new Error("Invalid replay runtime manifest path");
    const data=await fs.promises.readFile(path.join(root,name));
    const actual=crypto.createHash("sha256").update(data).digest("hex");
    // electron-builder can add an Authenticode signature after packing. Verify
    // the executable content as well, using the native helper integrity rule.
    if(actual!==expected && (!m.executableContentHashes?.[name] || require("./windows-executable-integrity").executableContentHash(data)!==m.executableContentHashes[name])) throw new Error(`Replay runtime integrity mismatch: ${name}`);
  }
  for(const name of ["COPYING.LGPLv2.1","COPYING.GPLv2","COPYING.MinGW-w64-runtime.txt","config.log"]) if(!fs.existsSync(path.join(root,name))) throw new Error(`Replay media licensing/build information missing: ${name}`);
  if(process.platform==="win32") {
    for(const name of ["ffmpeg.exe","ffprobe.exe"]) {
      const result=await promisify(execFile)(path.join(root,name),["-version"],{windowsHide:true,timeout:10000});
      if(/--enable-(?:gpl|nonfree|version3)\b/.test(result.stdout)) throw new Error("Unexpected FFmpeg license configuration");
    }
  }
  return m;
}
if(require.main===module) verify(process.argv[2]).then(()=>console.log("Replay media runtime and corresponding source verified.")).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={verify};
