// Turns a track name into ASCII for the FCEUX font (which draws ASCII only).
// Accents are dropped, kana become romaji (dakuten and handakuten applied), other characters become "?".
const HIRA = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわゐゑをん";
const KATA = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヰヱヲン";
const ROMAJI = ["a", "i", "u", "e", "o", "ka", "ki", "ku", "ke", "ko", "sa", "shi", "su", "se", "so",
  "ta", "chi", "tsu", "te", "to", "na", "ni", "nu", "ne", "no", "ha", "hi", "fu", "he", "ho",
  "ma", "mi", "mu", "me", "mo", "ya", "yu", "yo", "ra", "ri", "ru", "re", "ro", "wa", "wi", "we", "wo", "n"];
const VOICED = { ka: "ga", ki: "gi", ku: "gu", ke: "ge", ko: "go", sa: "za", shi: "ji", su: "zu", se: "ze", so: "zo",
  ta: "da", chi: "ji", tsu: "zu", te: "de", to: "do", ha: "ba", hi: "bi", fu: "bu", he: "be", ho: "bo" };
const KANA = new Map([["ー", "-"], ["ゔ", "vu"], ["ヴ", "vu"]]);   // long vowel mark, vu
const hira = [...HIRA], kata = [...KATA];
ROMAJI.forEach((r, i) => { KANA.set(hira[i], r); KANA.set(kata[i], r); });

// base is one character, mark is "" or a combining dakuten (U+3099) or handakuten (U+309A) that followed it
function kanaRomaji(base, mark) {
  const r = KANA.get(base);
  if (!r) return base + mark;   // not kana: left for the "?" pass
  if (mark === "゙") return VOICED[r] || r;
  if (mark === "゚") return r.replace(/^h/, "p");
  return r;
}

function foldName(s) {
  return s.normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\s\S][゙゚]?/g, m => kanaRomaji(m[0], m.slice(1)))
    .replace(/[^\x20-\x7e]/g, "?");
}

module.exports = { foldName };
