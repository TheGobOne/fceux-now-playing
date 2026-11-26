// node make-music-lua.js <rom.nes> [pack.json5 or folder ...]
// Matches each music slot of a ZORA ROM to the track in your pack and writes music-now-zora.lua (names inside) next to the ROM's folder.
// Prints only how sure it is; track names stay in the Lua file.
// Pack list: the arguments, or packs-zora.txt (one path per line). A path can be a .json5 file or a folder (searched for .json5 files).
const fs = require("fs"), path = require("path");
const c = require("./core.js");
const { foldName } = require("./fold.js");
const t0 = Date.now();
const [rom, ...given] = process.argv.slice(2);
const listPacks = p => {
  let st; try { st = fs.statSync(p); } catch (e) { return []; }
  if (!st.isDirectory()) return [p];
  return fs.readdirSync(p, { withFileTypes: true }).flatMap(e => e.isDirectory() ? listPacks(path.join(p, e.name)) : /\.json5$/i.test(e.name) ? [path.join(p, e.name)] : []);
};
const PACK_LIST = given.length ? given : (fs.existsSync(path.join(__dirname, "packs-zora.txt")) ? fs.readFileSync(path.join(__dirname, "packs-zora.txt"), "utf8").split("\n").map(l => l.trim()).filter(Boolean) : []);
const PACKS = [...new Set(PACK_LIST.flatMap(listPacks))];
if (!rom || !PACKS.length) { console.log("Usage: node make-music-lua.js <rom.nes> [pack.json5 or folder ...]  (or list your packs or pack folders in packs-zora.txt, one path per line)"); process.exit(1); }
const R = fs.readFileSync(rom), HEADER = 0x10, TABLE = 0x10, ADDR = 0x90;
const SONGS = { overworld: 0, ending: 4, level9: 5, title: 7, level1: 6, level2: 11, level3: 12, level4: 13, level5: 14, level6: 15, level7: 16, level8: 17 };

// Two ROM layouts: ZORA 2.x (MMC3, 8 KB banks seen at $A000) and the older one (16 KB banks at $8000).
// The mapper number picks the likelier layout first; the other wins only if more of the 12 song slots fall inside the ROM under it.
const L8 = { name: "8KB banks at $A000", BANK: 0x2000, BASE: 0xA000 }, L16 = { name: "16KB banks at $8000", BANK: 0x4000, BASE: 0x8000 };
const slotOff = (n, L) => HEADER + (R[TABLE + 2 * n] ^ 0xFF) * L.BANK + ((R[ADDR + 2 * n] | (R[ADDR + 2 * n + 1] << 8)) - L.BASE);
const inRange = L => Object.values(SONGS).filter(n => { const o = slotOff(n, L); return o >= HEADER && o + 16 <= R.length; }).length;
const mapper = (R[6] >> 4) | (R[7] & 0xF0);
const order = mapper === 4 ? [L8, L16] : [L16, L8];
const LAYOUT = inRange(order[1]) > inRange(order[0]) ? order[1] : order[0];

// Only the first 1500 bytes of each track are compared, so only the first 2000 base64 characters are kept.
// The parsed result is cached in pack-cache.json until a pack file's size or modified time changes.
const CACHE = path.join(__dirname, "pack-cache.json"), PREFIX_CHARS = 2000;
function loadCands(files) {
  const sig = files.map(f => { const s = fs.statSync(f); return `${f}|${s.size}|${s.mtimeMs}`; });
  const toCand = t => ({ title: t.title, game: t.game, data: Buffer.from(t.b64, "base64") });
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    if (cached.sig.length === sig.length && cached.sig.every((x, i) => x === sig[i])) return { cands: cached.cands.map(toCand), cached: true };
  } catch (e) {}
  const raw = [];
  for (const f of files) {
    const pack = c.parseJson5(fs.readFileSync(f, "utf8"));
    for (const g of pack.groups) for (const it of g.items) {
      if (typeof it.data !== "string" || !it.data) continue;
      raw.push({ title: it.title, game: g.title, b64: it.data.slice(0, PREFIX_CHARS) });
    }
  }
  try { fs.writeFileSync(CACHE, JSON.stringify({ sig, cands: raw })); } catch (e) {}
  return { cands: raw.map(toCand), cached: false };
}

const counts = new Uint16Array(65536), touched = [];
// the same track appearing in two packs (even under another name, or as a near-copy) is not a rival
const dup = (a, b) => { const n = Math.min(300, a.data.length, b.data.length); let k = 0; for (let i = 0; i < n; i++) if (a.data[i] === b.data[i]) k++; return n > 0 && k / n >= 0.8; };

function matchPack(cands) {
  const out = {}, dbg = []; let sure = 0;
  for (const [name, n] of Object.entries(SONGS)) {
    const off = slotOff(n, LAYOUT);
    let best = null, second = 0;
    for (const t of cands) {
      const len = Math.min(t.data.length, 1500); if (off < 0 || off + len > R.length) continue;
      // bytes that match outright, plus 16-bit words that moved by the same amount (relocated pointers)
      let same = 0;
      for (let i = 0; i < len; i++) {
        if (R[off + i] === t.data[i]) same++;
        if (i + 1 < len) { const d = ((R[off + i] | R[off + i + 1] << 8) - (t.data[i] | t.data[i + 1] << 8)) & 0xFFFF; if (d && counts[d]++ === 0) touched.push(d); }
      }
      let moved = 0; for (const d of touched) { if (counts[d] > moved) moved = counts[d]; counts[d] = 0; }
      touched.length = 0;
      const s = (same + 2 * moved) / len;
      if (!best || s > best.s) { if (best && !dup(best.t, t)) second = best.s; best = { s, t }; } else if (s > second && !dup(best.t, t)) second = s;
    }
    // an essentially exact copy (0.98+) wins over a lower-scoring near-copy of the same song
    const ok = best && best.s > 0.3 && (best.s > second + 0.10 || (best.s >= 0.98 && best.s > second + 0.01));
    if (ok) sure++;
    if (!ok) dbg.push(`${name}: best ${best ? best.s.toFixed(2) : "none"}, runner-up ${second.toFixed(2)}`);
    out[name] = ok ? `${best.t.title.replace(/^\s*\d+\s*[-.–]\s*/, "")} (${best.t.game})` : "unknown";
  }
  return { out, sure, dbg };
}

const { cands, cached } = loadCands(PACKS);
const best = matchPack(cands);
if (!best || best.sure === 0) { console.log("No pack matched this ROM (0 of 12). Not written."); process.exit(1); }
const clean = s => s.replace(/[\x00-\x1f\x7f]/g, " ");   // control characters would come out as text in Lua 5.1
const fold = s => foldName(clean(s));   // FCEUX font is ASCII only (see fold.js)
const names = Object.entries(best.out).map(([k, v]) => `  ${k} = ${JSON.stringify(clean(v))},`).join("\n");
const shown = Object.entries(best.out).map(([k, v]) => `  ${k} = ${JSON.stringify(fold(v))},`).join("\n");
const lua = fs.readFileSync(path.join(__dirname, "template.lua"), "utf8").replace("--NAMES--", () => names).replace("--SHOWN--", () => shown).replace(/seed \d+/, () => path.basename(rom)).replace("--DIR--", () => __dirname.replace(/\\/g, "/") + "/");
fs.writeFileSync(process.env.NOWPLAYING_OUT || path.join(__dirname, "music-now-zora.lua"), lua);
console.log(`Matched ${best.sure} of 12 slots across ${PACKS.length} packs (${cands.length} tracks, ${cached ? "from cache" : "parsed"}, layout ${LAYOUT.name}, ${((Date.now() - t0) / 1000).toFixed(1)}s). Unmatched: ${Object.entries(best.out).filter(([, v]) => v === "unknown").map(([k]) => k).join(", ") || "none"}.`);
if (best.dbg.length) console.log("Unsure slots:\n  " + best.dbg.join("\n  "));
