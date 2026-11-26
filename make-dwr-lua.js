// node make-dwr-lua.js <dwr-rom.nes>
// Reads the song list dwrandomizer writes beside a DWR ROM built with a music pack (<ROM name>.music.txt)
// and writes music-now-dwr.lua for it. Prints only counts; track names stay in the Lua file.
const fs = require("fs"), path = require("path");
const { foldName } = require("./fold.js");
const rom = process.argv[2];
if (!rom) { console.log("Usage: node make-dwr-lua.js <dwr-rom.nes>"); process.exit(1); }
const list = rom.replace(/\.nes$/i, "") + ".music.txt";
if (!fs.existsSync(list)) { console.log("No song list beside this ROM (" + path.basename(list) + "). Not written."); process.exit(1); }

// Game names from the packs in packs-dwr.txt (one path per line, optional): both game and song names can
// hold ": ", so the longest game name the line starts with marks the split. Without a pack, the last ": " does.
const games = [];
const packList = path.join(__dirname, "packs-dwr.txt");
if (fs.existsSync(packList)) {
  for (const p of fs.readFileSync(packList, "utf8").split("\n").map(l => l.trim()).filter(Boolean)) {
    let text = ""; try { text = fs.readFileSync(p, "utf8"); } catch (e) { continue; }
    for (const m of text.matchAll(/title:\s*"((?:[^"\\]|\\.)*)",\s*\r?\n\s*author:/g)) games.push(m[1]);
  }
  games.sort((a, b) => b.length - a.length);
}
const splitAt = full => {
  const g = games.find(g => full.startsWith(g + ": "));
  return g ? g.length : full.lastIndexOf(": ");
};

// Lines look like "  Overworld    Super Mario Bros. 2: Enjoying the Land (2757 bytes, bank 5)".
const names = {};
for (const line of fs.readFileSync(list, "utf8").split(/\r?\n/)) {
  const m = line.match(/^ {2}(\S.*?) {2,}(.+?) \(\d+ bytes, bank \d+\)\s*$/);
  if (!m) continue;
  const full = m[2], cut = splitAt(full);
  const song = (cut < 0 ? full : full.slice(cut + 2)).replace(/^\s*\d+\s*[-.–]\s*/, "");
  names[m[1].trim()] = cut < 0 ? song : `${song} (${full.slice(0, cut)})`;
}
if (!Object.keys(names).length) { console.log("The song list names no songs (the ROM kept the game's music). Not written."); process.exit(1); }

const clean = s => s.replace(/[\x00-\x1f\x7f]/g, " ");   // control characters would come out as text in Lua 5.1
const row = (k, v) => `  [${JSON.stringify(k)}] = ${JSON.stringify(v)},`;
const lua = fs.readFileSync(path.join(__dirname, "template-dwr.lua"), "utf8")
  .replace("--NAMES--", () => Object.entries(names).map(([k, v]) => row(k, clean(v))).join("\n"))
  .replace("--SHOWN--", () => Object.entries(names).map(([k, v]) => row(k, foldName(clean(v)))).join("\n"))
  .replace("--ROM--", () => path.basename(rom))
  .replace("--DIR--", () => __dirname.replace(/\\/g, "/") + "/");
fs.writeFileSync(process.env.NOWPLAYING_OUT || path.join(__dirname, "music-now-dwr.lua"), lua);
console.log(`Read ${Object.keys(names).length} songs from ${path.basename(list)}.`);
