// node make-z2-lua.js <z2r-rom.nes> [pack.json5 ...]
// Finds each pack track inside a Z2R ROM (music banks 16-23, 8 KB each, mapped at $A000) and writes music-now.lua for it.
// Prints only counts; track names stay in the Lua file.
const fs = require("fs"), path = require("path");
const c = require("./core.js");
const [rom, ...given] = process.argv.slice(2);
const PACKS = given.length ? given : (fs.existsSync(path.join(__dirname, "packs-z2r.txt")) ? fs.readFileSync(path.join(__dirname, "packs-z2r.txt"), "utf8").split("\n").map(l => l.trim()).filter(Boolean) : []);
if (!rom || !PACKS.length) { console.log("Usage: node make-z2-lua.js <rom.nes> [pack.json5 ...]  (or list your packs in packs-z2r.txt, one path per line)"); process.exit(1); }
const R = fs.readFileSync(rom), HEADER = 0x10, BANK = 0x2000, FIRST = 16, LAST = 27;   // banks 28+ are game code

// share of the track's first 600 bytes that match the ROM at `at`, counting 16-bit words that all moved by the same amount (relocated pointers)
function similarity(at, b) {
  const len = Math.min(b.length, 600); if (at < 0 || at + len > R.length) return 0;
  let same = 0; const shifts = new Map();
  for (let i = 0; i < len; i++) {
    if (R[at + i] === b[i]) same++;
    if (i + 1 < len) { const d = ((R[at + i] | R[at + i + 1] << 8) - (b[i] | b[i + 1] << 8)) & 0xFFFF; if (d) shifts.set(d, (shifts.get(d) || 0) + 1); }
  }
  let moved = 0; for (const v of shifts.values()) if (v > moved) moved = v;
  return (same + 2 * moved) / len;
}
const found = [];
for (const file of PACKS.filter(p => fs.existsSync(p))) {
  const pack = c.parseJson5(fs.readFileSync(file, "utf8"));
  for (const g of pack.groups) for (const it of g.items) {
    if (!it.data) continue;
    let b; try { b = Buffer.from(c.fromBase64(it.data)); } catch (e) { continue; }
    if (b.length < 80) continue;
    // Locate the track: short chunks of it vote for where it starts in the ROM (a chunk holding a relocated pointer simply doesn't vote),
    // then the best start is checked against the track with pointer shifts allowed for.
    const votes = new Map();
    for (let s = 32; s + 8 <= Math.min(b.length, 640); s += 12) {
      const chunk = b.subarray(s, s + 8); let from = 0, n = 0, at;
      while (n < 4 && (at = R.indexOf(chunk, from)) >= 0) { votes.set(at - s, (votes.get(at - s) || 0) + 1); from = at + 1; n++; }
    }
    let at = -1, top = 0;
    for (const [o, v] of votes) if (v > top) { top = v; at = o; }
    if (top < 3) continue;
    if (similarity(at, b) < 0.6) continue;
    const bank = (at - HEADER) >> 13;
    if (bank < FIRST || bank > LAST) continue;
    const lo = 0xA000 + ((at - HEADER) & (BANK - 1));
    found.push({ bank, lo, hi: lo + b.length - 1, uses: (it.uses || []).join("/"), name: `${it.title.replace(/^\s*\d+\s*[-.–]\s*/, "")} (${g.title})` });
  }
}
// a track whose range sits inside another found track's range in the same bank is a lookalike: keep the longer one
const keep = found.filter(a => !found.some(o => o !== a && o.bank === a.bank && o.lo <= a.lo && o.hi >= a.hi && (o.hi - o.lo > a.hi - a.lo || (o.hi - o.lo === a.hi - a.lo && found.indexOf(o) < found.indexOf(a)))));
if (!keep.length) { console.log("No pack track found in this ROM. Not written."); process.exit(1); }
const rows = keep.map(s => `  { bank = ${s.bank}, lo = 0x${s.lo.toString(16)}, hi = 0x${s.hi.toString(16)}, uses = ${JSON.stringify(s.uses)}, name = ${JSON.stringify(s.name)} },`).join("\n");
const lua = fs.readFileSync(path.join(__dirname, "template-z2.lua"), "utf8").replace("--SONGS--", rows).replace("--ROM--", path.basename(rom));
fs.writeFileSync(path.join(__dirname, "music-now.lua"), lua);
console.log(`Found ${keep.length} songs in this ROM (${new Set(keep.map(s => s.bank)).size} banks).`);
