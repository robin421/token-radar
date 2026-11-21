// Token Radar's value model.
//
// The board ranks protocols that record no token yet by an implied value:
// what a token would be worth if the protocol's record stayed as it is.
// Every input comes from the sealed snapshot; nothing here names a protocol.
//
//   implied = TVL x category multiple x growth x maturity x breadth
//
// The category multiple is calibrated from the snapshot itself: for each
// category, the median market-cap-to-TVL ratio of the protocols in it whose
// token already trades, shrunk toward the global median when the category
// has few such peers. Growth comes from the seven-day TVL change, maturity
// from how long the protocol has run, breadth from how many chains it spans.

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
  watchlist: boolean;
  multiple: number;
  multiple_peers: number;
  growth: number;
  maturity: number;
  breadth: number;
}

export interface LivePeer {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
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
  if (protocol.category !== null && EXCLUDED_CATEGORIES.includes(protocol.category)) {
    return true;
  }
  if (VERSION_SUFFIX.test(protocol.name)) return true;
  if (WRAPPED_WORD.test(protocol.name)) return true;
  for (const exchange of EXCHANGE_NAMES) {
    if (protocol.name.startsWith(exchange)) return true;
  }
  return false;
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

// Calibrate the category multiples from the protocols whose token already
// trades: each peer contributes its market-cap-to-TVL ratio, winsorized at
// 3x so one outlier cannot set a category. A category with at least two
// peers takes its own median, shrunk toward the global median with a
// strength of 4 peers; a category with fewer peers takes the global median.
// Multiples are clamped to [0.03, 1.5]: no launch is worth 3% of TVL or
// less, and none is worth more than 1.5x TVL on this evidence.
export function calibrate(snapshot: Snapshot): Calibration {
  const ratiosByCategory = new Map<string, number[]>();
  const allRatios: number[] = [];
  for (const protocol of snapshot.protocols) {
    if (!recordsToken(protocol)) continue;
    if (protocol.mcap_usd === null || protocol.tvl_usd <= 0) continue;
    const ratio = Math.min(protocol.mcap_usd / protocol.tvl_usd, 3);
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
    const peers = ratios.length;
    const raw = peers >= 2
      ? (peers * peerMedian + 4 * globalMedian) / (peers + 4)
      : globalMedian;
    const multiple = clamp(raw, 0.03, 1.5);
    rows.push({ category, peers, peerMedian, multiple });
    lookup.set(category, { multiple, peers });
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

// Seven-day TVL growth, mapped to [0.75, 1.5]. A protocol that doubled in a
// week earns the top of the range; one that halved earns the bottom. No
// reported change means no adjustment.
export function growthFactor(change7d: number | null): number {
  if (change7d === null) return 1;
  return 1 + clamp(change7d, -50, 100) / 200;
}

function daysBetween(fromDay: string, toDay: string): number {
  const from = Date.parse(`${fromDay}T00:00:00Z`);
  const to = Date.parse(`${toDay}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.floor((to - from) / 86400000));
}

// How long the protocol has run with no token, mapped to [0.85, 1.15]. A
// record that has held up for three years earns the top; a listing from this
// month earns the bottom. No listing date means no adjustment.
export function maturityFactor(listedAt: string | null, asOf: string): number {
  if (listedAt === null) return 1;
  const ageDays = daysBetween(listedAt, asOf);
  return 0.85 + 0.3 * Math.min(ageDays / 1095, 1);
}

// How many chains the protocol spans, mapped to [1.0, 1.2]. Each extra chain
// up to five adds 5%: a wider footprint is worth more, with diminishing
// returns past a handful of chains.
export function breadthFactor(chains: string[]): number {
  return 1 + 0.05 * Math.min(Math.max(chains.length - 1, 0), 4);
}

export interface ValuedProtocol {
  protocol: SnapshotProtocol;
  implied: number;
  multiple: number;
  peers: number;
  growth: number;
  maturity: number;
  breadth: number;
  ageDays: number | null;
}

export function valueProtocol(
  protocol: SnapshotProtocol,
  calibration: Calibration,
  asOf: string,
): ValuedProtocol {
  const { multiple, peers } = calibration.multipleFor(protocol.category);
  const growth = growthFactor(protocol.change_7d);
  const maturity = maturityFactor(protocol.listed_at, asOf);
  const breadth = breadthFactor(protocol.chains);
  const raw = protocol.tvl_usd * multiple * growth * maturity * breadth;
  const implied = Math.max(1, Math.min(100000000000000, Math.round(raw)));
  const ageDays = protocol.listed_at === null
    ? null
    : daysBetween(protocol.listed_at, asOf);
  return { protocol, implied, multiple, peers, growth, maturity, breadth, ageDays };
}

// The board: every watchlist protocol, plus every pre-token protocol below
// the floor that passes the visible part of the house rule. Above the floor
// the entry trusts the house's list (which used the parentProtocol record
// the snapshot does not carry); below it, it applies the rule as far as the
// snapshot lets it. Ranked by implied value, ties broken by slug so the
// order is the same on every run.
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const calibration = calibrate(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const picked: ValuedProtocol[] = [];
  for (const protocol of snapshot.protocols) {
    const onWatchlist = watchlist.has(protocol.slug);
    const earlyCandidate = recordsNoToken(protocol)
      && protocol.tvl_usd < snapshot.floor_usd
      && !breaksHouseRule(protocol);
    if (!onWatchlist && !earlyCandidate) continue;
    picked.push(valueProtocol(protocol, calibration, snapshot.as_of));
  }
  picked.sort((a, b) => {
    if (b.implied !== a.implied) return b.implied - a.implied;
    return a.protocol.slug < b.protocol.slug ? -1 : 1;
  });
  return picked.map((valued, index) => {
    const protocol = valued.protocol;
    return {
      slug: protocol.slug,
      name: protocol.name,
      rank: index + 1,
      implied_value_usd: valued.implied,
      farm_steps: farmPlan(protocol, valued),
      category: protocol.category,
      chains: protocol.chains,
      tvl_usd: protocol.tvl_usd,
      change_7d: protocol.change_7d,
      listed_at: protocol.listed_at,
      age_days: valued.ageDays,
      watchlist: watchlist.has(protocol.slug),
      multiple: valued.multiple,
      multiple_peers: valued.peers,
      growth: valued.growth,
      maturity: valued.maturity,
      breadth: valued.breadth,
    };
  });
}

// The live-token protocols, for the dashboard's Live view: the calibration's
// own evidence, shown beside the board so a reader can check the multiples.
export function livePeers(snapshot: Snapshot): LivePeer[] {
  const peers: LivePeer[] = [];
  for (const protocol of snapshot.protocols) {
    if (!recordsToken(protocol)) continue;
    if (protocol.mcap_usd === null || protocol.tvl_usd <= 0) continue;
    peers.push({
      slug: protocol.slug,
      name: protocol.name,
      category: protocol.category,
      tvl_usd: protocol.tvl_usd,
      mcap_usd: protocol.mcap_usd,
      ratio: protocol.mcap_usd / protocol.tvl_usd,
    });
  }
  peers.sort((a, b) => b.mcap_usd - a.mcap_usd);
  return peers;
}

// --- Farm plans -----------------------------------------------------------
// Seven steps per protocol, each concrete: what to do, what it costs, how
// long it takes. The steps derive from the protocol's category, chains,
// size and age — never from its name alone.

// What a simple transfer usually costs on each chain, and the token it is
// paid in. Chains not listed here take the default at the bottom.
const CHAIN_FEES: Record<string, { token: string; cost: string }> = {
  Ethereum: { token: "ETH", cost: "about $8" },
  Solana: { token: "SOL", cost: "under $1" },
  Base: { token: "ETH", cost: "under $1" },
  Arbitrum: { token: "ETH", cost: "under $1" },
  Optimism: { token: "ETH", cost: "under $1" },
  Blast: { token: "ETH", cost: "under $1" },
  Linea: { token: "ETH", cost: "under $1" },
  Scroll: { token: "ETH", cost: "under $1" },
  "zkSync Era": { token: "ETH", cost: "under $1" },
  BSC: { token: "BNB", cost: "about $0.30" },
  Polygon: { token: "POL", cost: "about $0.05" },
  Avalanche: { token: "AVAX", cost: "about $0.50" },
  Sui: { token: "SUI", cost: "under $1" },
  Aptos: { token: "APT", cost: "under $1" },
  Hyperliquid: { token: "HYPE", cost: "under $1" },
};

function chainFee(chain: string): { token: string; cost: string } {
  return CHAIN_FEES[chain] ?? { token: "the chain's native token", cost: "about $1 to $3" };
}

// A sensible first position scales with the protocol's size: a giant vault
// can absorb more, a small one should not be chased with a large deposit.
function suggestedStake(tvlUsd: number): string {
  if (tvlUsd >= 1000000000) return "$2,000";
  if (tvlUsd >= 500000000) return "$1,000";
  if (tvlUsd >= 100000000) return "$500";
  return "$250";
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

export function farmPlan(protocol: SnapshotProtocol, valued: ValuedProtocol): string[] {
  const name = protocol.name;
  const firstChain = protocol.chains[0] ?? "Ethereum";
  const secondChain = protocol.chains[1] ?? null;
  const fee = chainFee(firstChain);
  const stake = suggestedStake(protocol.tvl_usd);
  const core = protocol.category !== null && CORE_ACTIONS[protocol.category] !== undefined
    ? CORE_ACTIONS[protocol.category]
    : CORE_ACTION_FALLBACK;
  const risk = protocol.category !== null && CATEGORY_RISKS[protocol.category] !== undefined
    ? CATEGORY_RISKS[protocol.category]
    : RISK_FALLBACK;
  const young = valued.ageDays !== null && valued.ageDays < 180;

  const fund = `Bridge ${stake} in stablecoins to ${firstChain} from your main wallet and keep a little ${fee.token} for fees — a simple transfer here usually costs ${fee.cost}.`;
  const second = secondChain !== null
    ? `Repeat the core action on a second chain (${secondChain}) or with a second asset, so your activity is not a single transaction — most point systems reward breadth across chains and products.`
    : "Make a second, different interaction — a swap, a second deposit or a governance vote if one is live — so your activity is not a single transaction.";
  const hold = young
    ? "Hold the position for at least 60 days without withdrawing; young protocols usually snapshot activity over weeks, and an early exit can reset your standing."
    : "Hold the position for at least 30 days — 90 is better — without withdrawing; snapshots reward steady positions, and an early exit can reset your standing.";
  const hygiene = `Only use links from ${name}'s official site and docs, never from DMs or search ads; ignore anyone offering an early claim, and never type your seed phrase into any site.`;
  const books = "Record every deposit date, amount and transaction hash in a note or spreadsheet; you will need the trail for the claim, for taxes, and to prove your activity if a snapshot is disputed.";

  return [fund, fill(core, name), second, hold, risk, hygiene, books];
}
