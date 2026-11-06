"use strict";
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const RETAIN_MS = 145_000; // Maximum 120s pre-roll + 20s pending selection + margin.
const MAX_SOURCES = 32, MAX_BYTES = 16 * 1024 ** 3;
const failure = (message, code = "replay-history-missing") => Object.assign(new Error(message), { code });
const contextKey = settings => JSON.stringify([settings.provider, settings.root, settings.fingerprint, settings.monitorSignature]);

class ReplaySourceHistory {
  constructor({ root, emit, now }) { Object.assign(this, { root, emit, now }); this.entries = []; }
  async persist(entry) {
    if (!this.root) return;
    await fs.promises.mkdir(this.root, { recursive: true });
    const file = path.join(this.root, `source-${entry.id}.json`);
    await fs.promises.writeFile(`${file}.tmp`, JSON.stringify({ ...entry, updatedAt: new Date().toISOString() }));
    await fs.promises.rename(`${file}.tmp`, file);
  }
  checkCapacity() {
    if (this.entries.length >= MAX_SOURCES || this.entries.reduce((n, e) => n + e.stat.size, 0) >= MAX_BYTES)
      throw failure("Replay source retention reached its safety limit. Existing sources were kept.", "replay-history-full");
  }
  async add(found, settings, sentAt, { sourceConfirmed = false } = {}) {
    const entry = { id: randomUUID(), key: contextKey(settings), provider: settings.provider, file: found.file,
      stat: { size: found.stat.size, mtimeMs: found.stat.mtimeMs }, metadata: found.metadata,
      start: sentAt - found.metadata.duration * 1000, end: sentAt, published: false, pinned: false, sourceConfirmed:sourceConfirmed===true };
    this.entries.push(entry);
    try { await this.persist(entry); } catch (error) { entry.pinned = true; this.emit("source-retained", { source: entry.file, reason: `journal-write-failed: ${error.message}` }); }
    return entry;
  }
  plan(settings, start, end) {
    const entries = this.entries.filter(e => e.key === contextKey(settings));
    let current = entries.filter(e => e.start <= start && e.end > start).sort((a, b) => b.end - a.end)[0];
    if (!current) throw failure("Retained replay sources do not contain the requested pre-notification history.");
    const chain = [current];
    while (current.end < end) {
      // Only timestamp rounding is tolerated; do not bridge missing video.
      const next = entries.filter(e => e.start <= current.end + 2 && e.start > current.start && e.end > current.end)
        .sort((a, b) => b.end - a.end)[0];
      if (!next) {
        const following=entries.filter(e=>e.start>current.end).sort((a,b)=>a.start-b.start)[0];
        const error=failure("There is a gap between the available replay segments.", "replay-history-gap");
        error.details={gapMs:following ? Math.round((following.start-current.end)*1000)/1000 : null,previousSource:current.file,nextSource:following?.file||null};
        throw error;
      }
      chain.push(next); current = next;
    }
    return chain;
  }
  intervals(settings) {
    const ranges=[];
    for(const entry of this.entries.filter(e=>e.key===contextKey(settings)).sort((a,b)=>a.start-b.start)) {
      const last=ranges.at(-1);
      if(last && entry.start<=last.end+2) last.end=Math.max(last.end,entry.end);
      else ranges.push({start:entry.start,end:entry.end});
    }
    return ranges;
  }
  coveredUntil(settings,start) {
    return this.intervals(settings).find(range=>range.start<=start && range.end>start)?.end ?? start;
  }
  // Prefer the complete requested interval. Otherwise select a continuous
  // available portion, preserving the notification when that moment exists.
  // Strict plan() still validates every selected chain; gaps are never filled.
  planAvailable(settings,start,end,visibleAt) {
    const ranges=this.intervals(settings);
    if(!ranges.length) throw failure("No replay source is available.");
    const full=ranges.find(range=>range.start<=start && range.end>=end);
    const overlap=range=>Math.max(0,Math.min(end,range.end)-Math.max(start,range.start));
    const distance=range=>Math.max(range.start-visibleAt,visibleAt-range.end,0);
    const range=full || ranges.find(range=>range.start<=visibleAt && range.end>=visibleAt) ||
      [...ranges].sort((a,b)=>overlap(b)-overlap(a) || distance(a)-distance(b))[0];
    let actualStart=Math.max(start,range.start),actualEnd=Math.min(end,range.end);
    if(actualEnd<=actualStart) {
      // The event has already left the available history. Keep the nearest
      // remaining material, limited to the requested total length.
      const length=end-start;
      if(end<=range.start) {actualStart=range.start;actualEnd=Math.min(range.end,range.start+length);}
      else {actualEnd=range.end;actualStart=Math.max(range.start,range.end-length);}
    }
    const reasons=[];
    if(actualStart>start+2) reasons.push("before-unavailable");
    if(actualEnd<end-2) reasons.push("after-unavailable");
    const notificationIncluded=actualStart<=visibleAt && actualEnd>=visibleAt;
    if(!notificationIncluded) reasons.push("notification-unavailable");
    return {sources:this.plan(settings,actualStart,actualEnd),start:actualStart,end:actualEnd,
      coverage:{partial:reasons.length>0,partialReasons:reasons,
        requestedBeforeSeconds:(visibleAt-start)/1000,requestedAfterSeconds:(end-visibleAt)/1000,
        selectedBeforeSeconds:Math.max(0,Math.min(visibleAt,actualEnd)-actualStart)/1000,
        selectedAfterSeconds:Math.max(0,actualEnd-Math.max(visibleAt,actualStart))/1000,notificationIncluded}};
  }
  covers(settings, start, end) { try { this.plan(settings, start, end); return true; } catch { return false; } }
  async assertUnchanged(entries) {
    for (const entry of entries) {
      const stat = await fs.promises.lstat(entry.file), real = await fs.promises.realpath(entry.file);
      if (!stat.isFile() || stat.size !== entry.stat.size || stat.mtimeMs !== entry.stat.mtimeMs || real.toLowerCase() !== path.resolve(entry.file).toLowerCase()) {
        entry.pinned = true;
        throw failure("A retained GPU replay was replaced or modified; it will not be joined or deleted.", "replay-source-changed");
      }
    }
  }
  async mark(entries, published) {
    for (const entry of entries) {
      if (published) entry.published = true; else entry.pinned = true;
      await this.persist(entry).catch(error => { entry.pinned = true; this.emit("source-retained", { source: entry.file, reason: error.message }); });
    }
  }
  async cleanup({ force = false, jobs = [] } = {}) {
    for (const entry of [...this.entries]) {
      if (entry.pinned || !entry.published || (!force && this.now() - entry.end < RETAIN_MS)) continue;
      if (jobs.some(j => j.protectedSources?.some(source=>source.id===entry.id) ||
          (j.provider === entry.provider && j.visibleAt - j.before * 1000 < entry.end && j.visibleAt + j.after * 1000 > entry.start))) continue;
      try {
        if(entry.sourceConfirmed) {
          await this.assertUnchanged([entry]);
          await fs.promises.unlink(entry.file);
        }
        this.entries.splice(this.entries.indexOf(entry), 1);
        if(entry.sourceConfirmed) this.emit("source-removed", { source: entry.file, reason: force ? "controller-stopped" : "history-no-longer-needed" });
        else this.emit("source-retained", {source:entry.file,reason:"ownership-unconfirmed",retired:true});
        if (this.root) await fs.promises.rm(path.join(this.root, `source-${entry.id}.json`), { force: true }).catch(error=>this.emit("recovery",{source:entry.file,reason:`Source history retired, but its diagnostic journal could not be removed: ${error.message}`}));
      } catch (error) { entry.pinned = true; this.emit("source-retained", { source: entry.file, reason: error.message }); }
    }
  }
}
module.exports = { ReplaySourceHistory, contextKey, RETAIN_MS };
