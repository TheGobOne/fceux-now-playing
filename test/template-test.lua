-- Tests template.lua against a mock of FCEUX's Lua API. Run from the repo root: lua5.1 test/template-test.lua
-- No ROM, FCEUX or music packs needed. Uses real io for nowplaying.txt / position.txt inside test-tmp/.
local TEMPLATE = arg and arg[1] or "template.lua"
local TMP = "test-tmp/"
os.execute("mkdir -p " .. TMP)
local loadf = loadstring or load

local NAMES = '  overworld = "Overworld Th\\195\\169me (Game)",\n'
  .. '  level1 = "Level One (Game)",\n  level3 = "Level Three (Game)",\n'
  .. '  title = "A Very Long Title Screen Track Name That Cannot Possibly Fit On A 256 Pixel Wide NES Screen (Some Game)",\n'
local SHOWN = '  overworld = "Overworld Theme (Game)",\n'

local function readfile(p) local f = io.open(p, "r"); if not f then return nil end local s = f:read("*a"); f:close(); return s end
local function writefile(p, s) local f = assert(io.open(p, "w")); f:write(s); f:close() end

-- Loads a fresh copy of the script. opts.position = text for position.txt (nil = no file), opts.dir = NP_DIR override.
local function load_script(opts)
  opts = opts or {}
  os.remove(TMP .. "nowplaying.txt"); os.remove(TMP .. "position.txt")
  if opts.position then writefile(TMP .. "position.txt", opts.position .. "\n") end
  local env = { mem = {}, calls = {}, frame = 100 }
  memory = { readbyte = function(a) return env.mem[a] or 0 end }
  emu = { framecount = function() return env.frame end, frameadvance = function() end }
  gui = { text = function(x, y, s, fg, bg)
    env.calls[#env.calls + 1] = { x = x, y = y, s = s, fg = fg }
    return x + 6 * #s   -- the FCEUX build the script was written for returns the x where the text ended
  end }
  NOWPLAYING_EMBEDDED = true
  nowplaying_tick = nil
  local src = assert(readfile(TEMPLATE), "cannot read " .. TEMPLATE)
  src = src:gsub("%-%-NAMES%-%-", function() return NAMES end)
           :gsub("%-%-SHOWN%-%-", function() return SHOWN end)
           :gsub("%-%-DIR%-%-", function() return opts.dir or TMP end)
  local chunk, err = loadf(src, "template.lua")
  assert(chunk, err)
  chunk()
  assert(type(nowplaying_tick) == "function", "template did not define nowplaying_tick")
  function env.tick() env.frame = env.frame + 1; env.calls = {}; nowplaying_tick() end
  function env.request(v) env.mem[0x600] = v; env.tick(); env.mem[0x600] = 0; env.tick() end
  -- white text actually drawn on screen (the off-screen width probes at x=-1000 do not count)
  function env.visible()
    local out = {}
    for _, c in ipairs(env.calls) do if c.fg == "white" then out[#out + 1] = c end end
    return out
  end
  return env
end

local passed, failed = 0, 0
local function test(name, fn)
  local ok, err = pcall(fn)
  if ok then passed = passed + 1; print("ok    " .. name)
  else failed = failed + 1; print("FAIL  " .. name .. "\n      " .. tostring(err)) end
end
local function eq(a, b, msg) if a ~= b then error((msg or "values differ") .. ": expected " .. tostring(b) .. ", got " .. tostring(a), 2) end end

test("script loads and starts with '-' in nowplaying.txt", function()
  load_script()
  eq(readfile(TMP .. "nowplaying.txt"), "-")
end)

test("overworld request writes the full name to nowplaying.txt", function()
  local e = load_script()
  e.request(0x01)
  eq(readfile(TMP .. "nowplaying.txt"), "Overworld Th\195\169me (Game)")
end)

test("on-screen text uses the ASCII-folded name", function()
  local e = load_script()
  e.request(0x01); e.tick()
  local v = e.visible()
  assert(#v == 1, "expected one white text call, got " .. #v)
  eq(v[1].s, "Overworld Theme (Game)")
end)

test("dungeon request (0x40) picks the name from the level byte", function()
  local e = load_script()
  e.mem[0x10] = 3
  e.request(0x40)
  eq(readfile(TMP .. "nowplaying.txt"), "Level Three (Game)")
end)

test("unknown jingle requests keep the current song", function()
  local e = load_script()
  e.request(0x01)
  e.request(0x08)
  eq(readfile(TMP .. "nowplaying.txt"), "Overworld Th\195\169me (Game)")
end)

test("a loaded savestate (frame jump in play mode) is worked out from the level byte", function()
  local e = load_script()
  e.mem[0x12] = 5; e.mem[0x10] = 1
  e.frame = e.frame + 500   -- jump
  e.tick()
  eq(readfile(TMP .. "nowplaying.txt"), "Level One (Game)")
end)

test("a frame jump outside play mode leaves the name alone", function()
  local e = load_script()
  e.mem[0x12] = 2; e.mem[0x10] = 1
  e.frame = e.frame + 500
  e.tick()
  eq(readfile(TMP .. "nowplaying.txt"), "-")
end)

test("'hide' in position.txt draws nothing but still writes nowplaying.txt", function()
  local e = load_script({ position = "top right hide" })
  e.request(0x01); e.tick()
  eq(#e.calls, 0, "gui.text calls while hidden")
  eq(readfile(TMP .. "nowplaying.txt"), "Overworld Th\195\169me (Game)")
end)

test("'off' also hides", function()
  local e = load_script({ position = "off" })
  e.request(0x01); e.tick()
  eq(#e.calls, 0, "gui.text calls while hidden")
end)

test("default position is top right", function()
  local e = load_script()
  e.request(0x01); e.tick()
  local c = e.visible()[1]
  eq(c.y, 8, "y")
  eq(c.x + 6 * #c.s, 252, "right edge of the text")   -- the mock font is 6 px a character
end)

test("'bottom left' puts the name at the bottom left", function()
  local e = load_script({ position = "bottom left" })
  e.request(0x01); e.tick()
  local c = e.visible()[1]
  eq(c.y, 227, "y"); eq(c.x, 6, "x")
end)

test("'middle center' centres the name", function()
  local e = load_script({ position = "middle center" })
  e.request(0x01); e.tick()
  local c = e.visible()[1]
  eq(c.y, 116, "y")
  assert(c.x > 40 and c.x < 128, "expected centred, x=" .. c.x)
end)

test("a short name does not scroll", function()
  local e = load_script()
  e.request(0x01); e.tick()
  local x0 = e.visible()[1].x
  for _ = 1, 600 do e.tick() end
  eq(e.visible()[1].x, x0, "x after 600 frames")
end)

test("a long name holds, then scrolls left", function()
  local e = load_script()
  e.request(0x80); e.tick()                  -- title: the long name
  eq(e.visible()[1].x, 6, "start x")
  for _ = 1, 60 do e.tick() end              -- still inside the 75-frame pause
  eq(e.visible()[1].x, 6, "x during pause")
  for _ = 1, 400 do e.tick() end             -- well past the pause
  assert(e.visible()[1].x < 6, "expected scrolled left, x=" .. e.visible()[1].x)
end)

test("a long name wraps (the strip never leaves a hole)", function()
  local e = load_script({ position = "speed 120" })
  e.request(0x80)
  for _ = 1, 3000 do
    e.tick()
    local v = e.visible()[1]
    assert(v.x <= 6 and v.x > -2000, "x out of range: " .. v.x)
  end
end)

test("'scroll' makes a short name move", function()
  local e = load_script({ position = "scroll speed 60" })
  e.request(0x01); e.tick()
  local x0 = e.visible()[1].x
  for _ = 1, 400 do e.tick() end
  assert(e.visible()[1].x ~= x0, "x did not change")
end)

test("an unwritable folder does not crash the script", function()
  local e = load_script({ dir = "/nonexistent-folder-for-test/" })
  for _ = 1, 200 do e.tick() end
  e.request(0x01)
  for _ = 1, 200 do e.tick() end
end)

print(string.format("\n%d passed, %d failed", passed, failed))
os.remove(TMP .. "nowplaying.txt"); os.remove(TMP .. "position.txt")
if failed > 0 then os.exit(1) end
