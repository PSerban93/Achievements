"use strict";

// Reproducible Windows x64 stream-copy-only FFmpeg. The compiler and build
// tree live in the OS temp folder; neither is installed or shipped.
const fs=require("fs"), path=require("path"), os=require("os"), crypto=require("crypto");
const {execFile}=require("child_process");
const {promisify}=require("util");
const exec=promisify(execFile);
const root=path.resolve(__dirname,".."), output=path.join(root,"utils/vendor/replay-media");
const version="8.1.3";
const source={url:`https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz`,sha256:"7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3"};
const compiler={url:"https://github.com/skeeto/w64devkit/releases/download/v2.11.0/w64devkit-x64-2.11.0.7z.exe",sha256:"54c2bb9962e8a30c8270e34c5efc3d5fee579f53087fa7d435b95fbba2af7b2b"};
const flags=["--target-os=mingw32","--arch=x86_64","--disable-autodetect","--disable-everything","--disable-network","--disable-debug","--disable-doc",
  "--disable-shared","--enable-static","--disable-ffplay","--disable-avdevice","--enable-avfilter","--enable-ffmpeg","--enable-ffprobe","--disable-swscale","--disable-swresample","--disable-x86asm",
  "--enable-protocol=file","--enable-demuxer=mov,concat","--enable-muxer=mp4","--enable-parser=h264,hevc,av1,aac","--enable-bsf=extract_extradata,aac_adtstoasc,av1_metadata,h264_mp4toannexb"];
const hash=buffer=>crypto.createHash("sha256").update(buffer).digest("hex");
async function download(info,file) {
  if(fs.existsSync(file) && hash(await fs.promises.readFile(file))===info.sha256) return;
  const response=await fetch(info.url,{signal:AbortSignal.timeout(180_000)});
  if(!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const data=Buffer.from(await response.arrayBuffer());
  if(hash(data)!==info.sha256) throw new Error("Replay media source/compiler hash mismatch");
  await fs.promises.writeFile(file,data);
}
async function main() {
  if(process.platform!=="win32") {console.log("Replay media preparation skipped outside Windows.");return;}
  if(fs.existsSync(path.join(output,"manifest.json"))) {
    const {verify}=require("./verify-replay-media");const existing=await verify(output);
    if(existing.version===version && existing.source.sha256===source.sha256 && existing.compiler.sha256===compiler.sha256 && JSON.stringify(existing.configure)===JSON.stringify(flags)) {
      console.log("Replay media runtime verified; no download or rebuild needed.");return;
    }
  }
  const work=path.join(os.tmpdir(),"Achievements-Replay-Media-8.1.3-v1"); await fs.promises.mkdir(work,{recursive:true});
  const archive=path.join(work,"source.tar.xz"), toolchain=path.join(work,"w64devkit.7z.exe");
  await Promise.all([download(source,archive),download(compiler,toolchain)]);
  const bin=path.join(work,"w64devkit/bin");
  if(!fs.existsSync(path.join(bin,"gcc.exe"))) await exec(toolchain,["-y",`-o${work}`],{windowsHide:true,maxBuffer:1024*1024});
  const src=path.join(work,`ffmpeg-${version}`);
  if(!fs.existsSync(path.join(src,"configure"))) await exec(path.join(process.env.SystemRoot,"System32/tar.exe"),["-xf",archive,"-C",work],{windowsHide:true});
  const build=path.join(work,"build");await fs.promises.mkdir(build,{recursive:true});
  const env={...process.env,PATH:`${bin};${process.env.PATH}`,CC:"gcc",SHELL:"sh"};
  console.log("Configuring minimal LGPL FFmpeg (file/MP4, compressed video/audio copy only)...");
  try {
    await exec(path.join(bin,"sh.exe"),[path.join(src,"configure").replace(/\\/g,"/"),...flags],{cwd:build,env,windowsHide:true,timeout:120_000,maxBuffer:2*1024*1024});
    await exec(path.join(bin,"make.exe"),[`-j${Math.min(6,os.availableParallelism())}`,"SHELL=sh","ffmpeg.exe","ffprobe.exe"],{cwd:build,env,windowsHide:true,timeout:600_000,maxBuffer:16*1024*1024});
  } catch(error) {await fs.promises.writeFile(path.join(work,"build-error.log"),String(error.stdout||"")+String(error.stderr||error));throw new Error(`Replay media build failed. See ${path.join(work,"build-error.log")}`);}
  await fs.promises.mkdir(output,{recursive:true});
  const files={},executableContentHashes={};
  for(const name of ["ffmpeg.exe","ffprobe.exe"]) {const data=await fs.promises.readFile(path.join(build,name));await fs.promises.writeFile(path.join(output,name),data);files[name]=hash(data);executableContentHashes[name]=require("./windows-executable-integrity").executableContentHash(data);}
  await fs.promises.copyFile(archive,path.join(output,`ffmpeg-${version}-source.tar.xz`));
  for(const name of ["COPYING.LGPLv2.1","COPYING.GPLv2"]) await fs.promises.copyFile(path.join(src,name),path.join(output,name));
  const log=await fs.promises.readFile(path.join(build,"ffbuild/config.log"),"utf8");
  let publicLog=log;
  for(const [folder,label] of [[work,"BUILD_ROOT"],[os.tmpdir(),"TEMP_DIR"],[os.homedir(),"USER_HOME"]]) {
    publicLog=publicLog.split(folder.replace(/\\/g,"/")).join(label).split(folder).join(label);
  }
  await fs.promises.writeFile(path.join(output,"config.log"),publicLog);
  await fs.promises.copyFile(path.join(work,"w64devkit/COPYING.MinGW-w64-runtime.txt"),path.join(output,"COPYING.MinGW-w64-runtime.txt"));
  const manifest={version,license:"LGPL-2.1-or-later",source,compiler,configure:flags,files,executableContentHashes,sourceArchive:`ffmpeg-${version}-source.tar.xz`,modifiedSources:false};
  await fs.promises.writeFile(path.join(output,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
  const {verify}=require("./verify-replay-media"); await verify(output);
  console.log(`Replay media ready at ${output}`);
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={flags,source,compiler};
