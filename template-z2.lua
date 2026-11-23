-- music-now.lua (Z2R): shows the name of the song playing in --ROM-- and writes it to nowplaying.txt for OBS.
-- Contains the track names for this seed: open it only if you don't mind spoilers.
-- Z2R maps the song's 8 KB bank in at $A000 through MMC5 register $5115 (bank = value - $80, banks 16-27).
-- The music driver reads the playing song's data from there every frame, so the addresses it reads in $A000-$BFFF say which song is playing.
local SONGS = {
--SONGS--
}
DEBUG = nil   -- set to io.open("z2debug.txt", "w") to log what the driver read at each check
local current, currentShown = "-", "-"   -- currentShown is the name with non-ASCII characters folded, for drawing
local TOP = 5           -- text row in pixels from the top, centered in the black band above the HUD (8 was too close to the HUD, 2 too high)
-- Where the name is drawn: position.txt holds one line such as "top right" or "bottom left".
-- Vertical: top, middle or bottom. Horizontal: left, center or right. Missing or unreadable file means top right.
local VY = { top = TOP, middle = 116, bottom = 224 }
local posV, posH = "top", "right"
local SPEED = 15              -- scroll speed in pixels a second; "speed 30" in position.txt changes it (1 to 120)
local ALWAYS_SCROLL = false   -- the word "scroll" in position.txt keeps the name moving even when it fits
do
  local f = io.open("position.txt", "r")
  if f then
    local line = ""
    for l in f:lines() do if l:find("%S") then line = l:lower(); break end end   -- first non-empty line
    f:close()
    local n = tonumber(line:match("speed%s*[:=]?%s*(%d+)"))
    if n then SPEED = math.max(1, math.min(120, n)) end
    local v, h, middles = nil, nil, 0
    for word in line:gmatch("%a+") do
      if word == "top" or word == "bottom" then v = word
      elseif word == "left" or word == "right" then h = word
      elseif word == "center" or word == "centre" then h = "center"
      elseif word == "scroll" then ALWAYS_SCROLL = true
      elseif word == "middle" then middles = middles + 1 end
    end
    -- "middle" fills whichever of the two is still unset: "bottom middle" is bottom + centered, "middle left" is vertically centered
    if middles > 0 and not v then v = "middle"; middles = middles - 1 end
    if middles > 0 and not h then h = "center" end
    if v or h then posV, posH = v or "top", h or "right" end
  end
end
local function placeX(w, fits)
  if not fits or posH == "left" then return 6 end
  if posH == "right" then return 253 - w end
  return math.floor((256 - w) / 2)
end
local textY = VY[posV]
-- Scrolling for names too wide for the screen, or always with "scroll" in position.txt.
local MAXW, PAUSE = 244, 75   -- pixel budget, frames to hold at the start
-- the emulator font is proportional, so narrow characters count less (a slightly generous estimate keeps long names on screen)
local function cw(ch) return ch:find("[ ilI%.,:;!'()|]") and 4 or ch:find("[WMmw]") and 7 or 5.5 end
local function estw(s) local w = 0 for ch in s:gmatch(".") do w = w + cw(ch) end return w end
-- gui.text returns the x where the text ended on the FCEUX build tested (not in fceux.chm), so drawing far off screen measures the real width.
-- Checked for sense, and the estimate is used if the value looks wrong. Widths are cached per string.
local widths = {}
local function textw(s)
  local w = widths[s]
  if w then return w end
  w = estw(s)
  local ok, r = pcall(gui.text, -1000, 0, s)
  if ok and type(r) == "number" then
    local m = r + 1000
    if m > 0 and m <= 8 * #s then w = m end
  end
  widths[s] = w
  return w
end
local scroll = { text = nil, px = 0, tick = 0 }
-- draws the name with its black outline at (x, y)
local OFFSETS = { {-1, 0}, {1, 0}, {0, -1}, {0, 1}, {-1, -1}, {1, -1}, {-1, 1}, {1, 1} }
local function outlined(text, x, y)
  for _, d in ipairs(OFFSETS) do
    gui.text(x + d[1], y + d[2], text, "black", "clear")   -- outline: black copies around the text
  end
  gui.text(x, y, text, "white", "clear")
end
-- names that fit go where position.txt says; longer ones (or "scroll") move a pixel at a time from the left edge
local function drawName(text, y)
  if not ALWAYS_SCROLL and textw(text) <= MAXW then
    scroll.text = nil   -- a long name that comes back later starts its scroll over
    outlined(text, math.max(2, placeX(textw(text), true)), y)
    return
  end
  if scroll.text ~= text then
    scroll.text, scroll.px, scroll.tick = text, 0, 0
    local loop = text .. "      "                     -- gap between the end and the start
    scroll.loopW = math.max(1, math.floor(textw(loop)))
    scroll.strip = string.rep(loop, math.ceil(262 / scroll.loopW) + 1)   -- enough copies to fill the screen width, so short names wrap without a hole
  end
  scroll.tick = scroll.tick + 1
  if scroll.tick > PAUSE then scroll.px = scroll.px + SPEED / 60 end   -- the NES runs at 60 frames a second
  outlined(scroll.strip, 6 - math.floor(scroll.px % scroll.loopW), y)
end
local a000 = 0         -- last value written to $5115: which bank is mapped at $A000 right now
local counts = {}       -- reads of each song's data since the last check
local unknown = {}      -- music-bank reads that fall in no known song, per bank (for the debug log)

local function publish()
  local f = io.open("nowplaying.txt", "w")
  if f then f:write(current); f:close() end
end
publish()

local function onMusicRead(addr)
  if a000 < 0x90 or a000 > 0x9B then return end   -- not a music bank: that read is game code
  local bank = a000 - 0x80
  for i, s in ipairs(SONGS) do
    if s.bank == bank and addr >= s.lo and addr <= s.hi then counts[i] = (counts[i] or 0) + 1; return end
  end
  local u = unknown[bank]
  if not u then unknown[bank] = { lo = addr, hi = addr, n = 1 }
  else u.n = u.n + 1; if addr < u.lo then u.lo = addr end; if addr > u.hi then u.hi = addr end end
end

memory.registerwrite(0x5115, function(addr, size, val) a000 = val end)
-- Registered once for good: switching the hook on and off from the $5115 write callback measured about 3x slower, because $5115 is written about 12 times a frame.
memory.registerread(0xA000, 0x2000, onMusicRead)

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
  if best and SONGS[best].name ~= current then current = SONGS[best].name; currentShown = SONGS[best].shown or current; publish() end
end

local frame = 0
while true do
  frame = frame + 1
  if frame % 20 == 0 then pick() end
  drawName(currentShown, textY)
  emu.frameadvance()
end
