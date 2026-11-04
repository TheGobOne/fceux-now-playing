
// NES music core: NSF/ROM loading, 6502 + APU emulation, note extraction,
// FamiTracker binary export and player JSON5 writing. Browser-side port of
// nsf2json5.py + export_ftbin.py (same output).
"use strict";

const CPU_HZ = 1789773;
const LENGTH_TABLE = [10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
  12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30];
const DMC_RATE = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];
const NOISE_PERIOD = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
const CHIPS = ["VRC6", "VRC7", "FDS", "MMC5", "Namco163", "Sunsoft5B", "VT02+"];
const SENTINEL = 0x5000;
const INIT_STEP_LIMIT = 5000000, PLAY_STEP_LIMIT = 300000;
const SILENCE_SECONDS = 2.0;

// ------------------------------------------------------------------ 6502

const OPS = (() => {
  const t = new Array(256).fill(null);
  const def = (op, list) => { for (const [code, mode] of list) t[code] = [op, mode]; };
  const std = (a, b) => [[a, "imm"], [a - 4, "zp"], [a + 12, "zpx"], [a + 4, "abs"], [a + 20, "absx"], [a + 16, "absy"], [a - 8, "indx"], [a + 8, "indy"]];
  def("ADC", std(0x69)); def("AND", std(0x29)); def("CMP", std(0xC9)); def("EOR", std(0x49));
  def("LDA", std(0xA9)); def("ORA", std(0x09)); def("SBC", std(0xE9));
  def("STA", [[0x85, "zp"], [0x95, "zpx"], [0x8D, "abs"], [0x9D, "absx"], [0x99, "absy"], [0x81, "indx"], [0x91, "indy"]]);
  for (const [op, b] of [["ASL", 0x0A], ["LSR", 0x4A], ["ROL", 0x2A], ["ROR", 0x6A]])
    def(op, [[b, "acc"], [b - 4, "zp"], [b + 12, "zpx"], [b + 4, "abs"], [b + 20, "absx"]]);
  def("INC", [[0xE6, "zp"], [0xF6, "zpx"], [0xEE, "abs"], [0xFE, "absx"]]);
  def("DEC", [[0xC6, "zp"], [0xD6, "zpx"], [0xCE, "abs"], [0xDE, "absx"]]);
  def("LDX", [[0xA2, "imm"], [0xA6, "zp"], [0xB6, "zpy"], [0xAE, "abs"], [0xBE, "absy"]]);
  def("LDY", [[0xA0, "imm"], [0xA4, "zp"], [0xB4, "zpx"], [0xAC, "abs"], [0xBC, "absx"]]);
  def("STX", [[0x86, "zp"], [0x96, "zpy"], [0x8E, "abs"]]);
  def("STY", [[0x84, "zp"], [0x94, "zpx"], [0x8C, "abs"]]);
  def("CPX", [[0xE0, "imm"], [0xE4, "zp"], [0xEC, "abs"]]);
  def("CPY", [[0xC0, "imm"], [0xC4, "zp"], [0xCC, "abs"]]);
  def("BIT", [[0x24, "zp"], [0x2C, "abs"]]);
  def("JMP", [[0x4C, "abs"], [0x6C, "ind"]]);
  def("JSR", [[0x20, "abs"]]);
  for (const [op, c] of [["BPL", 0x10], ["BMI", 0x30], ["BVC", 0x50], ["BVS", 0x70], ["BCC", 0x90], ["BCS", 0xB0], ["BNE", 0xD0], ["BEQ", 0xF0]]) def(op, [[c, "rel"]]);
  for (const [op, c] of [["BRK", 0x00], ["RTI", 0x40], ["RTS", 0x60], ["PHP", 0x08], ["PLP", 0x28], ["PHA", 0x48], ["PLA", 0x68],
    ["CLC", 0x18], ["SEC", 0x38], ["CLI", 0x58], ["SEI", 0x78], ["CLV", 0xB8], ["CLD", 0xD8], ["SED", 0xF8],
    ["TAX", 0xAA], ["TXA", 0x8A], ["TAY", 0xA8], ["TYA", 0x98], ["TSX", 0xBA], ["TXS", 0x9A],
    ["INX", 0xE8], ["INY", 0xC8], ["DEX", 0xCA], ["DEY", 0x88], ["NOP", 0xEA]]) def(op, [[c, "imp"]]);
  return t;
})();

class CPU {
  constructor(bus) { this.bus = bus; this.m = bus.mem; this.a = this.x = this.y = 0; this.sp = 0xFF; this.p = 0x24; this.pc = 0; }
  push(v) { this.bus.write(0x100 + this.sp, v); this.sp = (this.sp - 1) & 0xFF; }
  pop() { this.sp = (this.sp + 1) & 0xFF; return this.m[0x100 + this.sp]; }
  nz(v) { this.p = (this.p & 0x7D) | (v & 0x80) | (v ? 0 : 2); return v; }
  step() {
    const m = this.m, op = m[this.pc]; this.pc = (this.pc + 1) & 0xFFFF;
    const d = OPS[op];
    if (!d) { this.pc = (this.pc + 1) & 0xFFFF; return; }       // unknown opcode: 2-byte NOP (as py65)
    const [name, mode] = d;
    let addr = 0;
    switch (mode) {
      case "imm": addr = this.pc; this.pc = (this.pc + 1) & 0xFFFF; break;
      case "zp": addr = m[this.pc]; this.pc = (this.pc + 1) & 0xFFFF; break;
      case "zpx": addr = (m[this.pc] + this.x) & 0xFF; this.pc = (this.pc + 1) & 0xFFFF; break;
      case "zpy": addr = (m[this.pc] + this.y) & 0xFF; this.pc = (this.pc + 1) & 0xFFFF; break;
      case "abs": addr = m[this.pc] | m[(this.pc + 1) & 0xFFFF] << 8; this.pc = (this.pc + 2) & 0xFFFF; break;
      case "absx": addr = ((m[this.pc] | m[(this.pc + 1) & 0xFFFF] << 8) + this.x) & 0xFFFF; this.pc = (this.pc + 2) & 0xFFFF; break;
      case "absy": addr = ((m[this.pc] | m[(this.pc + 1) & 0xFFFF] << 8) + this.y) & 0xFFFF; this.pc = (this.pc + 2) & 0xFFFF; break;
      case "indx": { const z = (m[this.pc] + this.x) & 0xFF; addr = m[z] | m[(z + 1) & 0xFF] << 8; this.pc = (this.pc + 1) & 0xFFFF; break; }
      case "indy": { const z = m[this.pc]; addr = ((m[z] | m[(z + 1) & 0xFF] << 8) + this.y) & 0xFFFF; this.pc = (this.pc + 1) & 0xFFFF; break; }
      case "ind": { const t = m[this.pc] | m[(this.pc + 1) & 0xFFFF] << 8; addr = m[t] | m[(t & 0xFF00) | ((t + 1) & 0xFF)] << 8; break; }
      case "rel": { const o = m[this.pc]; this.pc = (this.pc + 1) & 0xFFFF; addr = (this.pc + (o < 0x80 ? o : o - 256)) & 0xFFFF; break; }
    }
    const rd = () => m[addr];
    const wr = v => this.bus.write(addr, v & 0xFF);
    const rmw = f => { if (mode === "acc") this.a = this.nz(f(this.a)); else wr(this.nz(f(rd()))); };
    const cmp = r => { const v = rd(), t = r - v; this.p = (this.p & 0x7C) | (r >= v ? 1 : 0) | (t & 0x80) | ((t & 0xFF) ? 0 : 2); };
    const branch = c => { if (c) this.pc = addr; };
    const adc = v => {
      const s = this.a + v + (this.p & 1);
      this.p = (this.p & 0x3C) | (s > 0xFF ? 1 : 0) | ((~(this.a ^ v) & (this.a ^ s) & 0x80) ? 0x40 : 0);
      this.a = this.nz(s & 0xFF);
    };
    switch (name) {
      case "LDA": this.a = this.nz(rd()); break;
      case "LDX": this.x = this.nz(rd()); break;
      case "LDY": this.y = this.nz(rd()); break;
      case "STA": wr(this.a); break;
      case "STX": wr(this.x); break;
      case "STY": wr(this.y); break;
      case "ADC": adc(rd()); break;
      case "SBC": adc(rd() ^ 0xFF); break;
      case "AND": this.a = this.nz(this.a & rd()); break;
      case "ORA": this.a = this.nz(this.a | rd()); break;
      case "EOR": this.a = this.nz(this.a ^ rd()); break;
      case "CMP": cmp(this.a); break;
      case "CPX": cmp(this.x); break;
      case "CPY": cmp(this.y); break;
      case "BIT": { const v = rd(); this.p = (this.p & 0x3D) | (v & 0xC0) | ((this.a & v) ? 0 : 2); break; }
      case "ASL": rmw(v => { this.p = (this.p & 0xFE) | (v >> 7); return (v << 1) & 0xFF; }); break;
      case "LSR": rmw(v => { this.p = (this.p & 0xFE) | (v & 1); return v >> 1; }); break;
      case "ROL": rmw(v => { const c = this.p & 1; this.p = (this.p & 0xFE) | (v >> 7); return ((v << 1) | c) & 0xFF; }); break;
      case "ROR": rmw(v => { const c = this.p & 1; this.p = (this.p & 0xFE) | (v & 1); return (v >> 1) | (c << 7); }); break;
      case "INC": wr(this.nz((rd() + 1) & 0xFF)); break;
      case "DEC": wr(this.nz((rd() - 1) & 0xFF)); break;
      case "INX": this.x = this.nz((this.x + 1) & 0xFF); break;
      case "INY": this.y = this.nz((this.y + 1) & 0xFF); break;
      case "DEX": this.x = this.nz((this.x - 1) & 0xFF); break;
      case "DEY": this.y = this.nz((this.y - 1) & 0xFF); break;
      case "TAX": this.x = this.nz(this.a); break;
      case "TXA": this.a = this.nz(this.x); break;
      case "TAY": this.y = this.nz(this.a); break;
      case "TYA": this.a = this.nz(this.y); break;
      case "TSX": this.x = this.nz(this.sp); break;
      case "TXS": this.sp = this.x; break;
      case "PHA": this.push(this.a); break;
      case "PLA": this.a = this.nz(this.pop()); break;
      case "PHP": this.push(this.p | 0x30); break;
      case "PLP": this.p = this.pop() | 0x30; break;
      case "CLC": this.p &= ~1; break;
      case "SEC": this.p |= 1; break;
      case "CLI": this.p &= ~4; break;
      case "SEI": this.p |= 4; break;
      case "CLV": this.p &= ~0x40; break;
      case "CLD": this.p &= ~8; break;
      case "SED": this.p |= 8; break;
      case "NOP": break;
      case "JMP": this.pc = addr; break;
      case "JSR": { const r = (this.pc - 1) & 0xFFFF; this.push(r >> 8); this.push(r & 0xFF); this.pc = addr; break; }
      case "RTS": { const lo = this.pop(), hi = this.pop(); this.pc = ((hi << 8 | lo) + 1) & 0xFFFF; break; }
      case "RTI": { this.p = this.pop() | 0x30; const lo = this.pop(), hi = this.pop(); this.pc = hi << 8 | lo; break; }
      case "BRK": { const r = (this.pc + 1) & 0xFFFF; this.push(r >> 8); this.push(r & 0xFF); this.p |= 0x10; this.push(this.p | 0x30); this.p |= 4; this.pc = m[0xFFFE] | m[0xFFFF] << 8; break; }
      case "BPL": branch(!(this.p & 0x80)); break;
      case "BMI": branch(this.p & 0x80); break;
      case "BVC": branch(!(this.p & 0x40)); break;
      case "BVS": branch(this.p & 0x40); break;
      case "BCC": branch(!(this.p & 1)); break;
      case "BCS": branch(this.p & 1); break;
      case "BNE": branch(!(this.p & 2)); break;
      case "BEQ": branch(this.p & 2); break;
    }
  }
}

// ------------------------------------------------------------------ NSF

function parseNsf(data) {
  const s = String.fromCharCode(...data.slice(0, 5));
  if (s !== "NESM\x1a") throw new Error("Not an NSF file.");
  const dv = new DataView(data.buffer, data.byteOffset);
  const text = o => { let r = ""; for (let i = o; i < o + 32 && data[i]; i++) r += String.fromCharCode(data[i]); return r.trim(); };
  const version = data[5];
  const pal = (data[0x7A] & 3) === 1;
  const speed = dv.getUint16(pal ? 0x78 : 0x6E, true);
  let rom = data.subarray(0x80);
  if (version >= 2) {
    const n = data[0x7D] | data[0x7E] << 8 | data[0x7F] << 16;
    if (n) rom = data.subarray(0x80, 0x80 + n);
  }
  return {
    version, songs: data[6], startSong: data[7],
    load: dv.getUint16(8, true), init: dv.getUint16(10, true), play: dv.getUint16(12, true),
    title: text(0x0E), artist: text(0x2E), copyright: text(0x4E),
    region: pal ? "PAL" : "NTSC",
    rate: speed ? 1e6 / speed : (pal ? 50.007 : 60.0988),
    banks: Array.from(data.subarray(0x70, 0x78)),
    chips: CHIPS.filter((_, i) => data[0x7B] >> i & 1),
    rom,
  };
}

// NSFe: chunks INFO, BANK, RATE, DATA, NEND plus optional tlbl (track names), plst
// (playlist order), auth (game, artist, copyright, ripper). Returns parseNsf's shape plus
// names (by track number, 1-based) and playlist (1-based track numbers).
function parseNsfe(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const strings = b => { const out = []; let cur = ""; for (const c of b) { if (c === 0) { out.push(cur); cur = ""; } else cur += String.fromCharCode(c); } if (cur) out.push(cur); return out; };
  let o = 4, info = null, banks = [0, 0, 0, 0, 0, 0, 0, 0], rate = null, rom = null, names = [], playlist = null, auth = [];
  while (o + 8 <= data.length) {
    const n = dv.getUint32(o, true), id = String.fromCharCode(...data.subarray(o + 4, o + 8)), body = data.subarray(o + 8, o + 8 + n);
    o += 8 + n;
    if (id === "INFO") info = body;
    else if (id === "BANK") { banks = Array.from(body.subarray(0, 8)); while (banks.length < 8) banks.push(0); }
    else if (id === "RATE") rate = body;
    else if (id === "DATA") rom = body;
    else if (id === "tlbl") names = strings(body);
    else if (id === "plst") playlist = Array.from(body, t => t + 1);
    else if (id === "auth") auth = strings(body);
    else if (id === "NEND") break;
    else if (id[0] >= "A" && id[0] <= "Z" && !["NSF2", "VRC7", "regn", "mixe"].includes(id)) throw new Error(`NSFe chunk ${id} isn't supported`);
  }
  if (!info || !rom) throw new Error("NSFe file is missing its INFO or DATA chunk");
  const w = i => info[i] | info[i + 1] << 8;
  const pal = (info[6] & 3) === 1;
  const speed = rate && rate.length >= (pal ? 4 : 2) ? (pal ? rate[2] | rate[3] << 8 : rate[0] | rate[1] << 8) : 0;
  return {
    version: 1, songs: info.length > 8 ? info[8] : 1, startSong: (info.length > 9 ? info[9] : 0) + 1,
    load: w(0), init: w(2), play: w(4), title: auth[0] || "", artist: auth[1] || "", copyright: auth[2] || "",
    region: pal ? "PAL" : "NTSC", rate: speed ? 1e6 / speed : (pal ? 50.007 : 60.0988),
    banks, chips: CHIPS.filter((_, i) => info[7] >> i & 1), rom,
    names, playlist,
  };
}

// GME-style .m3u lines:  file.nsf::NSF,track,title,length,loop,fade  (track is 1-based, "$" = hex).
// Returns [{file, track, title}] in file order.
function parseM3u(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(.*?)::(\w+),(.*)$/.exec(line);
    if (!m || m[2].toUpperCase() !== "NSF") continue;
    const fields = m[3].split(/(?<!\\),/).map(f => f.replace(/\\,/g, ","));
    const t = fields[0].trim();
    const track = t.startsWith("$") ? parseInt(t.slice(1), 16) : parseInt(t, 10);
    if (!Number.isFinite(track)) continue;
    out.push({ file: m[1].trim(), track, title: (fields[1] || "").trim() });
  }
  return out;
}

// ------------------------------------------------------------------ APU model

class Envelope {
  constructor() { this.reg = 0; this.start = false; this.decay = 0; this.div = 0; }
  clock() {
    if (this.start) { this.start = false; this.decay = 15; this.div = this.reg & 15; }
    else if (this.div === 0) { this.div = this.reg & 15; if (this.decay) this.decay--; else if (this.reg & 0x20) this.decay = 15; }
    else this.div--;
  }
  volume() { return this.reg & 0x10 ? this.reg & 15 : this.decay; }
}

class Pulse {
  constructor(isOne) { this.isOne = isOne ? 1 : 0; this.env = new Envelope(); this.timer = this.length = this.sweep = this.sweepDiv = 0; this.sweepReload = this.enabled = this.retrig = false; }
  write(r, v) {
    if (r === 0) this.env.reg = v;
    else if (r === 1) { this.sweep = v; this.sweepReload = true; }
    else if (r === 2) this.timer = (this.timer & 0x700) | v;
    else { this.timer = (this.timer & 0xFF) | (v & 7) << 8; if (this.enabled) this.length = LENGTH_TABLE[v >> 3]; this.env.start = this.retrig = true; }
  }
  target() { const c = this.timer >> (this.sweep & 7); return this.sweep & 8 ? this.timer - c - this.isOne : this.timer + c; }
  muted() { return this.timer < 8 || this.target() > 0x7FF; }
  quarter() { this.env.clock(); }
  half() {
    if (this.length && !(this.env.reg & 0x20)) this.length--;
    if (this.sweepDiv === 0 && this.sweep & 0x80 && this.sweep & 7 && !this.muted()) this.timer = Math.max(0, this.target());
    if (this.sweepDiv === 0 || this.sweepReload) { this.sweepDiv = (this.sweep >> 4) & 7; this.sweepReload = false; } else this.sweepDiv--;
  }
  sample() { const vol = this.env.volume(); if (!this.length || !vol || this.muted()) return null; return { timer: this.timer, vol, duty: this.env.reg >> 6 }; }
}

class Triangle {
  constructor() { this.ctrl = this.timer = this.length = this.linear = 0; this.linReload = this.enabled = this.retrig = false; }
  write(r, v) {
    if (r === 0) this.ctrl = v;
    else if (r === 2) this.timer = (this.timer & 0x700) | v;
    else if (r === 3) { this.timer = (this.timer & 0xFF) | (v & 7) << 8; if (this.enabled) this.length = LENGTH_TABLE[v >> 3]; this.linReload = true; }
  }
  quarter() { if (this.linReload) this.linear = this.ctrl & 0x7F; else if (this.linear) this.linear--; if (!(this.ctrl & 0x80)) this.linReload = false; }
  half() { if (this.length && !(this.ctrl & 0x80)) this.length--; }
  sample() { if (!this.length || !this.linear || this.timer < 2) return null; return { timer: this.timer }; }
}

class Noise {
  constructor() { this.env = new Envelope(); this.rate = this.mode = this.length = 0; this.enabled = this.retrig = false; }
  write(r, v) {
    if (r === 0) this.env.reg = v;
    else if (r === 2) { this.mode = v >> 7; this.rate = v & 15; }
    else if (r === 3) { if (this.enabled) this.length = LENGTH_TABLE[v >> 3]; this.env.start = this.retrig = true; }
  }
  quarter() { this.env.clock(); }
  half() { if (this.length && !(this.env.reg & 0x20)) this.length--; }
  sample() { const vol = this.env.volume(); if (!this.length || !vol) return null; return { rate: this.rate, mode: this.mode, vol }; }
}

class DMC {
  constructor() { this.rate = this.loop = 0; this.addr = 0xC000; this.length = 1; this.remaining = 0; this.triggers = []; }
  write(r, v) {
    if (r === 0) { this.loop = v >> 6 & 1; this.rate = v & 15; }
    else if (r === 2) this.addr = 0xC000 + v * 64;
    else if (r === 3) this.length = v * 16 + 1;
  }
  enable(on) {
    if (!on) this.remaining = 0;
    else if (!this.remaining) { this.remaining = this.length * 8 * DMC_RATE[this.rate]; this.triggers.push(1); }
  }
  advance(c) { if (!this.loop) this.remaining = Math.max(0, this.remaining - c); }
}

const CH_NAMES = ["pulse1", "pulse2", "triangle", "noise"];

class APU {
  constructor(rate) {
    this.ch = [new Pulse(true), new Pulse(false), new Triangle(), new Noise()];
    this.dmc = new DMC();
    this.qpf = 240.0 / rate; this.cpf = CPU_HZ / rate; this.qacc = 0; this.qcount = 0;
  }
  write(a, v) {
    if (a < 0x4010) this.ch[(a - 0x4000) >> 2].write(a & 3, v);
    else if (a < 0x4014) this.dmc.write(a & 3, v);
    else if (a === 0x4015) {
      this.ch.forEach((c, i) => { c.enabled = !!(v >> i & 1); if (!c.enabled) c.length = 0; });
      this.dmc.enable(v & 0x10);
    }
  }
  status() { let b = 0; this.ch.forEach((c, i) => { if (c.length) b |= 1 << i; }); return b | (this.dmc.remaining ? 0x10 : 0); }
  runFrame() {
    this.qacc += this.qpf; const n = Math.floor(this.qacc); this.qacc -= n;
    let snap = null;
    for (let i = 0; i < n; i++) {
      for (const c of this.ch) c.quarter();
      this.qcount++;
      if (this.qcount % 2 === 0) for (const c of this.ch) c.half();
      if (!snap) snap = this.sample();
    }
    if (!snap) snap = this.sample();
    this.dmc.advance(this.cpf);
    return snap;
  }
  sample() {
    const states = this.ch.map(c => c.sample());
    const retrig = this.ch.map(c => c.retrig);
    for (const c of this.ch) c.retrig = false;
    return [states, retrig];
  }
}

// ------------------------------------------------------------------ memory bus

class Bus {
  constructor(nsf, apu) {
    this.mem = new Uint8Array(0x10000);
    this.apu = apu;
    const rom = nsf.rom, load = nsf.load;
    this.bankswitched = nsf.banks.some(b => b);
    this.bank = nsf.banks.slice();
    if (this.bankswitched) {
      const pad = load & 0x0FFF;
      const size = Math.ceil((pad + rom.length) / 0x1000) * 0x1000;
      this.rom = new Uint8Array(size); this.rom.set(rom, pad);
      this.bank.forEach((b, i) => this.switchBank(i, b));
    } else {
      const end = Math.min(0x10000, load + rom.length);
      this.mem.set(rom.subarray(0, end - load), load);
    }
  }
  switchBank(slot, bank) {
    this.bank[slot] = bank;
    bank %= this.rom.length / 0x1000;
    this.mem.set(this.rom.subarray(bank * 0x1000, (bank + 1) * 0x1000), 0x8000 + slot * 0x1000);
  }
  write(a, v) {
    if (a < 0x2000) { a &= 0x7FF; this.mem[a] = this.mem[a | 0x800] = this.mem[a | 0x1000] = this.mem[a | 0x1800] = v; }
    else if (a >= 0x4000 && a <= 0x4017) { this.apu.write(a, v); this.mem[0x4015] = this.apu.status(); }
    else if (a >= 0x5FF8 && a <= 0x5FFF) { if (this.bankswitched) this.switchBank(a - 0x5FF8, v); }
    else if (a >= 0x6000 && a < 0x8000) this.mem[a] = v;
  }
  digest() {
    // two independent 32-bit hashes of RAM, cartridge RAM and bank registers
    let h1 = 0x811C9DC5, h2 = 0x12345678;
    const mix = v => { h1 = Math.imul(h1 ^ v, 0x01000193); h2 = Math.imul(h2 + v, 0x5BD1E995) ^ (h2 >>> 15); };
    const m = this.mem;
    for (let i = 0; i < 0x800; i++) mix(m[i]);
    for (let i = 0x6000; i < 0x8000; i++) mix(m[i]);
    for (const b of this.bank) mix(b);
    return (h1 >>> 0).toString(36) + ":" + (h2 >>> 0).toString(36);
  }
}

function call(cpu, bus, addr, a = 0, x = 0, limit = PLAY_STEP_LIMIT) {
  cpu.sp = 0xFD;
  const ret = SENTINEL - 1;
  bus.write(0x100 + cpu.sp, ret >> 8); bus.write(0x100 + cpu.sp - 1, ret & 0xFF);
  cpu.sp -= 2;
  cpu.pc = addr; cpu.a = a; cpu.x = x; cpu.y = 0;
  for (let i = 0; i < limit; i++) { if (cpu.pc === SENTINEL) return; cpu.step(); }
  throw new Error(`routine at $${addr.toString(16).toUpperCase()} did not return`);
}

// ------------------------------------------------------------------ notes

const midiOf = (timer, div) => Math.round(69 + 12 * Math.log2(CPU_HZ / (div * (timer + 1)) / 440));

class Track {
  constructor(kind) { this.kind = kind; this.div = kind === "triangle" ? 32 : 16; this.notes = []; this.cur = null; this.prevRetrig = false; }
  semitone(s) { return "timer" in s ? midiOf(s.timer, this.div) : null; }
  feed(frame, s, retrig) {
    const isolated = retrig && !this.prevRetrig && this.kind !== "triangle";
    this.prevRetrig = retrig;
    if (!s) { this.close(); return; }
    let cur = this.cur;
    let fresh = !cur || this.semitone(s) !== cur.semitone || isolated;
    if (!fresh && "vol" in s && cur.vol.length >= 2) {
      const v1 = cur.vol[cur.vol.length - 1], v2 = cur.vol[cur.vol.length - 2];
      fresh = s.vol > v1 && v1 < v2;
    }
    if (fresh) {
      this.close();
      cur = this.cur = { start: frame, semitone: this.semitone(s) };
      for (const k in s) cur[k] = [];
    }
    for (const k in s) cur[k].push(s[k]);
  }
  close() {
    const cur = this.cur; this.cur = null;
    if (!cur) return;
    const { start, semitone, ...fields } = cur;
    const keys = Object.keys(fields);
    const note = { start, frames: fields[keys[0]].length };
    for (const k of keys) { const v = fields[k]; note[k] = v.every(x => x === v[0]) ? v[0] : v; }
    this.notes.push(note);
  }
  finish(end) {
    this.close();
    const kept = [];
    for (const n of this.notes) {
      if (n.start >= end) continue;
      const over = n.start + n.frames - end;
      if (over > 0) { n.frames -= over; for (const k of ["timer", "vol", "duty", "rate"]) if (Array.isArray(n[k])) n[k] = n[k].slice(0, n.frames); }
      kept.push(n);
    }
    return kept;
  }
}

// Drivers with a fractional tempo repeat a bar a frame early or late, so the sound never matches
// exactly. This finds the period at which it matches within one frame (almost every frame).
function fuzzyLoop(sig, n) {
  const nearEq = (x, p) => { const y = x - p; return sig[x] === sig[y] || sig[x] === sig[y - 1] || sig[x] === sig[y + 1]; };
  const win = p => Math.min(n - p, Math.max(p, 1200));
  let best = null, top = 0;
  const scores = [];
  for (let p = 600; 2 * p <= n; p++) {
    const w = win(p);
    let ok = 0, audible = false;
    for (let x = n - w; x < n; x++) { if (nearEq(x, p)) ok++; if (sig[x]) audible = true; }
    if (!audible) continue;
    scores.push({ p, score: ok / w, w });
    top = Math.max(top, ok / w);
  }
  best = scores.find(c => c.score >= Math.max(0.85, top - 0.05)) || null;
  if (!best || best.score < 0.8) return null;
  let q = best.p;
  for (let d = -2; d <= 2; d++) {                         // settle on the nearest exact-ish period
    let k = 0; for (let x = n - best.w; x < n; x++) if (sig[x] === sig[x - best.p - d]) k++;
    if (k > best.score * best.w * 0.999 && d) q = best.p + d;
  }
  let s = n - q - best.w, miss = 0;                       // earliest frame the repetition holds
  while (s > 0 && miss < 60) { if (nearEq(s - 1 + q, q)) miss = Math.max(0, miss - 1); else miss += 3; s--; }
  return { start: Math.max(0, s), period: q };
}

// Run one song. Returns {number, frames, end, loopStart?, channels:{pulse1..noise: notes}, dpcmUsed}
// Find where the sound starts repeating. sig[f] identifies frame f's channel output.
// With a known loop (start, period) from the driver's memory, shorten it to the earliest start
// and smallest period the sound itself allows. Without one, look for a suffix of the recording
// that repeats at least twice. Returns {start, period} or null.
const MIN_LOOP_FRAMES = 30;
function soundLoop(sig, n, known, noteSig, toneSig) {
  if (known) {
    const { start, period } = known;
    const at = f => f < n ? sig[f] : sig[start + (f - n) % period];     // the recording, looped once more
    let best = period;
    for (let d = 1; d < period; d++) {
      if (period % d) continue;
      let ok = true;
      for (let f = start; f < start + period && ok; f++) ok = at(f) === at(f + d);
      if (ok) { best = d; break; }
    }
    let s = start;
    if (best === period) {
      // The sound repeats within the driver's period, but not to the frame: a tempo that doesn't divide
      // evenly makes each pass 1212 or 1213 frames long, and the driver's own state only comes round after
      // a dozen passes. Take the shortest repeat that holds to within a frame; the end is a hair off the beat.
      // The shortest repeat that holds to 95%, by the notes alone (not volumes). The second try ignores
      // the noise channel: a sound effect's rumble can run at its own rate and only line up with the tune
      // every half minute, though the tune itself repeats every two seconds.
      const attempt = (ns, minD) => {
        const pe = (x, y) => ns[x] === ns[y] || ns[x] === ns[y - 1] || ns[x] === ns[y + 1];
        const test = d => {
          const k = Math.round(period / d);
          if (k < 2 || Math.abs(period - k * d) > 1.5 * k + 2) return false;   // the loop must be a whole number of these passes
          let ok = 0, tot = 0, bad = 0, audible = false;
          const lim = Math.floor((period - d) / 2 * 0.05);
          for (let f = start; f + d < start + period && f + d < n; f += 2) { tot++; if (pe(f, f + d)) ok++; else if (++bad > lim) return false; if (ns[f]) audible = true; }
          return audible && tot > 0 && ok / tot >= 0.95;
        };
        for (let k = Math.floor(period / minD); k >= 2; k--) { const d = Math.round(period / k); if (d >= minD && test(d)) return d; }   // a fraction of the driver's period
        if (period <= 40000) for (let d = minD; 2 * d <= period; d++) if (test(d)) return d;   // or any repeat that holds
        return period;
      };
      best = attempt(noteSig || sig, 300);
      if (toneSig) best = Math.min(best, attempt(toneSig, 90));
      // The same tempo wobble that made the repeat inexact also stops the exact walk back below from finding where it
      // began: one frame out of step and it gives up, leaving minutes of the same music before the loop. Walk back
      // again by 5-second windows, as long as 85% of each one repeats (stray bursts of mismatches are forgiven).
      const ns = noteSig || sig, pe = (x, y) => ns[x] === ns[y] || ns[x] === ns[y - 1] || ns[x] === ns[y + 1];
      const W = 300, good = new Uint8Array(s + 1);
      for (let x = 0; x < s; x++) good[x] = pe(x, x + best) ? 1 : 0;
      let ok = 0; for (let x = Math.max(0, s - W); x < s; x++) ok += good[x];
      let w = s - W;                                   // the window [w, w + W)
      while (w > 0 && ok >= 0.85 * W) { w--; ok += good[w] - good[w + W]; }
      if (ok >= 0.85 * W) w = 0;
      if (w < s - W) s = Math.max(0, w + W);
    }
    while (s > 0 && at(s - 1) === at(s - 1 + best)) s--;
    return { start: s, period: best };
  }
  for (let p = MIN_LOOP_FRAMES; 2 * p <= n; p++) {
    let k = 0;                                   // how many frames at the end repeat with period p
    while (k < n - p && sig[n - 1 - k] === sig[n - 1 - k - p]) k++;
    if (k >= p) {
      let s = n - p - k;                         // earliest frame where the repetition holds
      let audible = false;
      for (let f = s; f < s + p && !audible; f++) audible = sig[f] !== 0;
      if (audible) return { start: s, period: p };
    }
  }
  return null;
}

// Run one song. Returns {number, frames, end, loopStart?, channels:{pulse1..noise: notes}, dpcmUsed}.
// end: "loop" (loops back to loopStart), "silence" (plays once), or "maxDuration" (no loop found
// within twice the max length: cut at the max length and restarted from the beginning).
function runSong(nsf, song, maxSeconds) {
  const apu = new APU(nsf.rate), bus = new Bus(nsf, apu), cpu = new CPU(bus);
  for (let a = 0x4000; a < 0x4014; a++) bus.write(a, 0);
  bus.write(0x4015, 0x0F); bus.write(0x4017, 0x40);
  call(cpu, bus, nsf.init, song - 1, nsf.region === "PAL" ? 1 : 0, INIT_STEP_LIMIT);
  const tracks = CH_NAMES.map(k => new Track(k));
  const seen = new Map(), sigIds = new Map([["[[null,null,null,null],[false,false,false,false]]", 0]]), sig = [], pitchSig = [], pIds = new Map(), noteSig = [], nIds = new Map([["-|-|-|-", 0]]), toneSig = [], tIds = new Map([["-|-|-", 0]]);
  const maxFrames = Math.floor(maxSeconds * nsf.rate), silenceLimit = Math.floor(SILENCE_SECONDS * nsf.rate);
  let lastSound = -1, end = "maxDuration", known = null, frames = 2 * maxFrames, dpcmUsed = false;
  for (let frame = 0; frame < 2 * maxFrames; frame++) {
    const d = bus.digest();
    if (seen.has(d)) {
      known = { start: seen.get(d), period: frame - seen.get(d) }; frames = frame; end = "loop";
      if (lastSound < known.start) { end = "silence"; known = null; frames = lastSound + 1; }
      break;
    }
    seen.set(d, frame);
    call(cpu, bus, nsf.play);
    if (apu.dmc.triggers.length) { dpcmUsed = true; lastSound = frame; }
    apu.dmc.triggers.length = 0;
    const [states, retrig] = apu.runFrame();
    bus.mem[0x4015] = apu.status();
    tracks.forEach((t, i) => t.feed(frame, states[i], retrig[i]));
    const key = JSON.stringify([states, retrig]);
    if (!sigIds.has(key)) sigIds.set(key, sigIds.size);
    sig.push(sigIds.get(key));
    const pkey = JSON.stringify(states.map(s => s ? (s.timer ?? s.rate ?? 0) : null));
    if (!pIds.has(pkey)) pIds.set(pkey, pkey === "[null,null,null,null]" ? 0 : pIds.size + 1);
    pitchSig.push(pIds.get(pkey));
    const nkey = states.map((s, i) => s ? (s.timer ? Math.round(12 * Math.log2(1 / (s.timer + 1))) + (i === 2 ? 5 : 0) : s.rate !== undefined ? "n" + s.rate : 1) : "-").join("|");
    if (!nIds.has(nkey)) nIds.set(nkey, nIds.size);
    noteSig.push(nIds.get(nkey));
    const tkey = nkey.split("|").slice(0, 3).join("|");
    if (!tIds.has(tkey)) tIds.set(tkey, tIds.size);
    toneSig.push(tIds.get(tkey));
    if (states.some(s => s)) lastSound = frame;
    if (lastSound >= 0 && frame - lastSound > silenceLimit) { end = "silence"; frames = lastSound + 1; break; }
  }
  let loopStart = null;
  if (end !== "silence") {
    const found = soundLoop(sig, frames, known, noteSig, toneSig) || (known ? null : fuzzyLoop(pitchSig, frames));
    if (found) { end = "loop"; loopStart = found.start; frames = found.start + found.period; }
    else { frames = maxFrames; loopStart = 0; }          // no loop: cut, then start over
  }
  const channels = {};
  tracks.forEach((t, i) => channels[CH_NAMES[i]] = t.finish(frames));
  const r = { number: song, frames, end, channels, dpcmUsed };
  if (loopStart !== null) r.loopStart = loopStart;
  return r;
}


function loadFile(data) {
  const head = String.fromCharCode(...data.slice(0, 4));
  if (head === "NESM") return { nsf: parseNsf(data), names: [] };
  if (head === "NSFE") {
    const nsf = parseNsfe(data);
    return { nsf, names: nsf.names, playlist: nsf.playlist, title: nsf.title, author: nsf.artist };
  }
  if (head === "NES\x1a") throw new Error("game ROMs (.nes) can't be read; use the game's NSF or NSFe music file");
  throw new Error("not an NSF or NSFe music file");
}

// ------------------------------------------------------------------ zip files

// The files inside a .zip as [{name, data}] (stored or deflated entries; needs DecompressionStream).
async function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xFFFF); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a readable zip file");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("damaged zip file");
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;                                   // a folder entry
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    else throw new Error(`${name}: compression method ${method} isn't supported`);
    out.push({ name: name.split("/").pop(), path: name, data });
  }
  return out;
}

// ------------------------------------------------------------------ FamiTracker binary export

const PERIODS = [
  0x0D5B, 0x0C9C, 0x0BE6, 0x0B3B, 0x0A9A, 0x0A01, 0x0972, 0x08EA, 0x086A, 0x07F1, 0x077F, 0x0713,
  0x06AD, 0x064D, 0x05F3, 0x059D, 0x054C, 0x0500, 0x04B8, 0x0474, 0x0434, 0x03F8, 0x03BF, 0x0389,
  0x0356, 0x0326, 0x02F9, 0x02CE, 0x02A6, 0x0280, 0x025C, 0x023A, 0x021A, 0x01FB, 0x01DF, 0x01C4,
  0x01AB, 0x0193, 0x017C, 0x0167, 0x0152, 0x013F, 0x012D, 0x011C, 0x010C, 0x00FD, 0x00EF, 0x00E1,
  0x00D5, 0x00C9, 0x00BD, 0x00B3, 0x00A9, 0x009F, 0x0096, 0x008E, 0x0086, 0x007E, 0x0077, 0x0070,
  0x006A, 0x0064, 0x005E, 0x0059, 0x0054, 0x004F, 0x004B, 0x0046, 0x0042, 0x003F, 0x003B, 0x0038,
  0x0034, 0x0031, 0x002F, 0x002C, 0x0029, 0x0027, 0x0025, 0x0023, 0x0021, 0x001F, 0x001D, 0x001B,
  0x001A, 0x0018, 0x0017, 0x0015, 0x0014, 0x0013, 0x0012, 0x0011, 0x0010, 0x000F, 0x000E, 0x000D,
];
const CMD_JUMP = 0x86, CMD_SKIP = 0x87, CMD_HALT = 0x88, CMD_PITCH = 0x91, CMD_RESET_PITCH = 0x92, CMD_DUTY = 0x93;
const NOTE_HALT = 0x7F;
const MAX_INSTRUMENTS = 128;        // 0-15 use the one-byte E0-EF code, 16-127 the 0x80 command (bhop/FT both read it)
const ENV_CHUNK = 240;              // a volume sequence holds at most 255 steps: longer notes restart every 240 frames

// notes -> per frame [state|null, starts, [vols, index, end, timers]|null]. Notes longer than ENV_CHUNK
// frames are restarted every ENV_CHUNK frames so each volume sequence fits in 255 steps.
function expand(notes, frames) {
  const out = new Array(frames).fill(null).map(() => [null, false, null]);
  for (const n of notes) {
    const fields = ["timer", "vol", "duty", "rate", "mode"].filter(k => k in n);
    const vols = "vol" in n ? (Array.isArray(n.vol) ? n.vol : new Array(n.frames).fill(n.vol)) : null;
    const timers = Array.isArray(n.timer) ? n.timer : null;
    for (let i = 0; i < n.frames; i++) {
      const f = n.start + i;
      if (f >= frames) break;
      const s = {};
      for (const k of fields) s[k] = Array.isArray(n[k]) ? n[k][i] : n[k];
      const end = Math.min(n.frames, (Math.floor(i / ENV_CHUNK) + 1) * ENV_CHUNK);
      out[f] = [s, i % ENV_CHUNK === 0, vols || timers ? [vols, i, end, timers] : null];
    }
  }
  return out;
}

function nearestNote(timer) {
  let best = 0;
  for (let i = 1; i < PERIODS.length; i++) if (Math.abs(PERIODS[i] - timer) < Math.abs(PERIODS[best] - timer)) best = i;
  return best + 1;
}
function trim(v) { v = v.slice(); while (v.length > 1 && v[v.length - 1] === v[v.length - 2]) v.pop(); return v; }
const envKey = e => e.join(",");
const stateKey = s => [s.timer, s.duty, s.rate, s.mode].join(",");
const shapeKey = s => [s.duty, s.rate, s.mode].join(",");      // the same, pitch left out
function envDistance(a, b) { const n = Math.max(a.length, b.length); let d = 0; for (let i = 0; i < n; i++) d += Math.abs(a[Math.min(i, a.length - 1)] - b[Math.min(i, b.length - 1)]); return d; }

// A relative pitch sequence (each value is added to the period every frame, as FamiTracker's
// "relative" pitch setting does) that moves a note's period like timers[i..end), or null when
// the pitch stays put or jumps more than one step can hold. Vibrato repeats, so a looping form
// is used when it is shorter. Ends in 0 (or loops), so drivers that stop a finished sequence
// and drivers that keep adding its last value play it the same way.
function pitchSeq(t, i, end) {
  if (!Array.isArray(t)) return null;
  const d = [0];
  for (let j = i + 1; j < end; j++) { const x = t[j] - t[j - 1]; if (x < -127 || x > 127) return null; d.push(x); }
  if (d.every(x => x === 0)) return null;
  let n = d.length; while (n > 1 && d[n - 1] === 0 && d[n - 2] === 0) n--;
  let values = d.slice(0, n), loop = null;
  if (values[values.length - 1] !== 0) values.push(0);
  const L = d.length;
  for (let q = 1; q < L; q++) {
    let s = 0;
    for (let j = L - 1; j >= q; j--) if (d[j] !== d[j - q]) { s = j - q + 1; break; }
    if (s + q < values.length) { values = d.slice(0, s + q); loop = s; }
  }
  return { values, loop, key: (loop ?? "-") + ":" + values.join(",") };
}
const instKey = d => (d.vol ? d.vol.join(",") : "-") + "/" + (d.pitch ? d.pitch.key : "-");

class SongCompiler {
  constructor(song) {
    this.frames = song.frames;
    this.loop = song.loopStart ?? null;
    this.rows = {};
    for (const c of CH_NAMES) this.rows[c] = expand(song.channels[c], this.frames);
    // per frame: state keys with and without the pitch (null when silent), compared a lot
    this.full = {}; this.shape = {};
    for (const c of CH_NAMES) {
      this.full[c] = this.rows[c].map(([s]) => s && stateKey(s));
      this.shape[c] = this.rows[c].map(([s]) => s && shapeKey(s));
    }
    this.starts = [];                       // [channel, env] of every note (and loop target) start
    for (const c of CH_NAMES) this.rows[c].forEach(([s, starts, env], f) => {
      if ((starts || (f === this.loop && s)) && env) this.starts.push([c, env]);
    });
    this.memo = new Map();
  }
  cached(arr, tag, i, make) {
    let m = this.memo.get(arr);
    if (!m) { m = new Map(); this.memo.set(arr, m); }
    const k = tag + i;
    if (!m.has(k)) m.set(k, make());
    return m.get(k);
  }
  // Key of the whole volume chunk a frame belongs to (decides how that note's volume is encoded).
  chunkKey(env) {
    const [vols, i, end] = env, cs = i - i % ENV_CHUNK;
    return this.cached(vols, "k", cs, () => envKey(trim(vols.slice(cs, end))));
  }
  pitchAt(env, i) { const t = env[3]; return t ? this.cached(t, "p", i, () => pitchSeq(t, i, env[2])) : null; }
  // Is this frame's pitch moved by its note's pitch sequence (rather than by pattern commands)?
  pitchOwned(env, plan) { return plan.pitch && env && env[3] ? this.pitchAt(env, env[1] - env[1] % ENV_CHUNK) !== null : false; }
  // What a note started (or restarted) at this frame plays: volume and pitch sequences.
  desc(ch, env, plan) {
    const pitch = plan.pitch && env && env[3] && this.pitchOwned(env, plan) ? this.pitchAt(env, env[1]) : null;
    if (ch === "triangle") return pitch ? { vol: null, pitch } : null;
    const vol = plan.col.has(this.chunkKey(env)) ? [15] : trim(env[0].slice(env[1], env[2]));
    return { vol, pitch };
  }
  // The instruments for one way of encoding:
  // - col: volume envelopes played by a flat instrument (volume 15) with volume-column commands
  //   where the volume changes, instead of a volume sequence of their own;
  // - pitch: vibrato and slides inside a note as pitch sequences instead of pitch commands.
  plan(col = new Set(), pitch = false) {
    const p = { col, pitch };
    const counts = new Map(), descOf = new Map();
    for (const [c, env] of this.starts) {
      const d = this.desc(c, env, p);
      if (!d) continue;
      const k = instKey(d); descOf.set(k, d); counts.set(k, (counts.get(k) || 0) + 1);
    }
    const ranked = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));   // stable, like Python's sorted
    p.kept = ranked.slice(0, MAX_INSTRUMENTS - 1).map(k => descOf.get(k));
    p.ids = new Map(p.kept.map((d, i) => [instKey(d), i + 1]));
    p.approximated = 0;
    for (const k of ranked.slice(MAX_INSTRUMENTS - 1)) {
      p.ids.set(k, this.closest(p.kept, descOf.get(k)));
      p.approximated += counts.get(k);
    }
    return p;
  }
  // The kept instrument nearest to d (same pitch sequence if one has it).
  closest(kept, d) {
    const pk = d.pitch ? d.pitch.key : "-";
    let best = -1, bestScore = Infinity;
    kept.forEach((c, i) => {
      const score = (c.vol && d.vol ? envDistance(d.vol, c.vol) : 0) + ((c.pitch ? c.pitch.key : "-") === pk ? 0 : 1e6);
      if (score < bestScore) { best = i; bestScore = score; }
    });
    return best + 1;
  }
  // Volume envelopes cheaper as volume-column commands: long ones that change rarely and are
  // used few times. `factor` shifts the trade-off (a few are tried; the smallest output wins).
  columnCandidates(factor) {
    const counts = new Map(), envOf = new Map();
    for (const [c, env] of this.starts) {
      if (c === "triangle") continue;
      const e = trim(env[0].slice(env[1], env[2])), k = envKey(e);
      envOf.set(k, e); counts.set(k, (counts.get(k) || 0) + 1);
    }
    const set = new Set();
    for (const [k, u] of counts) {
      if (k === "15") continue;
      const e = envOf.get(k);
      let changes = 0; for (let i = 1; i < e.length; i++) if (e[i] !== e[i - 1]) changes++;
      if (u * (changes + 1) * 3 * factor < e.length + 10) set.add(k);
    }
    return set;
  }
  // A note restarted part-way (pattern start, loop target) needs the rest of its sequences as an
  // instrument of its own: added while compiling, or the closest kept one once all are used.
  instrument(ch, env) {
    const cur = this.cur, d = this.desc(ch, env, cur.plan);
    if (!d) return 0;
    const k = instKey(d);
    if (!cur.ids.has(k)) {
      if (cur.kept.length < MAX_INSTRUMENTS - 1) { cur.kept.push(d); cur.ids.set(k, cur.kept.length); }
      else { cur.ids.set(k, this.closest(cur.kept, d)); cur.approximated++; }
    }
    return cur.ids.get(k);
  }
  pattern(ch, a, b, preds, effects, pad) {
    const rows = this.rows[ch], out = [], plan = this.cur.plan;
    let inst = null, duty = null, fine = null, base = null, pending = null, dur = 0, col = null;
    const useCol = plan.col.size > 0 && ch !== "triangle";
    const flush = () => {
      if (pending) { out.push(...pending, dur - 1); } else if (dur) out.push(0x00, dur - 1);
      pending = null; dur = 0;
    };
    const setFine = (timer, ev) => {
      const f2 = 0x80 - (timer - PERIODS[base - 1]);
      if (f2 !== fine) { if (f2 === 0x80) ev.push(CMD_RESET_PITCH); else ev.push(CMD_PITCH, f2); fine = f2; }
    };
    for (let f = a; f < b; f++) {
      const [s, starts, env] = rows[f];
      const ev = [...(effects[f - a] || [])];
      let note = 0;
      const prevs = f === a ? preds : [f - 1];
      if (!s) {
        if (prevs.some(p => p >= 0 && rows[p][0])) note = NOTE_HALT;
      } else {
        const owned = this.pitchOwned(env, plan), keys = (owned ? this.shape : this.full)[ch], k = keys[f];
        const changed = prevs.some(p => p < 0 || keys[p] === null || keys[p] !== k);
        let retrig = starts || (changed && (f === a || ch === "noise")) || (f === a && preds.length > 1);
        if (!retrig && changed) {
          if (s.duty !== undefined && s.duty !== duty) { ev.push(CMD_DUTY, s.duty); duty = s.duty; }
          // base unknown (note carried over from the previous pattern) or out of fine-pitch reach: restart it
          if ("timer" in s && !owned) { if (base === null || Math.abs(s.timer - PERIODS[base - 1]) > 127) retrig = true; else setFine(s.timer, ev); }
        }
        if (retrig) {
          const i = this.instrument(ch, env);
          if (i !== inst) { if (i < 16) ev.push(0xE0 | i); else ev.push(0x80, i << 1); inst = i; }
          const d = s.duty !== undefined ? s.duty : s.mode;
          if (d !== undefined && d !== duty) { ev.push(CMD_DUTY, d); duty = d; }
          if (ch === "noise") base = 0x11 + (s.rate ^ 15);
          else { base = nearestNote(s.timer); setFine(s.timer, ev); }
          note = base;
        }
        // volume column: the note's volume (column-encoded notes) or 15 (sequence notes)
        if (useCol) {
          const want = plan.col.has(this.chunkKey(env)) ? env[0][env[1]] : 15;
          if (want !== col) { ev.push(0xF0 | want); col = want; }
        }
      }
      if (ev.length || note) { flush(); pending = [...ev, note]; }
      dur++;
    }
    dur += pad;
    flush();
    return out;
  }
  compile(length, plan) {
    const { frames, loop } = this;
    this.cur = { plan, kept: plan.kept.slice(), ids: new Map(plan.ids), approximated: plan.approximated };
    const chunks = (a, b) => { const r = []; for (let s = a; s < b; s += length) r.push([s, Math.min(s + length, b)]); return r; };
    const blocks = loop !== null && loop > 0 ? [...chunks(0, loop), ...chunks(loop, frames)] : chunks(0, frames);
    if (blocks.length > 255) return null;
    const loopFrame = loop ? chunks(0, loop).length : 0;
    const frameRows = blocks.map(([a, b], i) => {
      let flow = [];
      if (i === blocks.length - 1) flow = loop !== null ? [CMD_JUMP, loopFrame + 1] : [CMD_HALT, 0];
      else if (b - a < length) flow = [CMD_SKIP, 1];
      const pats = CH_NAMES.map((ch, ci) => {
        const preds = [a ? a - 1 : -1];                 // frames that can come just before (-1: none)
        if (loop !== null && a === loop) preds.push(frames - 1);
        const effects = ci === 0 && flow.length ? { [b - a - 1]: flow } : {};
        return this.pattern(ch, a, b, preds, effects, length - (b - a));
      });
      pats.push([0x00, length - 1]);
      return pats;
    });
    const data = assemble(frameRows, length, this.cur.kept);
    data.approximated = this.cur.approximated;
    return data;
  }
}

// insts: [{vol: [..] | null, pitch: {values, loop} | null}]. Shared sequences are stored once.
function assemble(frameRows, patternLength, insts) {
  const blob = new Array(0x0F).fill(0);
  const w16 = v => blob.push(v & 0xFF, v >> 8);
  const seqs = new Map();
  const seq = (values, loop, setting) => {
    const k = [loop, setting, ...values].join(",");
    if (!seqs.has(k)) { seqs.set(k, blob.length); blob.push(values.length, loop ?? 0xFF, 0x00, setting, ...values.map(v => v & 0xFF)); }
    return seqs.get(k);
  };
  const ptrs = insts.map(d => [d.vol ? seq(d.vol, null, 0) : null, d.pitch ? seq(d.pitch.values, d.pitch.loop, 0) : null]);
  const instList = blob.length, instAt = instList + 2 * (insts.length + 1);
  w16(instAt);
  let at = instAt + 2;
  for (const [v, p] of ptrs) { w16(at); at += 2 + 2 * ((v !== null) + (p !== null)); }
  blob.push(0x00, 0x00);
  for (const [v, p] of ptrs) {
    blob.push(0x00, (v !== null ? 1 : 0) | (p !== null ? 4 : 0));
    if (v !== null) w16(v);
    if (p !== null) w16(p);
  }
  const empty = blob.length; blob.push(0x00);
  const songList = blob.length; w16(songList + 2);
  const frameList = blob.length + 8;
  // One frame record per frame, never shared: ZORA's square-channel swap skips a frame record
  // listed twice (an FtRandoLib quirk it keeps), which would leave repeats unswapped.
  const uniq = frameRows;
  w16(frameList); blob.push(frameRows.length, patternLength & 0xFF, 1, 150, 0, 0);
  const framesAt = frameList + 2 * frameRows.length;
  frameRows.forEach((fr, i) => w16(framesAt + 10 * i));
  const patBase = framesAt + 10 * uniq.length;
  const offsets = new Map(), pool = [];
  for (const fr of uniq) for (const p of fr) { const k = p.join(","); if (!offsets.has(k)) { offsets.set(k, patBase + pool.length); pool.push(...p); } }
  for (const fr of uniq) for (const p of fr) w16(offsets.get(p.join(",")));
  blob.push(...pool);
  const hdr = [songList, instList, empty, empty, empty];
  hdr.forEach((v, i) => { blob[2 * i] = v & 0xFF; blob[2 * i + 1] = v >> 8; });
  blob[10] = 0; blob[11] = 3600 & 0xFF; blob[12] = 3600 >> 8; blob[13] = 3000 & 0xFF; blob[14] = 3000 >> 8;
  if (blob.length > 0xFFFF) throw new Error("song too large");
  return Uint8Array.from(blob);
}

function compileSong(song) {
  const sc = new SongCompiler(song);
  // Plain volume sequences first; then mixes that move slow fades to volume-column commands
  // and vibrato to pitch sequences.
  const cols = [new Set()], seen = new Set([""]);
  for (const f of [0.5, 1, 2]) {
    const set = sc.columnCandidates(f), key = [...set].sort().join("|");
    if (set.size && !seen.has(key)) { seen.add(key); cols.push(set); }
  }
  const plans = [];
  for (const pitch of [false, true]) for (const c of cols) plans.push(sc.plan(c, pitch));
  // Every pattern length for the plain plan; the others are tried at a sample of lengths, and
  // the most promising one gets the full search too.
  const scan = (plan, lengths) => {
    let b = null; const sizes = [];
    for (const n of lengths) { const d = sc.compile(n, plan); if (d) { sizes.push([d.length, n]); if (!b || d.length < b.length) b = d; } }
    return { best: b, sizes };
  };
  const all = []; for (let n = 16; n < 256; n++) all.push(n);
  const plain = scan(plans[0], all);
  let best = plain.best;
  const sample = [...new Set([...plain.sizes.sort((x, y) => x[0] - y[0]).slice(0, 6).map(x => x[1]),
    16, 24, 32, 48, 64, 80, 96, 128, 160, 192, 240])];
  let pick = null;
  for (const plan of plans.slice(1)) {
    const r = scan(plan, sample);
    if (r.best && (!pick || r.best.length < pick.size)) pick = { plan, size: r.best.length };
  }
  if (pick && best && pick.size < best.length * 1.1) {
    const r = scan(pick.plan, all);
    if (r.best && r.best.length < best.length) best = r.best;
  }
  return { data: best, approximated: best ? best.approximated : 0 };
}

function toBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s);
}

// Write a music pack. Accepts one group or an array of groups.
function toPlayerJson5(groups, mode = "z1") {
  if (!Array.isArray(groups)) groups = [groups];
  const alwaysEnabled = GAME_MODES[mode].alwaysEnabled;
  const s = v => JSON.stringify(v);
  const L = ["{", "\tsingle: [],", "\tgroups: ["];
  for (const group of groups) {
    L.push("\t\t{");
    for (const k of ["title", "author", "primary_square_chan", "streaming_safe"]) L.push(`\t\t\t${k}: ${s(group[k])},`);
    L.push("\t\t\titems: [");
    for (const it of group.items) {
      L.push("\t\t\t\t{");
      if (alwaysEnabled || !it.enabled) L.push(`\t\t\t\t\tenabled: ${s(it.enabled)},`);
      L.push(`\t\t\t\t\ttitle: ${s(it.title)},`);
      if (it.uses) L.push(`\t\t\t\t\tuses: ${s(it.uses)},`);
      if (it.primary_square_chan !== undefined) L.push(`\t\t\t\t\tprimary_square_chan: ${s(it.primary_square_chan)},`);
      L.push(`\t\t\t\t\tdata: ${s(it.data)}`, "\t\t\t\t},");
    }
    L.push("\t\t\t]", "\t\t},");
  }
  L.push("\t]", "}");
  return L.join("\n") + "\n";
}

// ------------------------------------------------------------------ ZORA settings

// The two randomizers a pack can be for. Both read the same file layout and module data; they
// differ in the "uses" names, the default uses, the group's primary_square_chan, and whether
// items carry "enabled" (Zelda 2 packs only mark disabled tracks).
const GAME_MODES = {
  z1: { key: "z1", game: "Zelda 1", randomizer: "ZORA",
        uses: ["Overworld", "Dungeon", "LastDungeon", "Ending", "Title"],   // Title: ZORA 2.0 beta 9 and later
        defaultUses: ["Dungeon", "LastDungeon"],      // ZORA's own default
        labels: { LastDungeon: "Last dungeon" },
        groupPsc: 0, alwaysEnabled: true,
        bankRoom: 0x4000 - 0x1800 },                  // ZORA: a module must fit one music bank after the driver
  z2: { key: "z2", game: "Zelda 2", randomizer: "Z2R",
        uses: ["Encounter", "Cave", "Boss", "LastBoss", "GreatPalace", "House", "Overworld", "Palace", "PalaceClear", "Title", "Town", "GameComplete", "Credits"],
        defaultUses: [],                              // picked per track
        labels: { LastBoss: "Last boss", GreatPalace: "Great Palace", PalaceClear: "Palace clear", GameComplete: "Game complete" },
        groupPsc: 1, alwaysEnabled: false,
        bankRoom: 0x2000,                             // Z2R (Music.cs): 8 KB banks, modules at $A000-$BFFF
        banks: 12,                                    // ROM.FreeRomBanks: banks $10-$1B
        songsPerSeed: 27 },                           // Music.cs numUsageSongs: 1+1+4+4+4+6+1+1+1+1+1+1+1
};
// "Both" (beta): one list tagged for both games at once. A tag is "z1:Overworld" / "z2:Overworld";
// an export for one game keeps only that game's tags (see exportTags).
GAME_MODES.both = { key: "both", game: "Zelda 1 + Zelda 2", randomizer: "ZORA and Z2R",
  uses: [...GAME_MODES.z1.uses.map(u => "z1:" + u), ...GAME_MODES.z2.uses.map(u => "z2:" + u)],
  defaultUses: [], labels: {}, groupPsc: 0, alwaysEnabled: false };
const BOTH_NAMES = { z1: "ZORA", z2: "Z2R" };
// A tag's text for lists: plain in one game's mode, "ZORA: Overworld" in Both.
function useLabel(mode, u) {
  const m = u.match(/^(z[12]):(.*)$/);
  if (!m) return mode.labels[u] || u;
  return `${BOTH_NAMES[m[1]]}: ${GAME_MODES[m[1]].labels[m[2]] || m[2]}`;
}
// The tags of one game in a Both list, without the prefix ("z1:Dungeon" -> "Dungeon").
const exportTags = (uses, game) => uses.filter(u => u.startsWith(game + ":")).map(u => u.slice(3));

// Would these module sizes fit Z2R's music banks? Packs them the way FtRandoLib's
// ImportEngineModules does in one import: largest first; each fresh bank is filled from its end
// with the largest module that still fits (leftover space is only reused by later imports).
function fitsBanks(sizes, banks, bankSize) {
  const left = [...sizes].sort((a, b) => b - a);
  for (let bank = 0; bank < banks && left.length; bank++) {
    let room = bankSize;
    for (let i = 0; i < left.length;) {
      if (left[i] <= room) { room -= left[i]; left.splice(i, 1); } else i++;
    }
  }
  return left.length === 0;
}

// Which game a loaded pack is for, from its tracks' uses: "z1", "z2", or null (no game-specific uses).
function detectMode(doc) {
  const items = [...((doc && doc.single) || []), ...((doc && doc.groups) || []).flatMap(g => g.items || [])];
  const uses = new Set(items.flatMap(it => [...(it.uses || []), ...(it.songs || []).flatMap(s => s.uses || [])]).map(u => String(u).toLowerCase()));
  const all = m => GAME_MODES[m].uses;
  const only = (a, b) => all(a).filter(u => !all(b).includes(u)).some(u => uses.has(u.toLowerCase()));
  const z1 = only("z1", "z2"), z2 = only("z2", "z1");
  return z1 && !z2 ? "z1" : z2 && !z1 ? "z2" : null;
}

// Which pulse channel carries the melody (0 or 1): the one that plays higher on average.
function guessMelody(states) {
  const avg = ch => { let sum = 0, n = 0; for (const s of ch) if (s) { sum -= Math.log2(s.timer + 1); n++; } return n ? sum / n : -Infinity; };
  return avg(states[1]) > avg(states[0]) ? 1 : 0;
}

// ------------------------------------------------------------------ audio preview

// Per-frame channel states for a converted NSF song: {frames, loopStart, states: [4 arrays]}
function songStates(song) {
  return { frames: song.frames, loopStart: song.loopStart ?? null,
           states: CH_NAMES.map(c => expand(song.channels[c], song.frames).map(r => r[0])) };
}

// Render per-frame channel states to mono samples. Returns {samples, loopStartSec, endSec}.
function renderAudio(track, frameRate, sampleRate) {
  const rows = track.states.map(a => a.map(s => [s]));
  const song = { frames: track.frames, loopStart: track.loopStart };
  const spf = sampleRate / frameRate;
  const total = Math.ceil(song.frames * spf);
  const out = new Float32Array(total);
  const DUTY = [[0, 1, 0, 0, 0, 0, 0, 0], [0, 1, 1, 0, 0, 0, 0, 0], [0, 1, 1, 1, 1, 0, 0, 0], [1, 0, 0, 1, 1, 1, 1, 1]];
  const TRI = []; for (let i = 15; i >= 0; i--) TRI.push(i); for (let i = 0; i < 16; i++) TRI.push(i);
  const ph = [0, 0, 0], cpuPerSample = CPU_HZ / sampleRate;
  let triOut = 0, lfsr = 1, noiseAcc = 0, hp = 0, prevIn = 0, idx = 0;
  for (let f = 0; f < song.frames; f++) {
    const end = Math.min(total, Math.round((f + 1) * spf));
    const [p1, p2, tr, no] = rows.map(r => r[f][0]);
    for (; idx < end; idx++) {
      let pulse = 0;
      [p1, p2].forEach((s, i) => {
        if (!s) return;
        ph[i] = (ph[i] + cpuPerSample / (16 * (s.timer + 1))) % 1;
        pulse += DUTY[s.duty][Math.floor(ph[i] * 8)] * s.vol;
      });
      if (tr) { ph[2] = (ph[2] + cpuPerSample / (32 * (tr.timer + 1))) % 1; triOut = TRI[Math.floor(ph[2] * 32)]; }
      let noise = 0;
      if (no) {
        noiseAcc += cpuPerSample;
        const period = NOISE_PERIOD[no.rate];
        while (noiseAcc >= period) { noiseAcc -= period; const fb = (lfsr & 1) ^ ((lfsr >> (no.mode ? 6 : 1)) & 1); lfsr = (lfsr >> 1) | (fb << 14); }
        noise = (lfsr & 1) ? 0 : no.vol;
      }
      const po = pulse ? 95.88 / (8128 / pulse + 100) : 0;
      const tnd = (triOut || noise) ? 159.79 / (1 / (triOut / 8227 + noise / 12241) + 100) : 0;
      const x = po + tnd;
      hp = 0.996 * (hp + x - prevIn); prevIn = x;      // remove DC offset
      out[idx] = hp;
    }
  }
  return { samples: out, loopStartSec: song.loopStart != null ? song.loopStart / frameRate : null, endSec: song.frames / frameRate };
}

// ------------------------------------------------------------------ JSON5 input

// Minimal JSON5 reader: objects, arrays, strings ('' or ""), numbers, true/false/null,
// unquoted keys, comments and trailing commas.
function parseJson5(text) {
  let i = 0;
  const err = m => { throw new Error(`JSON5 error near character ${i}: ${m}`); };
  const ws = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith("//", i)) { while (i < text.length && text[i] !== "\n") i++; }
      else if (text.startsWith("/*", i)) { const e = text.indexOf("*/", i + 2); if (e < 0) err("unclosed comment"); i = e + 2; }
      else return;
    }
  };
  const str = () => {
    const q = text[i++]; let out = "";
    while (i < text.length && text[i] !== q) {
      if (text[i] === "\\") {
        const c = text[++i];
        if (c === "u") { out += String.fromCharCode(parseInt(text.substr(i + 1, 4), 16)); i += 4; }
        else out += { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" }[c] ?? (c === "\n" ? "" : c);
        i++;
      } else out += text[i++];
    }
    if (text[i] !== q) err("unclosed string");
    i++; return out;
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++; const o = {};
      for (;;) {
        ws(); if (text[i] === "}") { i++; return o; }
        let k;
        if (text[i] === '"' || text[i] === "'") k = str();
        else { const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 200)); if (!m) err("bad key"); k = m[0]; i += k.length; }
        ws(); if (text[i] !== ":") err("expected ':'"); i++;
        o[k] = value(); ws();
        if (text[i] === ",") i++; else if (text[i] !== "}") err("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++; const a = [];
      for (;;) {
        ws(); if (text[i] === "]") { i++; return a; }
        a.push(value()); ws();
        if (text[i] === ",") i++; else if (text[i] !== "]") err("expected ',' or ']'");
      }
    }
    if (c === '"' || c === "'") return str();
    const m = /^(true|false|null|[+-]?(0x[0-9a-fA-F]+|Infinity|NaN|\d*\.?\d+([eE][+-]?\d+)?))/.exec(text.slice(i, i + 64));
    if (!m) err("unexpected value");
    i += m[0].length;
    return m[0] === "true" ? true : m[0] === "false" ? false : m[0] === "null" ? null : Number(m[0]);
  };
  const v = value(); ws();
  if (i < text.length) err("trailing text");
  return v;
}

function fromBase64(s) {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  const b = atob(s), out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

// ------------------------------------------------------------------ FamiTracker data playback
// Plays FamiTracker binary music data (2A03 channels) the way the FT driver does and
// returns per-frame channel states. Covers what NES rips use: instruments with volume,
// arpeggio, pitch, hi-pitch and duty sequences; volume column; Pxx, Vxx, Sxx, Bxx,
// Dxx, Cxx, speed/tempo. Other effects are read and skipped.

const FT_CMDS = ["instrument", "hold", "set_duration", "reset_duration", "speed", "tempo",
  "jump", "skip", "halt", "volume", "clear", "portaup", "portadown", "portamento",
  "arpeggio", "vibrato", "tremolo", "pitch", "reset_pitch", "duty", "delay",
  "sweep", "dac", "offset", "slide_up", "slide_down", "vol_slide", "note_cut",
  "retrigger", "dpcm_pitch", "note_release", "linear_counter", "groove", "delayed_volume", "transpose"];
const FT_NO_PARAM = new Set(["hold", "reset_duration", "clear", "reset_pitch"]);
const FT_TWO_PARAMS = new Set(["offset", "retrigger"]);

function ftVolume(col, seq) {
  if (!col || !seq) return 0;
  return col * seq < 15 ? 1 : Math.floor(col * seq / 15);
}

function ftPlay(b, maxFrames, followLoop = false) {
  const w = o => b[o] | b[o + 1] << 8;
  const songHdr = w(w(0)), instList = w(2);
  const frameList = w(songHdr), nframes = b[songHdr + 2], plen = b[songHdr + 3] || 256;
  let speed = b[songHdr + 4] || 1, tempo = b[songHdr + 5] || 150;
  const frames = []; for (let f = 0; f < nframes; f++) { const fp = w(frameList + 2 * f); frames.push([0, 1, 2, 3, 4].map(c => w(fp + 2 * c))); }
  // instruments
  const insts = [];
  const firstInst = w(instList);
  for (let ip = instList; ip < firstInst; ip += 2) {
    const p = w(ip), mask = b[p + 1], seqs = {};
    let q = p + 2;
    ["volume", "arpeggio", "pitch", "hipitch", "duty"].forEach((nm, k) => {
      if (mask >> k & 1) {
        const s = w(q); q += 2;
        seqs[nm] = { loop: b[s + 1] === 0xFF ? null : b[s + 1], release: b[s + 2], setting: b[s + 3], values: Array.from(b.subarray(s + 4, s + 4 + b[s])) };
      }
    });
    insts.push(seqs);
  }
  const ch = [0, 1, 2, 3, 4].map(() => ({ pos: 0, wait: 0, fixed: null, note: 0, base: 0, period: 0, fine: 0x80, col: 15, duty: 0,
    inst: 0, seqPos: {}, seqVal: { volume: 15, duty: null }, cut: 0, released: false,
    arp: 0, arpRel: 0, arpEnded: false, arpSeqOn: false, arpStep: 0, vib: 0, vibPhase: 0, port: 0, portOff: 0, slide: null, slideCur: 0, delay: 0, late: false }));
  const out = [[], [], [], []];
  let frame = 0, row = 0, accum = 0, loopStart = null, endFrame = null, endCmd = null;
  const firstPlayed = new Map();          // frame-list index -> output frame it first started
  const enter = f => { frame = f; row = 0; for (let c = 0; c < 5; c++) { ch[c].pos = frames[f][c]; ch[c].wait = 0; } if (!firstPlayed.has(f)) firstPlayed.set(f, out[0].length); };
  enter(0);
  const sb = v => v < 128 ? v : v - 256;
  const trigger = (st, c, n) => {
    st.note = n; st.released = false;
    if (c === 3) st.base = n; else st.base = PERIODS[Math.min(n, 96) - 1];
    st.period = st.base; st.arpRel = 0; st.arpEnded = false; st.arpSeqOn = false; st.portOff = 0; st.slideCur = st.base; st.vibPhase = 0; st.arpStep = 0;
    if (st.slide) { if (st.slide.fresh) { st.slide.fresh = false; st.slide.target = null; } else st.slide = null; }   // a slide lasts for one note
    for (const k in insts[st.inst] || {}) st.seqPos[k] = 0;
  };
  const readRow = () => {
    let flow = null;
    const readChannel = c => {
      const st = ch[c];
      for (let guard = 0; guard < 64; guard++) {
        const v = b[st.pos++];
        if (v >= 0xF0) st.col = v & 15;
        else if (v >= 0xE0) st.inst = v & 15;
        else if (v >= 0x80) {
          const name = FT_CMDS[v - 0x80] || "unknown";
          const p = FT_NO_PARAM.has(name) ? null : b[st.pos++];
          if (FT_TWO_PARAMS.has(name)) st.pos++;
          switch (name) {
            case "instrument": st.inst = p >> 1; break;
            case "set_duration": st.fixed = p; break;
            case "reset_duration": st.fixed = null; break;
            case "speed": speed = p || 1; break;
            case "tempo": tempo = p || 150; break;
            case "jump": case "skip": case "halt": flow = [name, p, st.pos - 2]; break;   // [kind, param, offset]
            case "pitch": st.fine = p; break;
            case "reset_pitch": st.fine = 0x80; break;
            case "duty": st.duty = p; st.seqVal.duty = null; break;
            case "note_cut": st.cut = p | 0x80; break;
            case "arpeggio": st.arp = p; break;
            case "vibrato": st.vib = p; break;
            case "portaup": st.port = -p; st.slide = null; break;
            case "portadown": st.port = p; st.slide = null; break;
            case "slide_up": st.slide = { speed: p >> 4, semis: p & 15, dir: 1, target: null, fresh: true }; st.port = 0; break;
            case "slide_down": st.slide = { speed: p >> 4, semis: p & 15, dir: -1, target: null, fresh: true }; st.port = 0; break;
            case "delay": st.delay = 1; break;
            case "clear": st.arp = 0; st.vib = 0; st.port = 0; st.slide = null; break;
          }
          if (st.delay) { st.delay = 0; st.late = true; return; }          // Gxx: the rest of this row waits until the next row (bhop)
        } else {
          if (v === 0x7F) { st.note = 0; }
          else if (v === 0x7E) { st.released = true; }
          else if (v) { if (!(st.cut & 0x80)) st.cut = 0; trigger(st, c, v); }
          st.wait = st.fixed === null ? b[st.pos++] : st.fixed;
          return;
        }
      }
    };
    for (let c = 0; c < 5; c++) {
      const st = ch[c];
      if (st.late) { st.late = false; readChannel(c); if (st.wait) { st.wait--; continue; } }   // the delayed row, read first
      if (st.wait) { st.wait--; continue; }
      readChannel(c);
    }
    return flow;
  };
  const runSeqs = (st, c) => {
    const seqs = insts[st.inst] || {};
    for (const k in seqs) {
      const s = seqs[k]; let pos = st.seqPos[k];
      if (pos === undefined || pos === null || !s.values.length) continue;
      const val = s.values[Math.min(pos, s.values.length - 1)];
      if (k === "volume") st.seqVal.volume = val;
      else if (k === "duty") st.seqVal.duty = val;
      else if (k === "pitch") { if (s.setting) st.period = st.base + sb(val); else st.period += sb(val); }
      else if (k === "hipitch") st.period += sb(val) * 16;
      else if (k === "arpeggio" && st.note && !st.arpEnded) {
        let n;
        if (s.setting === 1) n = val + 1;                                    // fixed note
        else if (s.setting === 2) { st.arpRel = (st.arpRel + sb(val)) | 0; n = st.note + st.arpRel; }   // relative: adds up each frame
        else n = st.note + sb(val);                                           // absolute (scheme plays like absolute)
        if (c === 3) st.base = Math.max(1, Math.min(16, n));                  // noise: the arpeggio picks its pitch
        else st.period = PERIODS[Math.max(0, Math.min(95, n - 1))];
        st.arpSeqOn = true;
      }
      pos++;
      if (pos >= s.values.length) { if (s.loop !== null) pos = s.loop; else { pos = s.values.length - 1; if (k === "arpeggio") st.arpEnded = true; } }
      st.seqPos[k] = pos;
    }
    if (!("volume" in seqs)) st.seqVal.volume = 15;
  };
  // FT timing: a row is read whenever the tempo accumulator reaches speed * 150
  // (speed 1 / tempo 150 = one row per frame).
  accum = speed * 150;
  let flow = null, started = false;
  while (out[0].length < maxFrames) {
    accum += tempo;
    if (accum >= speed * 150) {
      accum -= speed * 150;
      if (started) {                                  // move past the row just played
        let target = null;
        if (flow && flow[0] === "halt") { if (endFrame === null) { endFrame = out[0].length; endCmd = { at: flow[2], kind: "halt" }; } break; }
        if (flow && flow[0] === "jump") target = flow[1] - 1;
        else if (flow && flow[0] === "skip") target = (frame + 1) % nframes;
        else if (++row >= plen) target = (frame + 1) % nframes;
        if (target !== null) {
          if (firstPlayed.has(target) && endFrame === null) {
            loopStart = firstPlayed.get(target); endFrame = out[0].length;
            if (flow && flow[0] === "jump") endCmd = { at: flow[2], kind: "jump" };
            if (!followLoop) break;
          }
          enter(target);
          if (flow && flow[0] === "skip") for (let k = 1; k < flow[1]; k++) { readRow(); row++; }
        }
      }
      flow = readRow();
      started = true;
    }
    for (let c = 0; c < 4; c++) {
      const st = ch[c];
      if (st.cut) {                                   // Sxx: cut the note after xx frames
        if (st.cut & 0x80) st.cut &= 0x7F; else st.cut--;
        if (!st.cut) st.note = 0;
      }
      st.arpSeqOn = false;
      if (st.note) runSeqs(st, c);
      let eff = st.period;
      if (st.note && c !== 3) {
        if (st.slide) {
          const sl = st.slide;
          if (sl.target === null) { sl.target = PERIODS[Math.max(0, Math.min(95, st.note + sl.dir * sl.semis - 1))]; if (!st.slideCur) st.slideCur = st.base; }
          const step = 2 * sl.speed + 1;
          st.slideCur += st.slideCur < sl.target ? Math.min(step, sl.target - st.slideCur) : -Math.min(step, st.slideCur - sl.target);
          eff = st.slideCur;
        }
        st.portOff += st.port; eff += st.portOff;
        if (st.arp && !(st.arpSeqOn && !st.arpEnded)) {
          const off = [0, st.arp >> 4, st.arp & 15][st.arpStep++ % 3];
          eff = PERIODS[Math.max(0, Math.min(95, st.note + off - 1))];
        }
        if (st.vib) { st.vibPhase = (st.vibPhase + (st.vib >> 4)) & 63; eff += Math.round(Math.sin(st.vibPhase * Math.PI / 32) * (st.vib & 15)); }
      }
      const vol = c === 2 ? (st.col ? 15 : 0) : ftVolume(st.col, st.seqVal.volume);
      const duty = st.seqVal.duty ?? st.duty;
      let s = null;
      if (st.note && vol) {
        if (c === 3) s = { rate: ((st.base - 1) & 15) ^ 15, mode: duty & 1, vol };
        else {
          const timer = eff + 0x80 - st.fine;
          if (timer >= (c === 2 ? 2 : 8) && timer <= 0x7FF) s = c === 2 ? { timer } : { timer, vol, duty: duty & 3 };
        }
      }
      out[c].push(s);
    }
  }
  return { frames: endFrame ?? out[0].length, loopStart, states: out, endCmd, starts: Array.from({ length: nframes }, (_, f) => firstPlayed.has(f) ? firstPlayed.get(f) : null) };
}

// ------------------------------------------------------------------ volume

// Scale a song's volume. The FT driver plays notes at (volume column x envelope) / 15:
// - songs that set the volume column (F0-FF) before each pulse/noise channel's first
//   note (like the Faxanadu file) get their volume-column commands scaled;
// - songs with no volume-column commands (what this tool exports) get their volume
//   envelopes scaled.
// Nonzero volumes never drop to 0. Returns a new array; the input is not changed.
// Where a song's scalable volumes are: the volume-column bytes if it has any, else its volume
// sequence values. [offsets, isColumn].
function volumeBytes(b) {
  const w = o => b[o] | b[o + 1] << 8;
  const hdr = w(w(0)), fl = w(hdr), nframes = b[hdr + 2], plen = b[hdr + 3] || 256;
  const fcmds = [];                                  // offsets of F0-FF bytes
  const pats = new Set();
  for (let f = 0; f < nframes; f++) { const fp = w(fl + 2 * f); for (let c = 0; c < 5; c++) pats.add(w(fp + 2 * c)); }
  for (let o of pats) {
    let row = 0, fixed = null;
    while (row < plen) {
      const c = b[o++];
      if (c >= 0xF0) fcmds.push(o - 1);
      else if (c >= 0x80 && c < 0xE0) {
        const name = FT_CMDS[c - 0x80];
        if (name === "set_duration") fixed = b[o]; else if (name === "reset_duration") fixed = null;
        if (!FT_NO_PARAM.has(name)) o++;
        if (FT_TWO_PARAMS.has(name)) o++;
      } else if (c < 0x80) { row += (fixed === null ? b[o++] : fixed) + 1; }
    }
  }
  if (fcmds.length) return [fcmds, true];
  return [seqBytes(b), false];
}

// Offsets of the volume-sequence values of every instrument that has one.
function seqBytes(b) {
  const w = o => b[o] | b[o + 1] << 8;
  const out = [], instList = w(2), first = w(instList), done = new Set();
  for (let ip = instList; ip < first; ip += 2) {
    const p = w(ip);
    if (!(b[p + 1] & 1)) continue;
    const s = w(p + 2);
    if (done.has(s)) continue; done.add(s);
    for (let i = s + 4; i < s + 4 + b[s]; i++) out.push(i);
  }
  return out;
}

function scaleVolume(data, pct) {
  if (pct === 100) return data;
  const b = Uint8Array.from(data);
  const sc = v => v === 0 ? 0 : Math.max(1, Math.min(15, Math.floor(v * pct / 100 + 0.5)));
  const [offsets, isColumn] = volumeBytes(b);
  for (const o of offsets) b[o] = isColumn ? 0xF0 | sc(b[o] & 15) : sc(b[o]);
  // A song can mix both: notes with a volume column of their own (envelope 15) and notes that play an
  // envelope (column 15). Scale the envelopes too, or only the first kind gets louder.
  if (isColumn) for (const o of seqBytes(b)) b[o] = sc(b[o]);
  return b;
}

// Flatten a fast volume flicker (the volume jumping up and down every frame or two, which sounds buzzy on
// the pulse channels). The song is played back, the flickering stretches of the two pulse channels get the
// average of the 4 frames around them, and the result is compiled again. Plain decays and swells are left
// alone. Returns {data, endCmd}, or null when there is nothing to flatten.
function flickerStates(info) {
  const n = info.frames;
  let changed = 0, sounding = 0;
  const states = CH_NAMES.map((name, ch) => {
    const st = info.states[ch].slice(0, n).map(s => s ? { ...s } : s);
    if (ch < 2) {
      const v = st.map(s => s && s.vol !== undefined ? s.vol : null);
      for (let i = 0; i < n; i++) {
        if (v[i] === null || v[i] === 0) continue;
        sounding++;
        let flips = 0, dir = 0, lo = 99, hi = 0, ok = true;
        for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) {
          if (v[k] === null) { ok = false; break; }
          lo = Math.min(lo, v[k]); hi = Math.max(hi, v[k]);
          if (k > Math.max(0, i - 3)) { const d = Math.sign(v[k] - v[k - 1]); if (d && dir && d !== dir) flips++; if (d) dir = d; }
        }
        if (!ok || flips < 3 || hi - lo < 3) continue;
        let sum = 0, c = 0;
        for (let k = Math.max(0, i - 1); k <= Math.min(n - 1, i + 2); k++) if (v[k] !== null) { sum += v[k]; c++; }
        const nv = Math.max(1, Math.round(sum / c));
        if (nv !== v[i]) { st[i].vol = nv; changed++; }
      }
    }
    return st;
  });
  return { states, changed, sounding };
}

// How much of a track's pulse playing is volume flicker (0 to 1): the share of sounding pulse frames that Smooth would change.
function flickerShare(data) {
  const f = flickerStates(ftPlay(data, Math.round(60.0988 * 900)));
  return f.sounding ? f.changed / f.sounding : 0;
}

function smoothTrack(data) {
  const info = ftPlay(data, Math.round(60.0988 * 900)), n = info.frames, channels = {};
  const f = flickerStates(info);
  if (!f.changed) return null;
  CH_NAMES.forEach((name, ch) => {
    const tr = new Track(name);
    for (let k = 0; k < n; k++) tr.feed(k, f.states[ch][k], false);
    channels[name] = tr.finish(n);
  });
  const c = compileSong({ frames: n, loopStart: info.loopStart ?? null, channels });
  if (!c.data) return null;
  const chk = ftPlay(c.data, Math.round(60.0988 * 900));
  if (chk.frames !== n || chk.loopStart !== info.loopStart) return null;    // didn't come back the same length: leave the track alone
  return { data: c.data, endCmd: chk.endCmd };
}

// The highest Vol % that makes a track louder without distorting it: its loudest volume value
// reaches 15 and nothing is cut off at the top (100 when it's already there).
function peakVolume(data) {
  const [offsets, isColumn] = volumeBytes(data);
  let peak = 0;
  for (const o of offsets) peak = Math.max(peak, isColumn ? data[o] & 15 : data[o]);
  if (!peak) return 100;
  const pct = Math.max(100, Math.min(300, Math.floor(15.49 / peak * 100)));
  // a few % that rounds every value back to itself changes nothing: call that 100
  for (let v = 1; v <= peak; v++) if (Math.floor(v * pct / 100 + 0.5) !== v) return pct;
  return 100;
}

// ------------------------------------------------------------------ looping

// Make a song loop or play once by rewriting the command that ends it (endCmd from ftPlay):
// a jump back (Bxx) becomes a stop (C00), or a stop becomes a jump to the start (B00).
// Both are two bytes, so nothing else moves. Returns new data (or the same data if unchanged).
// Turning the loop off keeps the loop point: the halt command's parameter (which players ignore)
// holds the jump's target, so turning the loop back on, even after a save and reload, returns to
// the same point instead of the very start.
function setLoop(data, endCmd, loop) {
  if (!endCmd || (endCmd.kind === "jump") === loop) return data;
  const b = Uint8Array.from(data);
  if (loop) { const target = b[endCmd.at + 1]; b[endCmd.at] = 0x86; b[endCmd.at + 1] = target || 1; }   // no saved point: frame 0
  else { const target = b[endCmd.at + 1]; b[endCmd.at] = 0x88; b[endCmd.at + 1] = target; }
  return b;
}

// A song whose own data repeats the same stretch several times before it loops (the sound engine's
// counters only came round again after a few passes) plays minutes of the same music. When the loop is
// a whole number of identical passes (the data repeats with that period from its very first frame), keep one: the frame list
// is cut after it, and the song wraps to its first frame. Returns the same data when nothing applies.
function tightenLoop(data) {
  const info = ftPlay(data, Math.round(60.0988 * 900));
  if (info.loopStart === null || !info.starts || !info.endCmd || info.endCmd.kind !== "jump") return data;
  const n = info.frames, S = info.states;
  const key = (S, f) => [0, 1, 2, 3].map(i => { const s = S[i][f]; return s ? (i === 3 ? "n" + s.rate : (s.timer || 0) + "/" + (s.vol > 0 ? 1 : 0)) : "-"; }).join("|");
  const sig = []; for (let f = 0; f < n; f++) sig.push(key(S, f));
  const same = (a, b) => sig[a] === sig[b] || sig[a] === sig[b + 1] || sig[a] === sig[b - 1];
  const P = n - info.loopStart, w = (b, o) => b[o] | b[o + 1] << 8, L0 = info.starts.length - 1;
  // Cut the frame list after `idx` and put the song's last frame (the one with the jump back) at the end,
  // either in place of frame idx - 1 (a last frame with music in it) or after frame idx (a jump-only one).
  // toStart: the jump goes to the first frame. Accepted only if the result sounds like the start of the original.
  const cut = (idx, after, toStart, wantFrames, wantLoop) => {
    const b = Uint8Array.from(data), hdr = w(b, w(b, 0)), list = w(b, hdr), at = after ? idx : idx - 1;
    if (at <= 0 || at >= L0) return null;
    b[list + 2 * at] = b[list + 2 * L0]; b[list + 2 * at + 1] = b[list + 2 * L0 + 1]; b[hdr + 2] = at + 1;
    if (toStart) b[info.endCmd.at + 1] = 1;
    const chk = ftPlay(b, Math.round(60.0988 * 900));
    if (chk.loopStart !== wantLoop || Math.abs(chk.frames - wantFrames) > 8 || !chk.endCmd || chk.endCmd.kind !== "jump") return null;
    let ok = 0, tot = 0; for (let f = 0; f < chk.frames && f < n; f += 3) { tot++; if (key(chk.states, f) === sig[f]) ok++; }
    return ok / tot >= 0.99 ? b : null;
  };
  const near = t => info.starts.findIndex(s => s !== null && Math.abs(s - t) <= 4);
  for (let k = Math.floor(P / 600); k >= 2; k--) {           // fewest frames first: the shortest repeat
    const p = Math.round(P / k);
    if (p < 600) continue;
    let mm = 0, tt = 0; for (let f = 0; f + p < n; f += 2) { tt++; if (same(f, f + p)) mm++; }
    const fromStart = mm / tt >= 0.99;                       // one pass from the very first frame: loop to the start
    mm = 0; tt = 0; for (let f = info.loopStart; f + p < n; f += 2) { tt++; if (same(f, f + p)) mm++; }
    if (mm / tt < 0.99) continue;
    if (fromStart) { const i0 = near(p); if (i0 > 0) { const r = cut(i0, true, true, p, 0) || cut(i0, false, true, p, 0); if (r) return r; } }
    const i1 = near(info.loopStart + p);
    if (i1 > 1) { const r = cut(i1, true, false, info.loopStart + p, info.loopStart) || cut(i1, false, false, info.loopStart + p, info.loopStart); if (r) return r; }
  }
  return data;
}

// ------------------------------------------------------------------ loudness

// How loud a track plays at a given volume %: RMS of its first pass (up to 3 minutes),
// rendered at a low sample rate (plenty for a level measurement).
function loudness(data, pct, only) {            // only: optional [bool x4] of channels to include
  const info = ftPlay(scaleVolume(data, pct), Math.round(60.0988 * 180));
  const frames = Math.min(info.frames, info.states[0].length);
  if (!frames) return 0;
  const states = only ? info.states.map((s, i) => only[i] ? s : Array(frames).fill(null)) : info.states;
  const r = renderAudio({ frames, loopStart: null, states }, 60.0988, 8000);
  // Loudness by ear, not by raw energy: bright (high) sounds seem louder than low ones. The level is
  // the flat RMS and the RMS above ~600 Hz blended in dB (0.44 / 0.56), which tracks an A-weighted
  // reading closely and costs one pass; LOUD_K keeps the scale where it was.
  const a = 1 - Math.exp(-2 * Math.PI * 600 / 8000);          // one-pole high-pass: x minus its low-passed copy
  let sum = 0, sumHi = 0, lp = 0;
  for (const v of r.samples) { sum += v * v; lp += a * (v - lp); const h = v - lp; sumHi += h * h; }
  const n = r.samples.length, flat = Math.sqrt(sum / n), hi = Math.sqrt(sumHi / n);
  return flat > 0 ? LOUD_K * Math.pow(flat, 0.44) * Math.pow(hi, 0.56) : 0;
}
const LOUD_K = 1.98;

// The volume % (5-300) that brings a track closest to `target` loudness. Louder % never
// plays quieter, so a binary search works; volumes cap at 15, so some tracks can't reach it.
const MIN_NORMALIZE = 5;
function volumeFor(data, target, cache = new Map(), lowest = 80) {
  return keepBass(data, volumeForRaw(data, target, cache), lowest);
}
function volumeForRaw(data, target, cache) {
  const L = pct => { if (!cache.has(pct)) cache.set(pct, loudness(data, pct)); return cache.get(pct); };
  let lo = MIN_NORMALIZE, hi = 300;
  if (L(hi) <= target) return hi;
  if (L(lo) >= target) return lo;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (L(mid) < target) lo = mid; else hi = mid; }
  return Math.abs(L(lo) - target) <= Math.abs(L(hi) - target) ? lo : hi;
}


function keepBass(data, v, lowest) {
  // The triangle (bass) has no volume, so cutting a loud track only quiets the other channels and
  // leaves the bass sticking out. Never cut the others below `lowest` %, however loud the bass makes the track.
  return v < lowest && loudness(data, 100, [false, false, true, false]) > 0.01 ? lowest : v;
}

// ------------------------------------------------------------------ background work

// The slow steps, run in Web Workers (this same file, loaded as a worker) so the page stays smooth.
function convertTrack(bytes, track, maxSec, previewFrames) {
  const nsf = loadFile(bytes).nsf;
  const song = runSong(nsf, track, maxSec);
  const psc = guessMelody(songStates(song).states);
  const c = compileSong(song);
  let frames = song.frames, loopStart = song.loopStart ?? null;
  if (c.data) { const t = tightenLoop(c.data); if (t !== c.data) { c.data = t; const i = ftPlay(t, Math.round(60.0988 * 900)); frames = i.frames; loopStart = i.loopStart; } }
  return { data: c.data, approximated: c.approximated, frames, loopStart,
           end: song.end, dpcmUsed: !!song.dpcmUsed, psc, endCmd: c.data ? ftPlay(c.data, previewFrames).endCmd : null };
}
// lead+drums loudness divided by bass loudness (null if there's no bass): well under about 0.25 means
// the lead and drums were turned down far too much (the bass can't be)
function leadToBass(data) {
  const bass = loudness(data, 100, [false, false, true, false]);
  return bass > 0.01 ? loudness(data, 100, [true, true, false, true]) / bass : null;
}
const WORKER_FNS = {
  convertTrack, smoothTrack, flickerShare, loudness, peakVolume, leadToBass,
  volumeFor: (data, target, entries, lowest) => { const cache = new Map(entries); const v = volumeFor(data, target, cache, lowest); return [v, [...cache]]; },
};
if (typeof WorkerGlobalScope !== "undefined" && typeof self !== "undefined" && self instanceof WorkerGlobalScope) {
  self.onmessage = e => {
    const { id, fn, args } = e.data;
    try { self.postMessage({ id, r: WORKER_FNS[fn](...args) }); }
    catch (err) { self.postMessage({ id, err: err.message || String(err) }); }
  };
}

// ------------------------------------------------------------------ 7z files
// Reads .7z archives: the container (including LZMA-compressed headers and solid blocks)
// with LZMA, LZMA2 or stored data. Each file is checked against its CRC32.
// The LZMA decoder follows Igor Pavlov's public-domain reference decoder (LzmaSpec).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

// LZMA decoder writing into out[] from out position `pos`. One instance per LZMA/LZMA2 stream;
// LZMA2 calls chunk() for each compressed chunk.
class Lzma {
  constructor(out) { this.out = out; this.pos = 0; }
  setProps(p) {
    if (p >= 9 * 5 * 5) throw new Error("bad LZMA properties");
    this.lc = p % 9; p = (p / 9) | 0; this.lp = p % 5; this.pb = (p / 5) | 0;
  }
  resetState() {
    const P = n => new Uint16Array(n).fill(1024);
    this.literal = P(0x300 << (this.lc + this.lp));
    this.isMatch = P(192); this.isRep = P(12); this.isRepG0 = P(12); this.isRepG1 = P(12); this.isRepG2 = P(12); this.isRep0Long = P(192);
    this.posSlot = P(256); this.posDecoders = P(115); this.align = P(16);
    const len = () => ({ choice: P(2), low: P(256), mid: P(256), high: P(256) });
    this.lenDec = len(); this.repLenDec = len();
    this.state = 0; this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
  }
  // range decoder over in[start .. end)
  initRange(input, start, end) {
    this.in = input; this.ip = start; this.end = end;
    if (input[this.ip++] !== 0) throw new Error("damaged LZMA data");
    this.code = 0; for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | input[this.ip++]) >>> 0;
    this.range = 0xFFFFFFFF;
  }
  bit(probs, i) {
    const p = probs[i], bound = (this.range >>> 11) * p >>> 0;
    let b;
    if (this.code < bound) { probs[i] = p + ((2048 - p) >>> 5); this.range = bound; b = 0; }
    else { probs[i] = p - (p >>> 5); this.code = (this.code - bound) >>> 0; this.range = (this.range - bound) >>> 0; b = 1; }
    if (this.range < 0x1000000) { this.range = (this.range << 8) >>> 0; this.code = ((this.code << 8) | this.in[this.ip++]) >>> 0; }
    return b;
  }
  direct(n) {
    let r = 0;
    while (n--) {
      this.range = this.range >>> 1;
      let b = 0;
      if (this.code >= this.range) { this.code = (this.code - this.range) >>> 0; b = 1; }
      r = ((r << 1) | b) >>> 0;
      if (this.range < 0x1000000) { this.range = (this.range << 8) >>> 0; this.code = ((this.code << 8) | this.in[this.ip++]) >>> 0; }
    }
    return r;
  }
  tree(probs, base, bits) { let m = 1; for (let i = 0; i < bits; i++) m = (m << 1) | this.bit(probs, base + m); return m - (1 << bits); }
  reverse(probs, base, bits) { let m = 1, r = 0; for (let i = 0; i < bits; i++) { const b = this.bit(probs, base + m); m = (m << 1) | b; r |= b << i; } return r; }
  len(d, posState) {
    if (!this.bit(d.choice, 0)) return this.tree(d.low, posState << 3, 3);
    if (!this.bit(d.choice, 1)) return 8 + this.tree(d.mid, posState << 3, 3);
    return 16 + this.tree(d.high, 0, 8);
  }
  // decode until `outEnd` bytes of output exist (or an end marker)
  decode(outEnd) {
    const out = this.out;
    const pbMask = (1 << this.pb) - 1, lpMask = (1 << this.lp) - 1;
    while (this.pos < outEnd) {
      const posState = this.pos & pbMask, st = this.state;
      if (!this.bit(this.isMatch, (st << 4) + posState)) {
        const prev = this.pos ? out[this.pos - 1] : 0;
        const base = 0x300 * (((this.pos & lpMask) << this.lc) + (prev >> (8 - this.lc)));
        let sym = 1;
        if (st >= 7) {
          let match = out[this.pos - this.rep0 - 1];
          do {
            const mb = (match >> 7) & 1; match <<= 1;
            const b = this.bit(this.literal, base + ((1 + mb) << 8) + sym);
            sym = (sym << 1) | b;
            if (mb !== b) break;
          } while (sym < 0x100);
        }
        while (sym < 0x100) sym = (sym << 1) | this.bit(this.literal, base + sym);
        out[this.pos++] = sym & 0xFF;
        this.state = st < 4 ? 0 : st < 10 ? st - 3 : st - 6;
        continue;
      }
      let len;
      if (this.bit(this.isRep, st)) {
        if (!this.pos) throw new Error("damaged LZMA data");
        if (!this.bit(this.isRepG0, st)) {
          if (!this.bit(this.isRep0Long, (st << 4) + posState)) {
            this.state = st < 7 ? 9 : 11;
            out[this.pos] = out[this.pos - this.rep0 - 1]; this.pos++;
            continue;
          }
        } else {
          let dist;
          if (!this.bit(this.isRepG1, st)) dist = this.rep1;
          else { if (!this.bit(this.isRepG2, st)) dist = this.rep2; else { dist = this.rep3; this.rep3 = this.rep2; } this.rep2 = this.rep1; }
          this.rep1 = this.rep0; this.rep0 = dist;
        }
        len = this.len(this.repLenDec, posState);
        this.state = st < 7 ? 8 : 11;
      } else {
        this.rep3 = this.rep2; this.rep2 = this.rep1; this.rep1 = this.rep0;
        len = this.len(this.lenDec, posState);
        this.state = st < 7 ? 7 : 10;
        const slot = this.tree(this.posSlot, Math.min(len, 3) << 6, 6);
        let dist;
        if (slot < 4) dist = slot;
        else {
          const n = (slot >>> 1) - 1;
          dist = ((2 | (slot & 1)) << n) >>> 0;
          if (slot < 14) dist = (dist + this.reverse(this.posDecoders, dist - slot, n)) >>> 0;
          else dist = (dist + ((this.direct(n - 4) << 4) >>> 0) + this.reverse(this.align, 0, 4)) >>> 0;
          if (dist === 0xFFFFFFFF) return;                        // end marker
        }
        this.rep0 = dist;
      }
      len += 2;
      if (this.rep0 >= this.pos) throw new Error("damaged LZMA data");
      for (let i = 0; i < len && this.pos < outEnd; i++) { out[this.pos] = out[this.pos - this.rep0 - 1]; this.pos++; }
    }
  }
}

function lzmaDecode(input, props, outSize) {
  const out = new Uint8Array(outSize), d = new Lzma(out);
  d.setProps(props[0]); d.resetState();
  d.initRange(input, 0, input.length);
  d.decode(outSize);
  return out;
}

function lzma2Decode(input, outSize) {
  const out = new Uint8Array(outSize), d = new Lzma(out);
  let ip = 0, needProps = true;
  for (;;) {
    const c = input[ip++];
    if (c === undefined) throw new Error("damaged LZMA2 data");
    if (c === 0) break;
    if (c < 0x80) {                                                  // stored chunk
      if (c > 2) throw new Error("damaged LZMA2 data");
      const n = ((input[ip] << 8) | input[ip + 1]) + 1; ip += 2;
      out.set(input.subarray(ip, ip + n), d.pos); d.pos += n; ip += n;
      continue;
    }
    const unpacked = (((c & 0x1F) << 16) | (input[ip] << 8) | input[ip + 1]) + 1;
    const packed = ((input[ip + 2] << 8) | input[ip + 3]) + 1; ip += 4;
    const mode = (c >> 5) & 3;
    if (mode >= 2) { d.setProps(input[ip++]); needProps = false; }
    else if (needProps) throw new Error("damaged LZMA2 data");
    if (mode >= 1) d.resetState();
    d.initRange(input, ip, ip + packed);
    d.decode(d.pos + unpacked);
    ip += packed;
  }
  return out.subarray(0, d.pos);
}

// The files inside a .7z as [{name, path, data}].
function read7z(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sig = [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C];
  if (!sig.every((b, i) => bytes[i] === b)) throw new Error("not a 7z file");
  const u64 = o => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 2 ** 32;
  const nextOffset = u64(12), nextSize = u64(20);
  if (32 + nextOffset + nextSize > bytes.length) throw new Error("the archive is incomplete or damaged (try downloading it again)");
  let header = bytes.subarray(32 + nextOffset, 32 + nextOffset + nextSize);

  // byte reader over a header buffer
  const R = buf => {
    let p = 0;
    const r = {
      byte: () => buf[p++],
      num: () => {
        const first = buf[p++]; let mask = 0x80, v = 0;
        for (let i = 0; i < 8; i++) {
          if (!(first & mask)) return v + (first & (mask - 1)) * 2 ** (8 * i);
          v += buf[p++] * 2 ** (8 * i); mask >>= 1;
        }
        return v;
      },
      bytes: n => { const b = buf.subarray(p, p + n); p += n; return b; },
      u32: () => { const v = (buf[p] | buf[p + 1] << 8 | buf[p + 2] << 16 | buf[p + 3] << 24) >>> 0; p += 4; return v; },
      bits: n => { const out = []; let b = 0, mask = 0; for (let i = 0; i < n; i++) { if (!mask) { b = buf[p++]; mask = 0x80; } out.push(!!(b & mask)); mask >>= 1; } return out; },
      skip: n => { p += n; },
    };
    r.digests = n => {
      const all = r.byte(), defined = all ? new Array(n).fill(true) : r.bits(n);
      return defined.map(d => d ? r.u32() : null);
    };
    return r;
  };

  const streamsInfo = r => {
    const info = { packPos: 0, packSizes: [], folders: [], subCounts: null, subSizes: null, subCrcs: null };
    for (;;) {
      const id = r.byte();
      if (id === 0x00) return info;
      if (id === 0x06) {                                             // PackInfo
        info.packPos = r.num();
        const n = r.num();
        for (let t = r.byte(); t !== 0; t = r.byte()) {
          if (t === 0x09) for (let i = 0; i < n; i++) info.packSizes.push(r.num());
          else if (t === 0x0A) r.digests(n);
          else throw new Error("unsupported 7z header");
        }
      } else if (id === 0x07) {                                      // UnpackInfo
        if (r.byte() !== 0x0B) throw new Error("unsupported 7z header");
        const nf = r.num();
        if (r.byte() !== 0) throw new Error("unsupported 7z header");
        for (let f = 0; f < nf; f++) {
          const coders = [], nc = r.num();
          let totalOut = 0;
          for (let c = 0; c < nc; c++) {
            const flag = r.byte(), id = Array.from(r.bytes(flag & 0x0F));
            let nIn = 1, nOut = 1;
            if (flag & 0x10) { nIn = r.num(); nOut = r.num(); }
            const props = flag & 0x20 ? r.bytes(r.num()) : new Uint8Array(0);
            coders.push({ id: id.map(x => x.toString(16).padStart(2, "0")).join(""), nIn, nOut, props });
            totalOut += nOut;
          }
          const totalIn = coders.reduce((a, c) => a + c.nIn, 0);
          for (let b = 0; b < totalOut - 1; b++) { r.num(); r.num(); }
          const packed = totalIn - (totalOut - 1);
          if (packed > 1) for (let i = 0; i < packed; i++) r.num();
          info.folders.push({ coders, unpackSizes: [], packed });
        }
        for (let t = r.byte(); t !== 0; t = r.byte()) {
          if (t === 0x0C) for (const f of info.folders) for (const c of f.coders) for (let o = 0; o < c.nOut; o++) f.unpackSizes.push(r.num());
          else if (t === 0x0A) r.digests(info.folders.length).forEach((c, i) => info.folders[i].crc = c);
          else throw new Error("unsupported 7z header");
        }
      } else if (id === 0x08) {                                      // SubStreamsInfo
        info.subCounts = info.folders.map(() => 1);
        let t = r.byte();
        if (t === 0x0D) { info.subCounts = info.folders.map(() => r.num()); t = r.byte(); }
        info.subSizes = [];
        info.folders.forEach((f, i) => {
          const total = f.unpackSizes[f.unpackSizes.length - 1];
          let sum = 0;
          for (let k = 0; k < info.subCounts[i] - 1 && t === 0x09; k++) { const s = r.num(); info.subSizes.push(s); sum += s; }
          if (info.subCounts[i]) info.subSizes.push(total - sum);
        });
        if (t === 0x09) t = r.byte();
        if (t === 0x0A) {
          const unknown = info.folders.reduce((a, f, i) => a + (info.subCounts[i] === 1 && f.crc != null ? 0 : info.subCounts[i]), 0);
          const crcs = r.digests(unknown);
          info.subCrcs = [];
          let k = 0;
          info.folders.forEach((f, i) => {
            if (info.subCounts[i] === 1 && f.crc != null) info.subCrcs.push(f.crc);
            else for (let j = 0; j < info.subCounts[i]; j++) info.subCrcs.push(crcs[k++]);
          });
          t = r.byte();
        }
        if (t !== 0) throw new Error("unsupported 7z header");
      } else throw new Error("unsupported 7z header");
    }
  };

  // the unpacked data of every folder, in order
  const unpackFolders = info => {
    let at = 32 + info.packPos, pi = 0;
    return info.folders.map(f => {
      if (f.coders.length !== 1 || f.packed !== 1) throw new Error("this 7z uses a filter that isn't supported (only LZMA, LZMA2 and stored)");
      const input = bytes.subarray(at, at + info.packSizes[pi]);
      at += info.packSizes[pi++];
      const c = f.coders[0], size = f.unpackSizes[0];
      let data;
      if (c.id === "21") data = lzma2Decode(input, size);
      else if (c.id === "030101") data = lzmaDecode(input, c.props, size);
      else if (c.id === "00") data = input.slice();
      else throw new Error(`7z compression ${c.id} isn't supported (only LZMA, LZMA2 and stored)`);
      if (data.length !== size) throw new Error("damaged 7z file");
      if (f.crc != null && crc32(data) !== f.crc) throw new Error("damaged 7z file (CRC mismatch)");
      return data;
    });
  };

  let r = R(header);
  let id = r.byte();
  while (id === 0x17) {                                              // encoded (compressed) header
    header = unpackFolders(streamsInfo(r))[0];
    r = R(header); id = r.byte();
  }
  if (id !== 0x01) throw new Error("unsupported 7z header");
  let main = null, names = [], empty = [];
  for (let t = r.byte(); t !== 0; t = r.byte()) {
    if (t === 0x02) { for (let p = r.byte(); p !== 0; p = r.byte()) r.skip(r.num()); }
    else if (t === 0x03) streamsInfo(r);
    else if (t === 0x04) main = streamsInfo(r);
    else if (t === 0x05) {
      const n = r.num();
      empty = new Array(n).fill(false);
      for (let p = r.num(); p !== 0; p = r.num()) {
        const size = r.num();
        if (p === 0x0E) { empty = r.bits(n); }
        else if (p === 0x11) {
          const b = r.bytes(size);
          if (b[0] !== 0) throw new Error("unsupported 7z header");
          let cur = "";
          for (let i = 1; i + 1 < b.length; i += 2) {
            const ch = b[i] | (b[i + 1] << 8);
            if (ch === 0) { names.push(cur); cur = ""; } else cur += String.fromCharCode(ch);
          }
        } else r.skip(size);
      }
    } else throw new Error("unsupported 7z header");
  }
  if (!main) return [];
  const folders = unpackFolders(main);
  const counts = main.subCounts || main.folders.map(() => 1);
  const sizes = main.subSizes || main.folders.map(f => f.unpackSizes[f.unpackSizes.length - 1]);
  const out = [];
  let fileIndex = 0, si = 0;
  folders.forEach((data, fi) => {
    let off = 0;
    for (let k = 0; k < counts[fi]; k++, si++) {
      while (fileIndex < names.length && empty[fileIndex]) fileIndex++;
      const piece = data.subarray(off, off + sizes[si]); off += sizes[si];
      const crc = main.subCrcs ? main.subCrcs[si] : null;
      if (crc != null && crc32(piece) !== crc) throw new Error("damaged 7z file (CRC mismatch)");
      const path = names[fileIndex++] || `file${si}`;
      out.push({ name: path.split(/[\\/]/).pop(), path, data: piece });
    }
  });
  return out;
}



if (typeof module !== "undefined") module.exports = { soundLoop,
  tightenLoop, smoothTrack, flickerShare, leadToBass, convertTrack, WORKER_FNS, MIN_NORMALIZE, peakVolume, setLoop, parseNsfe, parseM3u, loudness, volumeFor,  guessMelody, GAME_MODES, useLabel, exportTags, BOTH_NAMES, detectMode, fitsBanks, scaleVolume,  loadFile, parseNsf, runSong, compileSong, toBase64, fromBase64, toPlayerJson5, readZip, renderAudio, songStates, expand, parseJson5, ftPlay, SongCompiler };

