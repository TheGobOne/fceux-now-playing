-- music-now.lua: shows the name of the song playing in your ZORA ROM (seed 1758187119) and writes it to nowplaying.txt for OBS.
-- Contains the track names for this seed: open it only if you don't mind spoilers.
local NAMES = {
--NAMES--
}
-- A song request is a one-frame pulse on $0600: the bit number is the song number (01 overworld, 80 title).
local REQUEST = { [0x01] = "overworld", [0x10] = "ending", [0x20] = "level9", [0x80] = "title" }
local LEVEL_ADDR = 0x10   -- current level (1-9) while in a dungeon; shown on screen so a wrong guess is easy to spot

local current, shownKey = "-", ""
local prev = 0

local function publish()
  local f = io.open("nowplaying.txt", "w")
  if f then f:write(current); f:close() end
end
publish()

-- Where the name is drawn: position.txt holds one line such as "top right" or "bottom left".
-- Vertical: top, middle or bottom. Horizontal: left, center or right. Missing or unreadable file means top right.
local VY = { top = 8, middle = 116, bottom = 224 }
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
  if posH == "right" then return 252 - w end
  return math.floor((256 - w) / 2)
end
local textY = VY[posV]

-- Scrolling for names too wide for the screen (idea from nesrex).
local MAXW, SPEED, PAUSE = 244, 12, 75   -- pixel budget, frames per step, frames to hold at the start
-- the emulator's font is proportional, so narrow characters count less (a slightly generous estimate keeps long names on screen)
local function cw(ch) return ch:find("[ ilI%.,:;!'()|]") and 3.5 or 5.5 end
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

while true do
  local a = memory.readbyte(0x600)
  if a ~= 0 and a ~= prev then
    local key = REQUEST[a]
    if a == 0x40 then
      local lvl = memory.readbyte(LEVEL_ADDR)
      key = "level" .. lvl
      shownKey = string.format("$0600=40 level byte=%d", lvl)
    else
      shownKey = string.format("$0600=%02X", a)
    end
    -- any other request is a jingle (item fanfare etc.), not a song: keep showing the current song
    if key and NAMES[key] and NAMES[key] ~= current then
      current = NAMES[key]
      publish()
    end
  end
  prev = a
  -- names that fit go where position.txt says; longer ones scroll from the left edge
  local shown, fits = visible(current)
  local x = math.max(2, placeX(textw(shown), fits))
  for _, d in ipairs({ {-1, 0}, {1, 0}, {0, -1}, {0, 1}, {-1, -1}, {1, -1}, {-1, 1}, {1, 1} }) do
    gui.text(x + d[1], textY + d[2], shown, "black", "clear")   -- outline: black copies around the text
  end
  gui.text(x, textY, shown, "white", "clear")
  emu.frameadvance()
end
