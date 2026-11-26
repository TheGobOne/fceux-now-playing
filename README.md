# FCEUX Now Playing

Shows the name of the custom music track playing in a **ZORA** (Zelda 1) or **Z2R** (Zelda 2) randomizer ROM, in FCEUX (top right by default), and writes it to `nowplaying.txt` for OBS.

Works with ROMs built with custom music packs (`.json5`, as made by the NES Custom Music Tool). The track list stays hidden until a song plays, so it won't spoil your seed.

## Setup

1. Install [Node.js](https://nodejs.org) and [FCEUX](https://fceux.com) (win64 2.7 tested).
2. Copy `fceux-path.example.txt` to `fceux-path.txt` and put the full path to `fceux64.exe` on its one line (or skip this if `fceux64.exe` is on your PATH).
3. Copy the example list for your game and put in the music packs you built your ROMs from, one path per line. This is where your music packs are, not your ROMs. A path can be a `.json5` file or a folder (searched for `.json5` files):
   - ZORA: copy `packs-zora.example.txt` to `packs-zora.txt`
   - Z2R: copy `packs-z2r.example.txt` to `packs-z2r.txt`
4. Optional: to move the name from the top right, copy `position.example.txt` to `position.txt`. See [Position](#position).

`nowplaying.txt` is created the first time FCEUX runs the script, so there is nothing to set up for it. Your own `fceux-path.txt` and `packs-*.txt` stay out of git.

## Use

Drag your ROM onto:

- `fceux-with-music.bat` for ZORA
- `fceux-with-music-z2.bat` for Z2R

It matches the ROM's songs against your packs, writes `music-now-zora.lua` or `music-now-z2.lua` (with the names for that seed), and opens FCEUX running it. A song missing from your packs shows as `unknown` (ZORA) or leaves the previous name on screen (Z2R): add its pack to the list.

Or run a generator yourself:

```
node make-music-lua.js <zora-rom.nes> [pack.json5 ...]
node make-z2-lua.js <z2r-rom.nes> [pack.json5 ...]
```

## Position

These options work for both games. Edit the one line in `position.txt`: `top`, `middle` or `bottom`, then `left`, `center` or `right` (for example `bottom left`). Add `speed 30` to set the scroll speed in pixels a second (1 to 120, default 15). Add the word `scroll` (for example `bottom left scroll`) to keep the name scrolling even when it fits. `bottom middle` works too: a lone `middle` fills whichever part you left out. Restart the script in FCEUX after changing it. A name too wide for the screen ignores the left, center or right setting: it starts at the left edge, waits about a second, then scrolls.

## OBS

`nowplaying.txt` is in this folder and is rewritten when the song changes.

1. In OBS, add a **Text (GDI+)** source.
2. In its properties, tick **Read from file**.
3. Choose `nowplaying.txt`.

## Troubleshooting

- **`Could not match this ROM to your packs`:** read the line above it. Check that Node.js is installed and that your `packs-zora.txt` or `packs-z2r.txt` lists the packs the ROM was built from.
- **FCEUX doesn't open:** put the full path to `fceux64.exe` in `fceux-path.txt`.
- **A song shows as `unknown` or the name doesn't change:** add the missing pack to your list and start the ROM again.
- **OBS doesn't update, or `position.txt` is ignored:** restart the script in FCEUX. The Lua file stores this folder's path, so if you moved the folder, run the generator again and point OBS at the new location.

## How it works

- **ZORA:** the ROM's song table gives each slot's address. Each slot is matched to a pack track by comparing bytes (allowing relocated pointers). In game, a one-frame pulse on RAM `$0600` is the song request (01 overworld, 80 title, 40 dungeon, level from `$0010`).
- **Z2R:** songs sit in 8 KB banks 16-27, found by chunk voting plus a pointer-tolerant check. In game, the bank mapped at `$A000` is the last value written to MMC5 `$5115`, and the music driver's reads in `$A000-$BFFF` identify the song.

Set `DEBUG` in `template-z2.lua` to log what the driver reads to `z2debug.txt`.

`core.js` is the pack-reading core from the NES Custom Music Tool.

If you have a `music-now.lua` file, it is Z2R output from an older version. The current scripts don't write it by default.
