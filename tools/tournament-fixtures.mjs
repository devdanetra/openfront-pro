// Shared by tools/test-tournament.mjs and tools/shot-tournament.mjs: loads the
// record normaliser (from background.js) and src/tournament-core.js into a vm
// sandbox, reads the saved real records in .recap/, and builds the made-up
// demo tournaments the screenshots use.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, ".recap");

export function loadCore() {
  const bg = fs.readFileSync(path.join(ROOT, "src/background.js"), "utf8");
  const block = bg.slice(bg.indexOf("// <record-normaliser>"), bg.indexOf("// </record-normaliser>"));
  const sandbox = {
    console,
    crypto: globalThis.crypto,
    btoa,
    atob,
    Blob,
    TextEncoder,
    TextDecoder,
    CompressionStream,
    DecompressionStream,
    URL,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(block.replace(/async function fetchGameRecord[\s\S]*?\n}\n/, "") + "\nthis.normaliseRecord = normaliseRecord;", sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/tournament-core.js"), "utf8"), sandbox);
  return { normaliseRecord: sandbox.normaliseRecord, T: sandbox.OFR_TOURNEY, sandbox };
}

// Same sample set as tools/test-recap.mjs (it downloads them once into .recap/).
export const SAMPLE_IDS = ["5S99ULQP", "yfMnoHJP", "HPeHLRqX", "ddNXyXafFo", "d4tvvVquk6", "dc5VgbARGx", "dVLrYJEaGm", "dfReijmudi"];

export function loadRecords(normaliseRecord, T) {
  const raw = new Map();
  const slim = new Map();
  for (const id of SAMPLE_IDS) {
    const file = path.join(DIR, `game-${id}.json`);
    if (!fs.existsSync(file)) continue;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const norm = normaliseRecord(data, id);
    raw.set(id, norm);
    slim.set(id, T.slimRecord(JSON.parse(JSON.stringify(norm))));
  }
  return { raw, slim };
}

// Made-up tournaments over the real records. Participants are real names/tags
// from those public games; the tournaments themselves never happened.
export function demoTournaments(T) {
  const P = (id, name, tags = [], members = [], color = 0) => ({ id, name, tags, members, color });
  const base = (id, name, extra) => ({
    id,
    name,
    format: "league",
    unit: "player",
    bestOf: 3,
    scoring: { preset: "ffa", win: 0, place: [10, 7, 5, 4, 3, 2, 1], conquest: 1 },
    participants: [],
    games: [],
    overrides: [],
    created: 1758240000000,
    updated: 1758240000000,
    ...extra,
  });
  const league = base("demoleague1", "Weekend FFA League", {
    participants: [
      P("pa", "TeNa", [], [], 0),
      P("pb", "PeesALittle", [], [], 1),
      P("pc", "potato", [], [], 2),
      P("pd", "NoAlliances", [], [], 3),
      P("pe", "snugglepuppy", [], [], 4),
      P("pf", "bunnykisses67", [], [], 5),
      P("pg", "AnonTruffle7", [], [], 0),
      P("ph", "tryingtoohard67", [], [], 1),
      P("pi", "mommyslilpeanut", [], [], 2),
    ],
    games: ["5S99ULQP", "yfMnoHJP", "ddNXyXafFo", "dfReijmudi", "d4tvvVquk6"].map((id) => ({ id, assign: {} })),
  });
  const clans = base("democlans01", "Clan Cup · Season 3", {
    unit: "team",
    scoring: { preset: "custom", win: 5, place: [8, 5, 3, 2, 1], conquest: 0.5 },
    participants: [
      P("pun", "UN", ["UN"], [], 1),
      P("pfr", "FR", ["FR"], [], 4),
      P("pit", "ITA", ["ITA"], [], 2),
      P("pmo", "MOL", ["MOL"], [], 3),
      P("ppl", "PL", ["PL"], [], 0),
      P("pir", "IR", ["IR"], [], 5),
    ],
    games: ["5S99ULQP", "ddNXyXafFo", "dfReijmudi", "yfMnoHJP", "d4tvvVquk6"].map((id) => ({ id, assign: {} })),
  });
  const cup = base("demobracket", "Friday Night Cup", {
    format: "bracket",
    bestOf: 1,
    participants: [
      P("p1", "TeNa", [], [], 0),
      P("p2", "hyLine", ["HD"], [], 1),
      P("p3", "snugglepuppy", [], [], 2),
      P("p4", "potato", [], [], 3),
      P("p5", "NoAlliances", [], [], 4),
      P("p6", "bunnykisses67", [], [], 5),
      P("p7", "Batman", ["LBU"], [], 0),
      P("p8", "calabo", ["ALED"], [], 1),
    ],
    games: ["HPeHLRqX", "dVLrYJEaGm", "ddNXyXafFo", "dfReijmudi", "yfMnoHJP"].map((id) => ({ id, assign: {} })),
    // TeNa and potato never met in a recorded game: the organiser set it by hand
    overrides: [{ a: "p1", b: "p4", winner: "p1" }],
  });
  const bo3 = base("demoseries1", "UN vs ITA · Best of 3", {
    format: "series",
    unit: "team",
    bestOf: 3,
    scoring: { preset: "wins", win: 1, place: [], conquest: 0 },
    participants: [P("pun", "UN", ["UN"], [], 1), P("pit", "ITA", ["ITA"], [], 2)],
    games: ["ddNXyXafFo", "dfReijmudi", "yfMnoHJP"].map((id) => ({ id, assign: {} })),
  });
  return { league, clans, cup, bo3 };
}
