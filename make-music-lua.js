// node make-music-lua.js <rom.nes> [pack.json5 ...]
// Matches each music slot of a ZORA ROM to the track in your pack and writes music-now.lua (names inside) next to the ROM's folder.
// Prints only how sure it is; track names stay in the Lua file.
const fs = require("fs"), path = require("path");
const c = require("./core.js");
const [rom, ...given] = process.argv.slice(2);
const PACKS = given.length ? given : (fs.existsSync(path.join(__dirname, "packs-zora.txt")) ? fs.readFileSync(path.join(__dirname, "packs-zora.txt"), "utf8").split("\n").map(l => l.trim()).filter(Boolean) : []);
if (!rom || !PACKS.length) { console.log("Usage: node make-music-lua.js <rom.nes> [pack.json5 ...]  (or list your packs in packs-zora.txt, one path per line)"); process.exit(1); }
const R = fs.readFileSync(rom), HEADER = 0x10, TABLE = 0x10, ADDR = 0x90, BANK = 0x4000, BASE = 0x8000;   // ZORA's lozft layout
const SONGS = { overworld: 0, ending: 4, level9: 5, title: 7, level1: 6, level2: 11, level3: 12, level4: 13, level5: 14, level6: 15, level7: 16, level8: 17 };

function matchPack(files) {
  const cands = [], file = files[0];
  for (const f of files) {
    const pack = c.parseJson5(fs.readFileSync(f, "utf8"));
    for (const g of pack.groups) for (const it of g.items) { if (!it.data) continue; try { cands.push({ title: it.title, game: g.title, data: Buffer.from(c.fromBase64(it.data)) }); } catch (e) {} }
  }
  const out = {}; let sure = 0;
  for (const [name, n] of Object.entries(SONGS)) {
    const bank = R[TABLE + 2 * n] ^ 0xFF, addr = R[ADDR + 2 * n] | (R[ADDR + 2 * n + 1] << 8), off = HEADER + bank * BANK + (addr - BASE);
    let best = null, second = 0;
    for (const t of cands) {
      const len = Math.min(t.data.length, 1500); if (off < 0 || off + len > R.length) continue;
      // bytes that match outright, plus 16-bit words that moved by the same amount (relocated pointers)
      let same = 0; const shifts = new Map();
      for (let i = 0; i < len; i++) {
        if (R[off + i] === t.data[i]) same++;
        if (i + 1 < len) { const d = ((R[off + i] | R[off + i + 1] << 8) - (t.data[i] | t.data[i + 1] << 8)) & 0xFFFF; if (d) shifts.set(d, (shifts.get(d) || 0) + 1); }
      }
      let moved = 0; for (const v of shifts.values()) if (v > moved) moved = v;
      const s = (same + 2 * moved) / len;
      // the same track appearing in two packs (even under another name) is not a rival
      const dup = (a, b) => a.data.subarray(0, 300).equals(b.data.subarray(0, 300));
      if (!best || s > best.s) { if (best && !dup(best.t, t)) second = best.s; best = { s, t }; } else if (s > second && !dup(best.t, t)) second = s;
    }
    const ok = best && best.s > 0.3 && best.s > second + 0.12;
    if (ok) sure++;
    out[name] = ok ? `${best.t.title.replace(/^\s*\d+\s*[-.–]\s*/, "")} (${best.t.game})` : "unknown";
  }
  return { file, out, sure };
}

const best = matchPack(PACKS.filter(p => fs.existsSync(p)));
if (!best || best.sure === 0) { console.log("No pack matched this ROM (0 of 12). Not written."); process.exit(1); }
const names = Object.entries(best.out).map(([k, v]) => `  ${k} = ${JSON.stringify(v)},`).join("\n");
const lua = fs.readFileSync(path.join(__dirname, "template.lua"), "utf8").replace("--NAMES--", names).replace(/seed \d+/, path.basename(rom));
fs.writeFileSync(path.join(__dirname, "music-now.lua"), lua);
console.log(`Matched ${best.sure} of 12 slots across ${PACKS.length} packs. Unmatched: ${Object.entries(best.out).filter(([, v]) => v === "unknown").map(([k]) => k).join(", ") || "none"}.`);
