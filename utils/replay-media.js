"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const MINOR_AUDIO_DISCONTINUITY_SECONDS = 0.025;

function mediaTools(root = path.join(__dirname.replace(/app\.asar(?=[\\/]|$)/i, "app.asar.unpacked"), "vendor", "replay-media")) {
  const tools = Object.fromEntries(["ffmpeg", "ffprobe"].map(name => [name, path.join(root, `${name}.exe`)]));
  for (const file of Object.values(tools)) if (!fs.existsSync(file)) {
    throw Object.assign(new Error("Replay media tools are missing. Run npm run prepare:replay-media before building."), { code: "replay-tools-missing" });
  }
  return tools;
}

function run(file, args, { signal, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => execFile(file, args, {
    windowsHide: true, shell: false, signal, timeout, maxBuffer: 4 * 1024 * 1024,
  }, (error, stdout, stderr) => {
    if (error) {
      error.message = `${path.basename(file)}: ${String(stderr || error.message).slice(-2500)}`;
      reject(error);
    } else resolve(stdout);
  }));
}

async function probe(file, { tools = mediaTools(), signal } = {}) {
  const metadata = JSON.parse(await run(tools.ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", file], { signal, timeout: 15_000 }));
  const video = metadata.streams?.find(s => s.codec_type === "video");
  const duration = Number(video?.duration || metadata.format?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0 || !["h264", "hevc", "av1"].includes(video.codec_name)) {
    throw Object.assign(new Error("Replay is incomplete or uses an unsupported video codec."), { code: "replay-invalid-media" });
  }
  return { ...metadata, duration, video, audio: metadata.streams.filter(s => s.codec_type === "audio") };
}

function streamSignature(metadata) {
  return JSON.stringify([metadata.video, ...metadata.audio].map(s => Object.fromEntries(
    ["codec_type", "codec_name", "profile", "width", "height", "pix_fmt", "time_base", "sample_rate", "channels", "channel_layout", "color_transfer", "color_primaries", "color_space"]
      .map(key => [key, s[key] ?? null]))));
}

async function seamOutpoint(file, seconds, duration, { tools, signal, fps }) {
  // FFmpeg's concat outpoint is a decoding timestamp, not a presentation
  // timestamp. At a B-frame boundary using PTS directly duplicates/drops frames.
  if (seconds >= duration - 0.001) return null; // Keep the complete final GOP.
  const packets = JSON.parse(await run(tools.ffprobe, ["-v", "error", "-select_streams", "v:0", "-read_intervals", `${Math.max(0, seconds-2).toFixed(6)}%${(seconds+.2).toFixed(6)}`,
    "-show_packets", "-show_entries", "packet=pts_time,dts_time,flags", "-of", "json", file], { tools, signal, timeout: 15_000 })).packets || [];
  const near = packets.filter(p => Math.abs(Number(p.pts_time)-seconds)<Math.min(.05,Number.isFinite(fps)&&fps>0 ? .6/fps : .002))
    .sort((a,b)=>Math.abs(Number(a.pts_time)-seconds)-Math.abs(Number(b.pts_time)-seconds));
  const reordered=packets.some(p=>Math.abs(Number(p.pts_time)-Number(p.dts_time))>.00001);
  const boundary = near.find(p=>p.flags?.includes("K")) || (!reordered && near[0]);
  if (!boundary || !Number.isFinite(Number(boundary.dts_time))) throw Object.assign(new Error("Replay overlap has no safe compressed-video join boundary. Sources were kept."), { code: "replay-segment-boundary-unsupported" });
  return Number(boundary.dts_time);
}

async function validateJoinedAudio(file,{streams,boundaries,duration,tools=mediaTools(),signal}) {
  const warnings=[];
  if(!streams.length) return warnings;
  for(const boundary of [...new Set(boundaries)].filter(time=>time>0 && time<duration)) {
    // Probe only around seams, keeping output bounded even for long clips and
    // multiple audio tracks. Video frame hashes do not establish audio safety.
    const packets=JSON.parse(await run(tools.ffprobe,["-v","error","-select_streams","a","-read_intervals",`${Math.max(0,boundary-.3).toFixed(6)}%${Math.min(duration,boundary+.3).toFixed(6)}`,
      "-show_packets","-show_entries","packet=stream_index,pts_time,duration_time","-of","json",file],{signal,timeout:15_000})).packets || [];
    for(const stream of streams) {
      const samples=packets.filter(packet=>packet.stream_index===stream.index && Number(packet.pts_time)>=0 && Number(packet.pts_time)<duration);
      const tolerance=Math.max(.000005,2/(Number(stream.sample_rate)||48000));
      const lengths=samples.map(packet=>Number(packet.duration_time)).filter(value=>Number.isFinite(value)&&value>0).sort((a,b)=>a-b);
      // MP4 may stretch an AAC packet's declared duration to conceal a gap.
      // Compare with the observed normal packet duration as well as PTS gaps.
      const nominal=stream.codec_name==="aac" && lengths.length>=5 ? lengths[Math.floor(lengths.length/2)] : null;
      let previous,count=0,maxOverlap=0,maxGap=0;
      for(const packet of samples) {
        const pts=Number(packet.pts_time),length=Number(packet.duration_time);
        if(!Number.isFinite(pts) || !Number.isFinite(length) || length<=0) throw Object.assign(new Error("Replay audio packet timing is unavailable at a join."),{code:"replay-audio-timestamps-unavailable"});
        if(nominal && length-nominal>MINOR_AUDIO_DISCONTINUITY_SECONDS+tolerance) throw Object.assign(new Error("Replay audio has a large packet-duration discontinuity at a join; sources were retained."),{
          code:"replay-audio-discontinuity",details:{audioTrack:stream.index,boundarySeconds:boundary,packetDurationMs:length*1000,nominalPacketDurationMs:nominal*1000}});
        if(previous) {
          const gap=pts-previous.end;
          if(Math.abs(gap)>tolerance) {
            if(Math.abs(gap)>MINOR_AUDIO_DISCONTINUITY_SECONDS+tolerance) throw Object.assign(new Error("Replay audio has a large overlap or gap at a segment join; sources were retained."),{
              code:"replay-audio-discontinuity",details:{audioTrack:stream.index,boundarySeconds:boundary,gapMs:gap*1000,previousPts:previous.pts,nextPts:pts}});
            // Preserve the clip for small packet-boundary deviations (including
            // the observed ~21ms AAC overlap). Report, do not recode or fail it.
            count++;maxOverlap=Math.max(maxOverlap,-gap);maxGap=Math.max(maxGap,gap);
          }
        }
        previous={pts,end:pts+length};
      }
      if(!samples.some(packet=>Number(packet.pts_time)<=boundary+tolerance) || !samples.some(packet=>Number(packet.pts_time)+Number(packet.duration_time)>=boundary-tolerance))
        throw Object.assign(new Error("Replay audio does not cover a segment join."),{code:"replay-audio-discontinuity",details:{audioTrack:stream.index,boundarySeconds:boundary}});
      if(count) warnings.push({code:"replay-audio-minor-discontinuity",audioTrack:stream.index,boundarySeconds:boundary,count,maxOverlapMs:maxOverlap*1000,maxGapMs:maxGap*1000});
    }
  }
  return warnings;
}

async function trimReplay({ source, sources, output, start, duration, tools = mediaTools(), signal, beforePublish }) {
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0) throw new Error("Invalid replay interval");
  const input = await probe(source, { tools, signal });
  const staging = path.join(path.dirname(output), `.${path.basename(output)}.${require("crypto").randomUUID()}.partial.mp4`);
  const listFile = `${staging}.ffconcat`;
  try {
    let inputArgs = ["-i", source], available = input.duration, reorderSeconds = 0;
    if (sources?.length > 1) {
      const lines = ["ffconcat version 1.0"];
      for (let i = 0; i < sources.length; i++) {
        const entry = sources[i], info = i ? await probe(entry.file, { tools, signal }) : input;
        if (!path.isAbsolute(entry.file) || /[\r\n\0]/.test(entry.file) || !Number.isFinite(entry.start) || !Number.isFinite(entry.end) || entry.end <= entry.start)
          throw new Error("Invalid replay source segment");
        if (streamSignature(info) !== streamSignature(input)) throw Object.assign(new Error("Successive replay segments have incompatible video/audio formats."), { code: "replay-segments-incompatible" });
        // Joining stream copies requires the new segment to start independently.
        // Never concatenate arbitrary non-keyframe fragments or synthesize frames.
        if (i) {
          const packets = JSON.parse(await run(tools.ffprobe, ["-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1", "-show_packets", "-show_entries", "packet=pts_time,dts_time,flags", "-of", "json", entry.file], { signal, timeout: 15_000 })).packets;
          if (!packets?.[0]?.flags?.includes("K") || Math.abs(Number(packets[0].pts_time)) > 0.1)
            throw Object.assign(new Error("The next replay segment does not begin with an independent video frame."), { code: "replay-segment-keyframe-missing" });
          reorderSeconds=Math.max(reorderSeconds,Number(packets[0].pts_time)-Number(packets[0].dts_time));
        }
        const seconds = i + 1 < sources.length ? (sources[i + 1].start - entry.start) / 1000 : info.duration;
        if (seconds <= 0 || seconds > info.duration + 0.02) throw Object.assign(new Error("Replay segments do not cover a continuous interval."), { code: "replay-history-gap" });
        // ffconcat quoting, not shell quoting. Paths came from the associated
        // local GPU files, and file is the only enabled runtime protocol.
        const rate=String(info.video.avg_frame_rate).split("/").map(Number);
        const outpoint = i + 1 < sources.length ? await seamOutpoint(entry.file,seconds,info.duration,{tools,signal,fps:rate[0]/rate[1]}) : null;
        lines.push(`file '${entry.file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`);
        if(outpoint!==null) lines.push(`outpoint ${outpoint.toFixed(6)}`);
        lines.push(`duration ${seconds.toFixed(6)}`);
      }
      available = (sources.at(-1).end - sources[0].start) / 1000;
      await fs.promises.writeFile(listFile, lines.join("\n") + "\n", { flag: "wx" });
      inputArgs = ["-f", "concat", "-safe", "0", "-i", listFile];
    }
    if (start + duration > available + 0.1) throw Object.assign(new Error("Replay does not contain the requested interval."), { code: "replay-history-missing" });
    // Copy all audio tracks and the original compressed video. Never silently
    // transcode, tone-map HDR, or invoke another capture device.
    await run(tools.ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-n", "-ss", start.toFixed(6), ...inputArgs,
      "-t", duration.toFixed(6), "-map", "0:v:0", "-map", "0:a?", "-map_metadata", "0", "-c", "copy",
      "-movflags", "+faststart", staging], { signal });
    const result = await probe(staging, { tools, signal });
    const frameRate = String(input.video.avg_frame_rate).split("/").map(Number);
    const fps = frameRate[0] / frameRate[1];
    const tolerance = Math.max(0.15, Number.isFinite(fps) && fps > 0 ? 2/fps+(sources?.length>1 ? reorderSeconds+.03 : 0) : 0.15);
    const audioChanged=input.audio.some((audio,i)=>["codec_name","sample_rate","channels","channel_layout"].some(key=>audio[key] && audio[key]!==result.audio[i]?.[key]));
    if (Math.abs(result.duration - duration) > tolerance || result.audio.length !== input.audio.length ||
        audioChanged ||
        result.video.codec_name !== input.video.codec_name || result.video.width !== input.video.width ||
        result.video.height !== input.video.height || result.video.pix_fmt !== input.video.pix_fmt ||
        ["color_transfer", "color_primaries", "color_space"].some(key => input.video[key] && result.video[key] !== input.video[key])) {
      throw Object.assign(new Error(`Replay output did not preserve its duration, tracks or video format (requested ${duration}s, received ${result.duration}s, audio ${input.audio.length}/${result.audio.length}).`), { code: "replay-output-mismatch" });
    }
    const audioWarnings=sources?.length>1 ? await validateJoinedAudio(staging,{streams:result.audio,boundaries:sources.slice(1).map(entry=>(entry.start-sources[0].start)/1000-start),duration:result.duration,tools,signal}) : [];
    // The caller owns a zero-byte reservation. Do not overwrite any media.
    const reserved = await fs.promises.lstat(output);
    if (!reserved.isFile() || reserved.size !== 0) throw new Error("Replay destination is no longer reserved");
    await beforePublish?.();
    signal?.throwIfAborted();
    await fs.promises.rename(staging, output);
    return { duration: result.duration, codec: result.video.codec_name, audioTracks: result.audio.length, reencoded: false, sourceCount: sources?.length || 1,
      ...(audioWarnings.length ? {audioWarnings} : {}) };
  } finally {
    await fs.promises.rm(staging, { force: true }).catch(() => {});
    await fs.promises.rm(listFile, { force: true }).catch(() => {});
  }
}

module.exports = { mediaTools, probe, run, trimReplay, streamSignature, validateJoinedAudio };
