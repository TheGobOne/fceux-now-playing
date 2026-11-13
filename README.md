# FCEUX Now Playing

Shows the name of the custom music track playing in a **ZORA** (Zelda 1) or **Z2R** (Zelda 2) randomizer ROM, in the top-right corner of FCEUX, and writes it to `nowplaying.txt` for OBS.

Works with ROMs built with custom music packs (`.json5`, as made by the NES Custom Music Tool). The track list stays hidden until a song plays, so it won't spoil your seed.

## Setup

1. Install [Node.js](https://nodejs.org) and [FCEUX](https://fceux.com) (win64 2.7 tested).
2. Put the full path to `fceux64.exe` in `fceux-path.txt` (or put it on your PATH).
3. List the folder your music packs you built your ROMs from, one path per line:
   - ZORA: `packs-zora.txt`
   - Z2R: `packs-z2r.txt`

## Use

Drag your ROM onto:

- `fceux-with-music.bat` for ZORA
- `fceux-with-music-z2.bat` for Z2R

It matches the ROM's songs against your packs, writes `music-now.lua` (with the names for that seed), and opens FCEUX running it. A song missing from your packs shows as `unknown` (ZORA) or leaves the previous name on screen (Z2R): add its pack to the list.

Or run a generator yourself:

```
node make-music-lua.js <zora-rom.nes> [pack.json5 ...]
node make-z2-lua.js <z2r-rom.nes> [pack.json5 ...]
```

`nowplaying.txt` is rewritten every time the song changes; point an OBS text source at it.

## How it works

- **ZORA:** the ROM's song table gives each slot's address. Each slot is matched to a pack track by comparing bytes (allowing relocated pointers). In game, a one-frame pulse on RAM `$0600` is the song request (01 overworld, 80 title, 40 dungeon, level from `$0010`).
- **Z2R:** songs sit in 8 KB banks 16-27, found by chunk voting plus a pointer-tolerant check. In game, the bank mapped at `$A000` is the last value written to MMC5 `$5115`, and the music driver's reads in `$A000-$BFFF` identify the song.

Set `DEBUG` in `template-z2.lua` to log what the driver reads to `z2debug.txt`.

`core.js` is the pack-reading core from the NES Custom Music Tool.
