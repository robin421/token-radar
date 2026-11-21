// Token Radar's entrypoint (Node 22, standard library only).
//
// Reads the sealed snapshot, builds the ranked board, and writes everything
// the gate and the judge read into the output directory:
//
//   board.json      the ranked board, every row with its farm plan
//   data.js         the dashboard's data, beside the page
//   dashboard/      a copy of the static page
//   screenshots/    a copy of the three screenshots
//   dossier.json    what buildDossier writes from dashboard/ and screenshots/
//
// Run it with: MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
// With no flags it reads /input/snapshot.json and writes to /output, as the
// grader does. Every byte it writes is a pure function of the snapshot, so
// two runs write the same bytes.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBoard, calibrate, livePeers } from "./lib/model.ts";
import type { Snapshot } from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

const MODEL_FORMULA = "implied = TVL x category multiple x growth x maturity x breadth";

function inputPath(argv: string[]): string {
  const flag = argv.indexOf("--input");
  if (flag !== -1 && flag + 1 < argv.length) return argv[flag + 1];
  return "/input/snapshot.json";
}

function outputDir(): string {
  const fromEnv = process.env.MAKEFUN_OUTPUT_DIR;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return "/output";
}

function copyTree(source: string, target: string): void {
  if (!existsSync(source)) return;
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true });
}

function main(): void {
  const repoRoot = dirname(fileURLToPath(import.meta.url));
  const outDir = outputDir();
  const snapshot = JSON.parse(readFileSync(inputPath(process.argv), "utf8")) as Snapshot;
  const calibration = calibrate(snapshot);
  const rows = buildBoard(snapshot);
  const live = livePeers(snapshot);
  // The calibration table shows only the categories the board actually uses,
  // so every row of it traces to a multiple on the board.
  const usedCategories = new Set(rows.map((row) => row.category));
  const calibrationRows = calibration.rows.filter((entry) => usedCategories.has(entry.category));
  // Categories with no live peer at all still get a row, so the table covers
  // every multiple the board uses: those rows use the global median.
  const shown = new Set(calibrationRows.map((entry) => entry.category));
  for (const category of usedCategories) {
    if (category !== null && !shown.has(category)) {
      calibrationRows.push({ category, peers: 0, peerMedian: null, multiple: calibration.globalMedian });
    }
  }
  calibrationRows.sort((a, b) => (a.category < b.category ? -1 : 1));
  const watchlistRows = rows.filter((row) => row.watchlist).length;

  const meta = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    model: MODEL_FORMULA,
    global_median_mcap_tvl: calibration.globalMedian,
    calibration_peers: calibration.peerCount,
    rows: rows.length,
    watchlist_rows: watchlistRows,
    early_rows: rows.length - watchlistRows,
    note: "A protocol records no token when the snapshot carries neither a CoinGecko id nor a ticker for it; that is the snapshot's record, not proof it has none.",
  };

  mkdirSync(outDir, { recursive: true });

  const board = { meta, rows };
  writeFileSync(join(outDir, "board.json"), `${JSON.stringify(board, null, 2)}\n`, "utf8");

  const pageData = {
    meta,
    rows,
    live,
    calibration: calibrationRows,
  };
  writeFileSync(join(outDir, "data.js"), `window.RADAR = ${JSON.stringify(pageData)};\n`, "utf8");

  copyTree(join(repoRoot, "dashboard"), join(outDir, "dashboard"));
  copyTree(join(repoRoot, "screenshots"), join(outDir, "screenshots"));

  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, "dossier.json"), dossier);

  console.log(`token-radar: ${rows.length} rows (${watchlistRows} watchlist, ${rows.length - watchlistRows} early) -> ${outDir}`);
}

main();
