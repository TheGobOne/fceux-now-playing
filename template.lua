-- music-now-zora.lua: shows the name of the song playing in your ZORA ROM (seed 1758187119) and writes it to nowplaying.txt for OBS.
-- Contains the track names for this seed: open it only if you don't mind spoilers.
local NAMES = {
--NAMES--
}
-- The same names with accents and other non-ASCII characters folded, for drawing (FCEUX's font only has ASCII).
local SHOWN = {
--SHOWN--
}
-- A song request is a one-frame pulse on $0600: the bit number is the song number (01 overworld, 80 title).
local REQUEST = { [0x01] = "overworld", [0x10] = "ending", [0x20] = "level9", [0x80] = "title" }
local LEVEL_ADDR = 0x10   -- current level (1-9) while in a dungeon

local current, currentShown = "-", "-"
local prev = 0

local dirty = false   -- true while the last write to nowplaying.txt failed (the file was locked); the main loop retries
local function publish()
  local f = io.open("nowplaying.txt", "w")
  if f then f:write(current); f:close(); dirty = false else dirty = true end
end
publish()

-- Where the name is drawn: position.txt holds one line such as "top right" or "bottom left".
-- Vertical: top, middle or bottom. Horizontal: left, center or right. Missing or unreadable file means top right.
local VY = { top = 8, middle = 116, bottom = 224 }
local posV, posH = "top", "right"
local SPEED = 15              -- scroll speed in pixels a second; "speed 30" in position.txt changes it (1 to 120)
local ALWAYS_SCROLL = false   -- the word "scroll" in position.txt keeps the name moving even when it fits
do
  local f = io.open("position.txt", "r")
  if f then
    local line = ""
    for l in f:lines() do
      l = (l:gsub("^\239\187\191", ""))   -- a byte order mark does not make a line non-empty
      if l:find("%S") then line = l:lower(); break end
    end   -- first non-empty line
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
  if posH == "right" then return 252 - w end
  return math.floor((256 - w) / 2)
end
local textY = VY[posV]

-- Scrolling for names too wide for the screen (idea from nesrex).
local MAXW, PAUSE = 244, 75   -- pixel budget, frames to hold at the start
-- the emulator font is proportional, so narrow characters count less (a slightly generous estimate keeps long names on screen)
local function cw(ch) return ch:find("[ ilI%.,:;!'()|]") and 3.5 or 5.5 end
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
local function setSong(key)
  if key and NAMES[key] and NAMES[key] ~= current then
    current = NAMES[key]
    currentShown = SHOWN[key] or current
    publish()
  end
end

local lastFrame = emu.framecount() - 1
local frames = 0
while true do
  frames = frames + 1
  -- A loaded savestate sends no song request, so the frame counter jumping is the cue to work the song out from the level byte.
  -- Only in play mode ($12 = 5): in caves, cellars and menus the song is not known from here, so the name stays.
  local fc = emu.framecount()
  if fc ~= lastFrame + 1 and memory.readbyte(0x12) == 5 then
    local lvl = memory.readbyte(LEVEL_ADDR)
    setSong(lvl == 0 and "overworld" or "level" .. lvl)
  end
  lastFrame = fc
  if dirty and frames % 45 == 0 then publish() end   -- retry a failed write about every 0.75 s
  local a = memory.readbyte(0x600)
  if a ~= 0 and a ~= prev then
    local key = REQUEST[a]
    if a == 0x40 then key = "level" .. memory.readbyte(LEVEL_ADDR) end
    -- any other request is a jingle (item fanfare etc.), not a song: keep showing the current song
    setSong(key)
  end
  prev = a
  drawName(currentShown, textY)
  emu.frameadvance()
end
