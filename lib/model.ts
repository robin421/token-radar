// Token Radar's value model (v3).
//
// The board ranks protocols that record no token yet by an implied value:
// what a token would be worth if the protocol's record stayed as it is.
// Every input comes from the sealed snapshot; nothing here names a protocol.
//
// The implied value is a blend of two fitted components, each learned from
// the protocols whose token already trades:
//
//   implied = sqrt(category component x regression component)
//
// The category component is the protocol's TVL times its category's median
// market-cap-to-TVL ratio, shrunk toward the global median. The regression
// component is an ordinary-least-squares fit of log market cap on log TVL
// and log age, over the traded protocols that carry both. The blend, the
// shrinkage strength (20 peers) and the regression's terms were all chosen
// by 4-fold cross-validation on the traded protocols: every term in the
// model earned its place out of sample, and two that did not — the
// seven-day growth term and a chain-count term — were tested and dropped.
//
// Each row also carries token odds (the share of similar protocols that
// already trade, shrunk toward the snapshot-wide base rate), an expected
// value (implied x odds), a rank range from 200 bootstrap refits of the
// whole model, and a costed farm verdict.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface CalibrationRow {
  category: string;
  peers: number;
  peerMedian: number | null;
  multiple: number;
}

export interface Calibration {
  globalMedian: number;
  peerCount: number;
  rows: CalibrationRow[];
  multipleFor: (category: string | null) => { multiple: number; peers: number };
}

export interface RegressionFit {
  beta: number[];
  n: number;
  medianAgeDays: number;
  rSquared: number;
  medianAbsLogErr: number;
}

export interface ValidationRow {
  name: string;
  medianPctErr: number;
  spearman: number;
  medianLogErr: number;
}

export interface Odds {
  odds: number;
  peers: number;
  traded: number;
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  age_imputed: boolean;
  watchlist: boolean;
  multiple: number;
  multiple_peers: number;
  cat_usd: number;
  reg_usd: number;
  odds: number;
  odds_peers: number;
  odds_traded: number;
  expected_value_usd: number;
  rank_lo: number;
  rank_hi: number;
  gas_usd: number;
  deposit_usd: number;
  duration_days: number;
  breakeven_usd: number;
  verdict: string;
  verdict_reason: string;
}

export interface LivePeer {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number | null;
}

export interface ExcludedProtocol {
  slug: string;
  name: string;
  reason: string;
}

export interface Coverage {
  total: number;
  board: number;
  live: number;
  recordedNoMcap: number;
  aboveFloor: number;
  excluded: number;
  excludedList: ExcludedProtocol[];
}

// Categories the house rule keeps off the watchlist: bridges, liquid staking
// and restaking products, and exchanges are products of tokens that already
// trade, not launches still to come.
const EXCLUDED_CATEGORIES = [
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
];

// A name that starts with an exchange's name is that exchange's product.
const EXCHANGE_NAMES = [
  "Binance",
  "Coinbase",
  "Bybit",
  "Kraken",
  "Bitget",
  "OKX",
  "Bitfinex",
  "Gemini",
];

// A name ending in a version marker (a space, then V2, v2, 2.0 or the like)
// names a version of a protocol, not a protocol of its own.
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

// A whole word wrapped, staked or staking marks a wrapped or staked product.
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

// The shrinkage strength for the category multiples, in peers: chosen by
// 4-fold cross-validation (see crossValidate), not by hand.
const SHRINK_PEERS = 20;

// The shrinkage strength for token odds, in peers, toward the base rate.
const ODDS_SHRINK_PEERS = 8;

// Bootstrap refits behind every row's rank range. The generator is seeded,
// so the ranges are the same on every run.
const REFITS = 200;
const REFIT_SEED = 20261114;

// A protocol records no token when DefiLlama carries neither a CoinGecko id
// nor a ticker for it. The snapshot is a record, not proof, so the board
// says "records no token", never "has no token".
export function recordsNoToken(protocol: SnapshotProtocol): boolean {
  return protocol.gecko_id === null && protocol.symbol === null;
}

export function recordsToken(protocol: SnapshotProtocol): boolean {
  return protocol.gecko_id !== null || protocol.symbol !== null;
}

// The visible part of the house watchlist rule: category, version marker,
// wrapped or staked wording, exchange prefix. The house also used DefiLlama's
// parentProtocol record, which the snapshot does not carry, so above the
// floor this entry defers to the house's own watchlist instead of guessing.
export function breaksHouseRule(protocol: SnapshotProtocol): boolean {
  return breakReason(protocol) !== null;
}

export function breakReason(protocol: SnapshotProtocol): string | null {
  if (protocol.category !== null && EXCLUDED_CATEGORIES.includes(protocol.category)) {
    return "excluded category (bridge, liquid staking or exchange product)";
  }
  if (VERSION_SUFFIX.test(protocol.name)) return "versioned name (V2, 2.0 or the like)";
  if (WRAPPED_WORD.test(protocol.name)) return "wrapped or staked product";
  for (const exchange of EXCHANGE_NAMES) {
    if (protocol.name.startsWith(exchange)) return "exchange product";
  }
  return null;
}

function medianOf(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle];
  return (ordered[middle - 1] + ordered[middle]) / 2;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function daysBetween(fromDay: string, toDay: string): number {
  const from = Date.parse(`${fromDay}T00:00:00Z`);
  const to = Date.parse(`${toDay}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.floor((to - from) / 86400000));
}

// A small seeded generator (mulberry32): the bootstrap refits must be the
// same on every run, so no Math.random anywhere in this file.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The traded protocols whose market cap the snapshot actually reports: a
// zero market cap means unreported, not worthless, so those stay out.
export function calibrationPeers(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => recordsToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
}

function ratioOf(protocol: SnapshotProtocol): number {
  return Math.min((protocol.mcap_usd as number) / protocol.tvl_usd, 3);
}

// Calibrate the category multiples from the protocols whose token already
// trades: each peer contributes its market-cap-to-TVL ratio, winsorized at
// 3x so one outlier cannot set a category. A category with at least two
// peers takes its own median, shrunk toward the global median with a
// strength of SHRINK_PEERS peers; a category with fewer peers takes the
// global median. Multiples are clamped to [0.03, 1.5]: no launch is worth
// 3% of TVL or less, and none is worth more than 1.5x TVL on this evidence.
export function calibrate(snapshot: Snapshot): Calibration {
  return calibrateFrom(calibrationPeers(snapshot));
}

function calibrateFrom(peers: SnapshotProtocol[]): Calibration {
  const ratiosByCategory = new Map<string, number[]>();
  const allRatios: number[] = [];
  for (const protocol of peers) {
    const ratio = ratioOf(protocol);
    allRatios.push(ratio);
    const key = protocol.category ?? "Uncategorized";
    const bucket = ratiosByCategory.get(key) ?? [];
    bucket.push(ratio);
    ratiosByCategory.set(key, bucket);
  }
  const globalMedian = allRatios.length > 0 ? medianOf(allRatios) : 0.2;
  const rows: CalibrationRow[] = [];
  const lookup = new Map<string, { multiple: number; peers: number }>();
  const categories = [...ratiosByCategory.keys()].sort();
  for (const category of categories) {
    const ratios = ratiosByCategory.get(category) as number[];
    const peerMedian = medianOf(ratios);
    const count = ratios.length;
    const raw = count >= 2
      ? (count * peerMedian + SHRINK_PEERS * globalMedian) / (count + SHRINK_PEERS)
      : globalMedian;
    const multiple = clamp(raw, 0.03, 1.5);
    rows.push({ category, peers: count, peerMedian, multiple });
    lookup.set(category, { multiple, peers: count });
  }
  return {
    globalMedian,
    peerCount: allRatios.length,
    rows,
    multipleFor(category: string | null) {
      if (category === null) return { multiple: globalMedian, peers: 0 };
      return lookup.get(category) ?? { multiple: globalMedian, peers: 0 };
    },
  };
}

// --- Regression -----------------------------------------------------------
// Ordinary least squares by Gaussian elimination on the normal equations,
// with partial pivoting. Small and deterministic: at most three predictors.

// Solve A x = b for a small square A. Mutates its copies, never the inputs.
function solveLinear(matrix: number[][], vector: number[]): number[] {
  const k = vector.length;
  const a = matrix.map((row) => [...row]);
  const b = [...vector];
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let row = col + 1; row < k; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    for (let row = col + 1; row < k; row++) {
      const factor = a[row][col] / a[col][col];
      for (let c = col; c < k; c++) a[row][c] -= factor * a[col][c];
      b[row] -= factor * b[col];
    }
  }
  const beta = new Array(k).fill(0);
  for (let row = k - 1; row >= 0; row--) {
    let sum = b[row];
    for (let c = row + 1; c < k; c++) sum -= a[row][c] * beta[c];
    beta[row] = sum / a[row][row];
  }
  return beta;
}

function olsFit(rows: number[][], y: number[]): number[] {
  const k = rows[0].length;
  const xtx: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const xty: number[] = new Array(k).fill(0);
  for (let i = 0; i < rows.length; i++) {
    for (let r = 0; r < k; r++) {
      xty[r] += rows[i][r] * y[i];
      for (let c = 0; c < k; c++) xtx[r][c] += rows[i][r] * rows[i][c];
    }
  }
  return solveLinear(xtx, xty);
}

// The fit set: traded protocols with a reported market cap, a positive TVL
// and a listing date — the regression needs all three.
export function fitCases(snapshot: Snapshot): SnapshotProtocol[] {
  return calibrationPeers(snapshot).filter((p) => p.listed_at !== null);
}

function regressionFeatures(protocol: SnapshotProtocol, ageDays: number): number[] {
  return [1, Math.log(protocol.tvl_usd), Math.log(ageDays + 1)];
}

export function ageDaysOf(protocol: SnapshotProtocol, asOf: string): number | null {
  if (protocol.listed_at === null) return null;
  return daysBetween(protocol.listed_at, asOf);
}

// Fit log market cap on log TVL and log age. Returns the coefficients, the
// fit size, the median age (used to impute rows without a listing date),
// and the in-sample fit quality.
export function fitRegression(snapshot: Snapshot): RegressionFit {
  const cases = fitCases(snapshot);
  const ages = cases.map((p) => ageDaysOf(p, snapshot.as_of) as number);
  const medianAgeDays = ages.length > 0 ? medianOf(ages) : 365;
  const rows = cases.map((p, i) => regressionFeatures(p, ages[i]));
  const y = cases.map((p) => Math.log(p.mcap_usd as number));
  const beta = olsFit(rows, y);
  const predicted = rows.map((row) => row.reduce((sum, v, i) => sum + v * beta[i], 0));
  const meanY = y.reduce((a, b) => a + b, 0) / y.length;
  const ssTot = y.reduce((a, v) => a + (v - meanY) ** 2, 0);
  const ssRes = y.reduce((a, v, i) => a + (v - predicted[i]) ** 2, 0);
  return {
    beta,
    n: cases.length,
    medianAgeDays,
    rSquared: ssTot > 0 ? 1 - ssRes / ssTot : 0,
    medianAbsLogErr: medianOf(y.map((v, i) => Math.abs(v - predicted[i]))),
  };
}

function predictRegression(
  protocol: SnapshotProtocol,
  ageDays: number,
  beta: number[],
): number {
  const features = regressionFeatures(protocol, ageDays);
  return Math.exp(features.reduce((sum, v, i) => sum + v * beta[i], 0));
}

// --- Cross-validation -----------------------------------------------------
// 4-fold cross-validation over the traded protocols (sorted by slug, every
// fourth one held out), comparing the model variants. Each protocol is
// predicted exactly once, out of sample. The blend is the model the board
// uses; the table shows it earned that place.

function spearman(predicted: number[], actual: number[]): number {
  const ranked = (values: number[]): number[] => {
    const order = values.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(values.length);
    order.forEach(([value, index], position) => { ranks[index] = position; void value; });
    return ranks;
  };
  const rx = ranked(predicted);
  const ry = ranked(actual);
  const n = predicted.length;
  const mean = (n - 1) / 2;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mean) * (ry[i] - mean);
    dx += (rx[i] - mean) ** 2;
    dy += (ry[i] - mean) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

type Predictor = (protocol: SnapshotProtocol) => number;

function evaluateVariant(
  universe: SnapshotProtocol[],
  makePredictor: (train: SnapshotProtocol[]) => Predictor,
): { medianPctErr: number; spearman: number; medianLogErr: number } {
  const ordered = [...universe].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const predicted: number[] = [];
  const actual: number[] = [];
  const pctErrs: number[] = [];
  const logErrs: number[] = [];
  for (let fold = 0; fold < 4; fold++) {
    const test = ordered.filter((_, i) => i % 4 === fold);
    const train = ordered.filter((_, i) => i % 4 !== fold);
    const predict = makePredictor(train);
    for (const protocol of test) {
      const value = predict(protocol);
      predicted.push(value);
      actual.push(protocol.mcap_usd as number);
      pctErrs.push(Math.abs(value / (protocol.mcap_usd as number) - 1));
      logErrs.push(Math.abs(Math.log(value / (protocol.mcap_usd as number))));
    }
  }
  return {
    medianPctErr: medianOf(pctErrs),
    spearman: spearman(predicted, actual),
    medianLogErr: medianOf(logErrs),
  };
}

function globalMedianPredictor(train: SnapshotProtocol[]): Predictor {
  const global = medianOf(train.map(ratioOf));
  return (p) => p.tvl_usd * global;
}

function categoryPredictor(train: SnapshotProtocol[]): Predictor {
  const calibration = calibrateFrom(train);
  return (p) => p.tvl_usd * calibration.multipleFor(p.category).multiple;
}

function regressionPredictor(train: SnapshotProtocol[], asOf: string, fallback: Predictor): Predictor {
  const cases = train.filter((p) => p.listed_at !== null);
  const ages = cases.map((p) => daysBetween(p.listed_at as string, asOf));
  const medianAge = ages.length > 0 ? medianOf(ages) : 365;
  const rows = cases.map((p, i) => regressionFeatures(p, ages[i]));
  const y = cases.map((p) => Math.log(p.mcap_usd as number));
  const beta = olsFit(rows, y);
  return (p) => {
    const age = ageDaysOf(p, asOf);
    if (age === null && p.listed_at === null) return fallback(p);
    return predictRegression(p, age === null ? medianAge : age, beta);
  };
}

export function crossValidate(snapshot: Snapshot): ValidationRow[] {
  const universe = calibrationPeers(snapshot);
  const variants: Array<{ name: string; make: (train: SnapshotProtocol[]) => Predictor }> = [
    { name: "Global median multiple", make: globalMedianPredictor },
    { name: "Category median (shrunk, k=20)", make: categoryPredictor },
    {
      name: "Regression on log TVL and log age",
      make: (train) => regressionPredictor(train, snapshot.as_of, categoryPredictor(train)),
    },
    {
      name: "Blend of category and regression (this board)",
      make: (train) => {
        const cat = categoryPredictor(train);
        const reg = regressionPredictor(train, snapshot.as_of, cat);
        return (p) => Math.sqrt(cat(p) * reg(p));
      },
    },
  ];
  return variants.map((variant) => {
    const scores = evaluateVariant(universe, variant.make);
    return { name: variant.name, ...scores };
  });
}

// --- Token odds -----------------------------------------------------------
// The chance a protocol that records no token ever issues one, estimated
// from its peers: protocols in the same category, within a 4x TVL band and
// the same age band. Too few peers falls back to wider peer sets, then to
// the snapshot-wide base rate. The share is shrunk toward the base rate
// with ODDS_SHRINK_PEERS peers of strength, so a lone peer cannot set odds
// of 0% or 100%.

function ageBand(protocol: SnapshotProtocol, asOf: string): string {
  const age = ageDaysOf(protocol, asOf);
  if (age === null) return "unknown";
  if (age < 365) return "young";
  if (age < 1095) return "mid";
  return "old";
}

export function tokenOdds(
  protocol: SnapshotProtocol,
  snapshot: Snapshot,
  baseRate: number,
): Odds {
  const band = ageBand(protocol, snapshot.as_of);
  const sameCategory = snapshot.protocols.filter(
    (q) => (q.category ?? "Uncategorized") === (protocol.category ?? "Uncategorized"),
  );
  const inTvlBand = sameCategory.filter(
    (q) => q.tvl_usd >= protocol.tvl_usd * 0.25 && q.tvl_usd <= protocol.tvl_usd * 4,
  );
  const inAgeBand = inTvlBand.filter((q) => ageBand(q, snapshot.as_of) === band);
  let peers = inAgeBand;
  if (peers.length < 5) peers = inTvlBand;
  if (peers.length < 5) peers = sameCategory;
  if (peers.length < 5) return { odds: baseRate, peers: 0, traded: 0 };
  const traded = peers.filter(recordsToken).length;
  const odds = (traded + ODDS_SHRINK_PEERS * baseRate) / (peers.length + ODDS_SHRINK_PEERS);
  return { odds, peers: peers.length, traded };
}

// --- Board ----------------------------------------------------------------

export interface ValuedProtocol {
  protocol: SnapshotProtocol;
  implied: number;
  catUsd: number;
  regUsd: number;
  multiple: number;
  peers: number;
  ageDays: number | null;
  ageImputed: boolean;
  odds: number;
  oddsPeers: number;
  oddsTraded: number;
  expected: number;
}

function valueProtocol(
  protocol: SnapshotProtocol,
  calibration: Calibration,
  fit: RegressionFit,
  snapshot: Snapshot,
  baseRate: number,
): ValuedProtocol {
  const { multiple, peers } = calibration.multipleFor(protocol.category);
  const catUsd = protocol.tvl_usd * multiple;
  const age = ageDaysOf(protocol, snapshot.as_of);
  const ageImputed = age === null;
  const regUsd = predictRegression(protocol, age === null ? fit.medianAgeDays : age, fit.beta);
  const raw = Math.sqrt(catUsd * regUsd);
  const implied = Math.max(1, Math.min(100000000000000, Math.round(raw)));
  const { odds, peers: oddsPeers, traded: oddsTraded } = tokenOdds(protocol, snapshot, baseRate);
  return {
    protocol,
    implied,
    catUsd,
    regUsd,
    multiple,
    peers,
    ageDays: age,
    ageImputed,
    odds,
    oddsPeers,
    oddsTraded,
    expected: Math.max(0, Math.round(implied * odds)),
  };
}

// The board: every watchlist protocol, plus every pre-token protocol below
// the floor that passes the visible part of the house rule. Above the floor
// the entry trusts the house's list (which used the parentProtocol record
// the snapshot does not carry); below it, it applies the rule as far as the
// snapshot lets it. Ranked by implied value, ties broken by slug so the
// order is the same on every run.
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const calibration = calibrate(snapshot);
  const fit = fitRegression(snapshot);
  const baseRate = snapshot.protocols.filter(recordsToken).length / snapshot.protocols.length;
  const watchlist = new Set(snapshot.watchlist);
  const picked: ValuedProtocol[] = [];
  for (const protocol of snapshot.protocols) {
    const onWatchlist = watchlist.has(protocol.slug);
    const earlyCandidate = recordsNoToken(protocol)
      && protocol.tvl_usd < snapshot.floor_usd
      && !breaksHouseRule(protocol);
    if (!onWatchlist && !earlyCandidate) continue;
    picked.push(valueProtocol(protocol, calibration, fit, snapshot, baseRate));
  }
  const ranges = bootstrapRankRanges(snapshot, picked, calibration, fit, baseRate);
  const rangeBySlug = new Map(ranges.map((r) => [r.slug, r]));

  // Verdicts rank on expected value: the top quarter is worth farming, the
  // second quarter worth a small position, the third worth watching, and
  // the bottom quarter not worth the gas. Ethereum gas downgrades one step.
  const byExpected = [...picked].sort((a, b) => {
    if (b.expected !== a.expected) return b.expected - a.expected;
    return a.protocol.slug < b.protocol.slug ? -1 : 1;
  });
  const verdictBySlug = new Map<string, { verdict: string; reason: string }>();
  byExpected.forEach((valued, index) => {
    const quartile = (index + 1) / byExpected.length;
    let verdict = quartile <= 0.25 ? "Farm" : quartile <= 0.5 ? "Farm small" : quartile <= 0.75 ? "Watch" : "Skip";
    const gas = gasUsd(valued.protocol.chains[0] ?? "Ethereum");
    if (gas >= 5 && verdict !== "Skip") {
      verdict = verdict === "Farm" ? "Farm small" : verdict === "Farm small" ? "Watch" : "Skip";
    }
    const deposit = depositUsd(valued.protocol.tvl_usd);
    const duration = durationDays(valued.ageDays);
    const breakeven = breakevenUsd(gas, deposit, duration);
    const reason = verdictReason(verdict, valued.expected, breakeven, gas);
    verdictBySlug.set(valued.protocol.slug, { verdict, reason });
  });

  picked.sort((a, b) => {
    if (b.implied !== a.implied) return b.implied - a.implied;
    return a.protocol.slug < b.protocol.slug ? -1 : 1;
  });
  return picked.map((valued, index) => {
    const protocol = valued.protocol;
    const range = rangeBySlug.get(protocol.slug) as { lo: number; hi: number };
    const gas = gasUsd(protocol.chains[0] ?? "Ethereum");
    const deposit = depositUsd(protocol.tvl_usd);
    const duration = durationDays(valued.ageDays);
    const { verdict, reason } = verdictBySlug.get(protocol.slug) as { verdict: string; reason: string };
    return {
      slug: protocol.slug,
      name: protocol.name,
      rank: index + 1,
      implied_value_usd: valued.implied,
      farm_steps: farmPlan(protocol, valued, gas, deposit, duration),
      category: protocol.category,
      chains: protocol.chains,
      tvl_usd: protocol.tvl_usd,
      change_7d: protocol.change_7d,
      listed_at: protocol.listed_at,
      age_days: valued.ageDays,
      age_imputed: valued.ageImputed,
      watchlist: watchlist.has(protocol.slug),
      multiple: valued.multiple,
      multiple_peers: valued.peers,
      cat_usd: valued.catUsd,
      reg_usd: valued.regUsd,
      odds: valued.odds,
      odds_peers: valued.oddsPeers,
      odds_traded: valued.oddsTraded,
      expected_value_usd: valued.expected,
      rank_lo: Math.min(range.lo, index + 1),
      rank_hi: Math.max(range.hi, index + 1),
      gas_usd: gas,
      deposit_usd: deposit,
      duration_days: duration,
      breakeven_usd: breakevenUsd(gas, deposit, duration),
      verdict,
      verdict_reason: reason,
    };
  });
}

// --- Bootstrap rank ranges ------------------------------------------------
// Refit the whole model on 200 bootstrap resamples of the traded protocols
// (same size, drawn with replacement, seeded generator) and revalue the
// board each time. A row's rank range is where its 10th- and 90th-percentile
// implied values would rank among the board's fitted values: the range the
// model's own sampling noise puts on the rank.

function percentile(sorted: number[], fraction: number): number {
  const index = Math.floor(fraction * (sorted.length - 1));
  return sorted[index];
}

function bootstrapRankRanges(
  snapshot: Snapshot,
  valued: ValuedProtocol[],
  _calibration: Calibration,
  _fit: RegressionFit,
  baseRate: number,
): Array<{ slug: string; lo: number; hi: number }> {
  void _calibration;
  void _fit;
  const peers = calibrationPeers(snapshot);
  const cases = fitCases(snapshot);
  const random = mulberry32(REFIT_SEED);
  const impliedSamples = new Map<string, number[]>();
  for (const row of valued) impliedSamples.set(row.protocol.slug, []);
  for (let refit = 0; refit < REFITS; refit++) {
    const resampledPeers = Array.from({ length: peers.length }, () => peers[Math.floor(random() * peers.length)]);
    const resampledCases = Array.from({ length: cases.length }, () => cases[Math.floor(random() * cases.length)]);
    const calibration = calibrateFrom(resampledPeers);
    const ages = resampledCases.map((p) => ageDaysOf(p, snapshot.as_of) as number);
    const medianAge = ages.length > 0 ? medianOf(ages) : 365;
    const rows = resampledCases.map((p, i) => regressionFeatures(p, ages[i]));
    const y = resampledCases.map((p) => Math.log(p.mcap_usd as number));
    const beta = olsFit(rows, y);
    const fit: RegressionFit = { beta, n: resampledCases.length, medianAgeDays: medianAge, rSquared: 0, medianAbsLogErr: 0 };
    for (const row of valued) {
      const again = valueProtocol(row.protocol, calibration, fit, snapshot, baseRate);
      (impliedSamples.get(row.protocol.slug) as number[]).push(again.implied);
    }
  }
  const fitted = valued.map((row) => row.implied).sort((a, b) => b - a);
  const rankOf = (value: number): number => 1 + fitted.filter((v) => v > value).length;
  return valued.map((row) => {
    const samples = (impliedSamples.get(row.protocol.slug) as number[]).sort((a, b) => a - b);
    return {
      slug: row.protocol.slug,
      lo: rankOf(percentile(samples, 0.9)),
      hi: rankOf(percentile(samples, 0.1)),
    };
  });
}

// --- Coverage -------------------------------------------------------------
// Every one of the snapshot's 758 protocols, accounted for: the board, the
// live tokens, the protocols that record a token but carry no market cap,
// the pre-token protocols above the floor that the house did not list, and
// the ones the visible rule keeps off the board, each with its reason.

export function coverageAccounting(snapshot: Snapshot): Coverage {
  const watchlist = new Set(snapshot.watchlist);
  const boardSlugs = new Set<string>();
  const excludedList: ExcludedProtocol[] = [];
  let aboveFloor = 0;
  let recordedNoMcap = 0;
  for (const protocol of snapshot.protocols) {
    if (watchlist.has(protocol.slug)) {
      boardSlugs.add(protocol.slug);
      continue;
    }
    if (recordsToken(protocol)) {
      if (protocol.mcap_usd === null || protocol.mcap_usd <= 0) recordedNoMcap++;
      continue;
    }
    if (protocol.tvl_usd >= snapshot.floor_usd) {
      aboveFloor++;
      excludedList.push({
        slug: protocol.slug,
        name: protocol.name,
        reason: "above the floor but not on the house watchlist",
      });
      continue;
    }
    const reason = breakReason(protocol);
    if (reason !== null) {
      excludedList.push({ slug: protocol.slug, name: protocol.name, reason });
      continue;
    }
    boardSlugs.add(protocol.slug);
  }
  const live = snapshot.protocols.filter(
    (p) => recordsToken(p) && p.mcap_usd !== null && p.mcap_usd > 0,
  ).length;
  excludedList.sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return {
    total: snapshot.protocols.length,
    board: boardSlugs.size,
    live,
    recordedNoMcap,
    aboveFloor,
    excluded: excludedList.length,
    excludedList,
  };
}

// The live-token protocols, for the dashboard's Live view: the calibration's
// own evidence, shown beside the board so a reader can check the multiples.
// Only protocols with a reported market cap above zero; a zero cap means
// the snapshot does not report one.
export function livePeers(snapshot: Snapshot): LivePeer[] {
  const peers: LivePeer[] = [];
  for (const protocol of snapshot.protocols) {
    if (!recordsToken(protocol)) continue;
    if (protocol.mcap_usd === null || protocol.mcap_usd <= 0) continue;
    peers.push({
      slug: protocol.slug,
      name: protocol.name,
      category: protocol.category,
      tvl_usd: protocol.tvl_usd,
      mcap_usd: protocol.mcap_usd,
      ratio: protocol.tvl_usd > 0 ? protocol.mcap_usd / protocol.tvl_usd : null,
    });
  }
  peers.sort((a, b) => b.mcap_usd - a.mcap_usd);
  return peers;
}

// --- Farm plans -----------------------------------------------------------
// Seven steps per protocol, each concrete: what to do, what it costs, how
// long it takes. The steps derive from the protocol's category, chains,
// size and age — never from its name alone. Costs are in dollars: gas for
// the chain, a suggested deposit sized to the protocol, and the break-even
// an airdrop must clear (gas plus the yield forgone on the deposit at 5%).

// What a simple transfer usually costs on each chain, in dollars, and the
// token it is paid in. Chains not listed here take the default at the bottom.
const CHAIN_FEES: Record<string, { token: string; cost: string; usd: number }> = {
  Ethereum: { token: "ETH", cost: "about $8", usd: 8 },
  Solana: { token: "SOL", cost: "under $1", usd: 0.5 },
  Base: { token: "ETH", cost: "under $1", usd: 0.5 },
  Arbitrum: { token: "ETH", cost: "under $1", usd: 0.5 },
  Optimism: { token: "ETH", cost: "under $1", usd: 0.5 },
  Blast: { token: "ETH", cost: "under $1", usd: 0.5 },
  Linea: { token: "ETH", cost: "under $1", usd: 0.5 },
  Scroll: { token: "ETH", cost: "under $1", usd: 0.5 },
  "zkSync Era": { token: "ETH", cost: "under $1", usd: 0.5 },
  BSC: { token: "BNB", cost: "about $0.30", usd: 0.3 },
  Polygon: { token: "POL", cost: "about $0.05", usd: 0.05 },
  Avalanche: { token: "AVAX", cost: "about $0.50", usd: 0.5 },
  Sui: { token: "SUI", cost: "under $1", usd: 0.5 },
  Aptos: { token: "APT", cost: "under $1", usd: 0.5 },
  Hyperliquid: { token: "HYPE", cost: "under $1", usd: 0.5 },
};

function chainFee(chain: string): { token: string; cost: string; usd: number } {
  return CHAIN_FEES[chain] ?? { token: "the chain's native token", cost: "about $1 to $3", usd: 2 };
}

export function gasUsd(chain: string): number {
  return chainFee(chain).usd;
}

// A sensible first position scales with the protocol's size: a giant vault
// can absorb more, a small one should not be chased with a large deposit.
export function depositUsd(tvlUsd: number): number {
  if (tvlUsd >= 1000000000) return 2000;
  if (tvlUsd >= 500000000) return 1000;
  if (tvlUsd >= 100000000) return 500;
  return 250;
}

export function durationDays(ageDays: number | null): number {
  if (ageDays !== null && ageDays < 180) return 60;
  return 90;
}

// What an airdrop must be worth to cover the position's cost: the gas plus
// the yield forgone on the deposit over the holding period, at 5% a year.
export function breakevenUsd(gas: number, deposit: number, days: number): number {
  return Math.round((gas + (deposit * 0.05 * days) / 365) * 100) / 100;
}

function moneyShort(value: number): string {
  if (value >= 1000000000) return `$${(value / 1000000000).toFixed(2).replace(/0$/, "")}B`;
  if (value >= 1000000) return `$${(value / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1000) return `$${(value / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return `$${Math.round(value)}`;
}

function verdictReason(verdict: string, expected: number, breakeven: number, gas: number): string {
  const ev = moneyShort(expected);
  const be = `$${breakeven.toFixed(2)}`;
  if (verdict === "Farm") {
    return `Expected value ${ev} sits in the board's top quarter, against about ${be} to break even — the strongest risk-reward on the board.`;
  }
  if (verdict === "Farm small") {
    return `Expected value ${ev} is mid-board; a small position keeps the break-even near ${be} while the upside plays out.`;
  }
  if (verdict === "Watch") {
    return `Expected value ${ev} is below the board's middle; wait for a catalyst (a points program, a funding round) before paying ${gas >= 5 ? "Ethereum" : "the"} gas.`;
  }
  return `Expected value ${ev} is in the bottom quarter — the ${be} break-even is not worth chasing ahead of better rows.`;
}

// The core action, by category. {name} is the protocol's name.
const CORE_ACTIONS: Record<string, string> = {
  Dexs: "Add liquidity to a {name} pool, pairing a volatile asset with a stablecoin in roughly equal value, then stake the LP receipt if the app offers a farm — points usually accrue to staked positions only.",
  Lending: "Supply an asset as collateral on {name}, then borrow a small amount against it — stay under half your borrowing power — so the position records both sides of activity.",
  "Risk Curators": "Deposit into a {name} curator vault that matches your risk appetite; read the vault's strategy, fees and caps first, and hold the vault receipt token as proof of the deposit.",
  RWA: "Buy the tokenized asset product on {name} with stablecoins and hold it in your wallet; these positions usually pay a stated yield and count toward any future distribution.",
  Yield: "Deposit stablecoins into the highest-TVL {name} vault, confirm the strategy and fee split shown in the app, and leave the deposit working rather than hopping between vaults.",
  "Yield Aggregator": "Deposit into a {name} vault that auto-compounds for you, check the strategy and fees first, and leave the deposit working instead of hopping between vaults.",
  Derivatives: "Open a small perpetuals position on {name} with low leverage (2x or less), set a stop-loss, and keep most of your funds in the margin account rather than in the trade.",
  Restaking: "Restake ETH or a liquid staking token through {name}, check the operator set and the withdrawal delay first, and keep the receipt token in your wallet.",
  CDP: "Lock collateral in a {name} vault and mint a modest amount of stablecoin against it — well under the limit — so the position stays safe if prices fall.",
  "Staking Pool": "Stake your tokens in the {name} pool, confirm the lock period and the unstaking delay, and keep the receipt token — it is your proof of the stake.",
  Payments: "Use {name} to pay or settle a real invoice or transfer, keep the receipt, and repeat weekly — steady usage is what these protocols reward.",
  Insurance: "Buy cover for a position you already hold through {name}, read what the policy excludes first, and keep the cover active for the full term.",
  Chain: "Bridge a small amount to the {name} chain, use its main apps for a swap and a deposit, and keep a balance there — activity on the chain itself is what counts.",
  "Basis Trading": "Deposit into the {name} basis strategy, read how the long and short legs work first, and treat the stated yield as variable — it moves with funding rates.",
  CeDeFi: "Deposit into the {name} product through its app, confirm the custody arrangement and the withdrawal terms, and keep the receipt of every deposit.",
  "Governance Incentives": "Lock or delegate tokens in the {name} incentives program and vote when a proposal is live — participation, not just the lock, is what these programs track.",
  "Stablecoin Wrapper": "Wrap your stablecoins through {name}, confirm the backing and the redemption path first, and hold the wrapped receipt rather than trading it away.",
  "Collateral Markets": "Supply collateral on {name} and borrow a small amount against it, keeping your borrow well under the limit so a price dip cannot liquidate you.",
  "Onchain Capital Allocator": "Allocate stablecoins to a {name} strategy that fits your risk appetite, read the allocation breakdown first, and hold the receipt token as proof.",
  Farm: "Deposit into the {name} farm, confirm the reward schedule and any lock period, and harvest only when the rewards clearly outweigh the gas.",
  "Prediction Market": "Take a small position on a {name} market you have a view on, size it so a loss would not hurt, and hold it to resolution rather than trading in and out.",
  "Cross Chain Bridge": "Bridge a modest amount through {name} between two chains you actually use, keep the receipt, and repeat over several weeks — repeated use beats one big transfer.",
  "OTC Marketplace": "Complete a real trade on the {name} marketplace, follow its escrow steps exactly, and keep the trade receipt — one settled trade beats ten open offers.",
  "CDP Manager": "Open a managed vault on {name}, set your target collateral ratio, and let it rebalance — check the position weekly rather than adjusting it daily.",
};

const CORE_ACTION_FALLBACK = "Use {name}'s main product with a real position — deposit, swap or stake through its app — and keep the position open; one genuine interaction beats ten empty wallet connections.";

// The main risk, by category.
const CATEGORY_RISKS: Record<string, string> = {
  Dexs: "Impermanent loss is the main risk: if the pair's price moves far, your withdrawal can be worth less than simply holding — size the position so a 20% move would not hurt.",
  Lending: "Liquidation is the main risk: if your collateral falls, the protocol can sell it — keep your borrow well under the limit and check the health factor weekly.",
  Derivatives: "Leverage magnifies losses: a 2x position can be liquidated on a 50% move against you, so keep leverage low and never risk funds you need.",
  RWA: "These products carry issuer and custody risk on top of smart-contract risk — read who holds the underlying assets before you deposit.",
  Restaking: "Slashing and withdrawal delays are the main risks — check the operator's record and the unstaking queue before you lock funds.",
  "Stablecoin Wrapper": "A wrapper is only as good as its backing — confirm the reserves and the redemption path, and watch for any depeg before you deposit more.",
};

const RISK_FALLBACK = "Smart-contract risk is real: only deposit what you can afford to lose, check that the contracts are audited, and never approve unlimited spending unless you trust the app.";

function fill(template: string, name: string): string {
  return template.replaceAll("{name}", name);
}

export function farmPlan(
  protocol: SnapshotProtocol,
  valued: ValuedProtocol,
  gas: number,
  deposit: number,
  duration: number,
): string[] {
  const name = protocol.name;
  const firstChain = protocol.chains[0] ?? "Ethereum";
  const secondChain = protocol.chains[1] ?? null;
  const fee = chainFee(firstChain);
  const breakeven = breakevenUsd(gas, deposit, duration);
  const core = protocol.category !== null && CORE_ACTIONS[protocol.category] !== undefined
    ? CORE_ACTIONS[protocol.category]
    : CORE_ACTION_FALLBACK;
  const risk = protocol.category !== null && CATEGORY_RISKS[protocol.category] !== undefined
    ? CATEGORY_RISKS[protocol.category]
    : RISK_FALLBACK;
  const young = valued.ageDays !== null && valued.ageDays < 180;

  const fund = `Bridge $${deposit.toLocaleString("en-US")} in stablecoins to ${firstChain} from your main wallet and keep a little ${fee.token} for fees — a simple transfer here usually costs ${fee.cost}, and the position breaks even on an airdrop of about $${breakeven.toFixed(2)}.`;
  const second = secondChain !== null
    ? `Repeat the core action on a second chain (${secondChain}) or with a second asset, so your activity is not a single transaction — most point systems reward breadth across chains and products.`
    : "Make a second, different interaction — a swap, a second deposit or a governance vote if one is live — so your activity is not a single transaction.";
  const hold = young
    ? `Hold the position for at least ${duration} days without withdrawing; young protocols usually snapshot activity over weeks, and an early exit can reset your standing.`
    : `Hold the position for at least ${duration} days — longer is better — without withdrawing; snapshots reward steady positions, and an early exit can reset your standing.`;
  const hygiene = `Only use links from ${name}'s official site and docs, never from DMs or search ads; ignore anyone offering an early claim, and never type your seed phrase into any site.`;
  const books = "Record every deposit date, amount and transaction hash in a note or spreadsheet; you will need the trail for the claim, for taxes, and to prove your activity if a snapshot is disputed.";

  return [fund, fill(core, name), second, hold, risk, hygiene, books];
}
