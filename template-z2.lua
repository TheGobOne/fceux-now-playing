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
-- Where the name is drawn: position.txt holds one line such as "top right" or "bottom left".
-- Vertical: top, middle or bottom. Horizontal: left, center or right. Missing or unreadable file means top right.
local VY = { top = TOP, middle = 116, bottom = 224 }
local posV, posH = "top", "right"
local ALWAYS_SCROLL = false   -- the word "scroll" in position.txt keeps the name moving even when it fits
do
  local f = io.open("position.txt", "r")
  if f then
    local line = (f:read("*l") or ""):lower(); f:close()
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
local MAXW, SPEED, PAUSE = 244, 12, 75   -- pixel budget, frames per step, frames to hold at the start
-- the emulator's font is proportional, so narrow characters count less (a slightly generous estimate keeps long names on screen)
local function cw(ch) return ch:find("[ ilI%.,:;!'()|]") and 4 or ch:find("[WMmw]") and 7 or 5.5 end
local function textw(s) local w = 0 for ch in s:gmatch(".") do w = w + cw(ch) end return w end

local scroll = { text = nil, pos = 0, tick = 0 }
local function visible(text)
  if not ALWAYS_SCROLL and textw(text) <= MAXW then return text, true end
  if scroll.text ~= text then scroll.text, scroll.pos, scroll.tick = text, 0, 0 end
  scroll.tick = scroll.tick + 1
  local loop = text .. "    "
  if scroll.tick > PAUSE and scroll.tick % SPEED == 0 then
    scroll.pos = (scroll.pos + 1) % #loop
  end
  local s, w = "", 0
  for i = 0, 200 do   -- wraps around the loop, so a short name repeats to fill the width
    local k = (scroll.pos + i) % #loop + 1
    local ch = loop:sub(k, k)
    w = w + cw(ch)
    if w > MAXW then break end
    s = s .. ch
  end
  return s, false
end

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
  -- names that fit go where position.txt says; longer ones (or "scroll") scroll from the left edge
  local shown, fits = visible(current)
  local x = math.max(2, math.floor(placeX(textw(shown), fits)))
  for _, d in ipairs({ {-1, 0}, {1, 0}, {0, -1}, {0, 1}, {-1, -1}, {1, -1}, {-1, 1}, {1, 1} }) do
    gui.text(x + d[1], textY + d[2], shown, "black", "clear")   -- outline: black copies around the text
  end
  gui.text(x, textY, shown, "white", "clear")
  emu.frameadvance()
end
