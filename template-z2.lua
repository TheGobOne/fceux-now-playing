-- music-now.lua (Z2R): shows the name of the song playing in --ROM-- and writes it to nowplaying.txt for OBS.
-- Contains the track names for this seed: open it only if you don't mind spoilers.
-- Z2R maps the song's 8 KB bank in at $A000 through MMC5 register $5115 (bank = value - $80, banks 16-27).
-- The music driver reads the playing song's data from there every frame, so the addresses it reads in $A000-$BFFF say which song is playing.
local SONGS = {
--SONGS--
}
DEBUG = nil   -- set to io.open("z2debug.txt", "w") to log what the driver read at each check
local current = "-"
local TOP = 5           -- text row in pixels from the top, centered in the black band above the HUD (8 was too close to the HUD, 2 too high)
local a000 = 0         -- last value written to $5115: which bank is mapped at $A000 right now
local counts = {}       -- reads of each song's data since the last check
local unknown = {}      -- music-bank reads that fall in no known song, per bank (for the debug log)

local function publish()
  local f = io.open("nowplaying.txt", "w")
  if f then f:write(current); f:close() end
end
publish()

memory.registerwrite(0x5115, function(addr, size, val) a000 = val end)

memory.registerread(0xA000, 0x2000, function(addr)
  if a000 < 0x90 or a000 > 0x9B then return end   -- not a music bank: that read is game code
  local bank = a000 - 0x80
  for i, s in ipairs(SONGS) do
    if s.bank == bank and addr >= s.lo and addr <= s.hi then counts[i] = (counts[i] or 0) + 1; return end
  end
  local u = unknown[bank]
  if not u then unknown[bank] = { lo = addr, hi = addr, n = 1 }
  else u.n = u.n + 1; if addr < u.lo then u.lo = addr end; if addr > u.hi then u.hi = addr end end
end)

local function pick()
  local best, bestv = nil, 0
  for i, v in pairs(counts) do if v > bestv then best, bestv = i, v end end
  if DEBUG then
    local t = {}
    for i, v in pairs(counts) do t[#t + 1] = string.format("%d(bank %d, %s)=%d", i, SONGS[i].bank, SONGS[i].uses, v) end
    for b, u in pairs(unknown) do t[#t + 1] = string.format("UNKNOWN bank %d %04X-%04X=%d", b, u.lo, u.hi, u.n) end
    DEBUG:write(string.format("pick=%s reads: %s\n", tostring(best), table.concat(t, " "))); DEBUG:flush()
  end
  counts, unknown = {}, {}
  -- nothing read from a known song (a sound effect or a song change in progress): keep the last known name
  if best and SONGS[best].name ~= current then current = SONGS[best].name; publish() end
end

local frame = 0
while true do
  frame = frame + 1
  if frame % 20 == 0 then pick() end
  -- right-aligned; the emulator's font is proportional, so narrow characters count less (a slightly generous estimate keeps long names on screen)
  local w = 0
  for ch in current:gmatch(".") do w = w + (ch:find("[ ilI%.,:;!'()|]") and 4 or 5.5) end
  local x = math.max(2, math.floor(253 - w))
  for _, d in ipairs({ {-1, 0}, {1, 0}, {0, -1}, {0, 1}, {-1, -1}, {1, -1}, {-1, 1}, {1, 1} }) do
    gui.text(x + d[1], TOP + d[2], current, "black", "clear")   -- outline: black copies around the text
  end
  gui.text(x, TOP, current, "white", "clear")
  emu.frameadvance()
end
