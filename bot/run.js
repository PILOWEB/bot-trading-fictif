// Un passage du bot : récupère les vrais prix, rejoue les bougies de 5 min terminées
// depuis le dernier passage, prend les décisions pour chaque portefeuille et enregistre l'état.
// Lancé toutes les 5 minutes par GitHub Actions (.github/workflows/bot.yml).
const fs = require('fs');
const path = require('path');
const E = require('./engine');
const { PAIRS, RULES, CANDLE_MS, MODES } = E;

const FILE = process.env.STATE_FILE || path.join(__dirname, '..', 'state', 'state.json');
const NOW = process.env.NOW ? Number(process.env.NOW) : Date.now();
const RESET = process.env.RESET === 'true';
const MAX_CLOSES = 300, MAX_TRADES = 1000, MAX_LOG = 200, MAX_EQUITY = 4032; // 4032 points = 14 jours

const parisDay = t => new Date(t).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'bot-trading-fictif' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} sur ${url}`);
  return r.json();
}

async function krakenCandles(p) {
  const j = await getJSON(`https://api.kraken.com/0/public/OHLC?pair=${p.kraken}&interval=5`);
  if (j.error && j.error.length) throw new Error(j.error.join(', '));
  const key = Object.keys(j.result).find(k => k !== 'last');
  return j.result[key].map(r => ({ t: r[0] * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4] }));
}

async function coinbaseCandles(p) {
  const rows = await getJSON(`https://api.exchange.coinbase.com/products/${p.coinbase}/candles?granularity=300`);
  return rows.map(r => ({ t: r[0] * 1000, l: +r[1], h: +r[2], o: +r[3], c: +r[4] })).sort((a, b) => a.t - b.t);
}

async function candles(p) {
  try { return { src: 'Kraken', rows: await krakenCandles(p) }; }
  catch (e) {
    console.log(`Kraken indisponible pour ${p.s} (${e.message}), on passe sur Coinbase.`);
    return { src: 'Coinbase', rows: await coinbaseCandles(p) };
  }
}

function freshAccount(msg) {
  const acc = { start: NOW, book: E.newBook(RULES.startCash), log: [], equity: [], day: null, halted: null, startPrices: null };
  if (msg) acc.log.push({ side: 'info', time: NOW, reason: msg });
  return acc;
}

function fresh() {
  return { version: 2, accounts: {}, lastCandle: {}, closes: {}, prices: {}, lastRun: null, source: null };
}

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return null; }
}

// Version 1 : un seul portefeuille à la racine de l'état. Il devient le portefeuille A.
function migrate(S) {
  if (S.accounts) return S;
  const { book, log, equity, day, halted, start, startPrices } = S;
  return {
    version: 2, accounts: { A: { start, book, log, equity, day, halted, startPrices } },
    lastCandle: S.lastCandle, closes: S.closes, prices: S.prices, lastRun: S.lastRun, source: S.source,
  };
}

function info(acc, time, msg) { acc.log.push({ side: 'info', time, reason: msg }); }

function closeAll(acc, prices, time, reason) {
  for (const s of Object.keys(acc.book.positions)) E.closePos(acc.book, s, prices[s] ?? acc.book.positions[s].entry, time, reason);
}

// Arrêt du jour à -5 % et coupe-circuit à -20 %.
function riskCheck(acc, prices, time) {
  const eq = E.equityOf(acc.book, prices);
  const day = parisDay(time);
  if (!acc.day || acc.day.date !== day) {
    acc.day = { date: day, equity: eq };
    if (acc.halted === 'day') { acc.halted = null; info(acc, time, 'Nouvelle journée : le bot reprend.'); }
  }
  if (acc.halted === 'total') return eq;
  if (eq <= RULES.startCash * (1 - RULES.totalLoss)) {
    closeAll(acc, prices, time, 'Coupe-circuit : perte totale de 20 % atteinte');
    acc.halted = 'total';
    info(acc, time, 'Coupe-circuit déclenché. Le bot est arrêté définitivement.');
  } else if (!acc.halted && eq <= acc.day.equity * (1 - RULES.dayLoss)) {
    closeAll(acc, prices, time, 'Arrêt du jour : perte de 5 % sur la journée');
    acc.halted = 'day';
    info(acc, time, 'Perte du jour à −5 % : le bot attend demain.');
  }
  return E.equityOf(acc.book, prices);
}

function pushEquity(acc, t, v) {
  const last = acc.equity[acc.equity.length - 1];
  if (last && last.t === t) last.v = v; else acc.equity.push({ t, v });
}

async function main() {
  let S = load();
  if (!S || RESET) S = fresh();
  else S = migrate(S);
  for (const m of Object.keys(MODES)) {
    if (!S.accounts[m] || RESET)
      S.accounts[m] = freshAccount(RESET ? 'Portefeuille remis à zéro : 1 000 € fictifs.' : `Démarrage du ${MODES[m].name.toLowerCase()} avec 1 000 € fictifs.`);
  }
  const accounts = Object.entries(S.accounts);

  const data = {};
  for (const p of PAIRS) data[p.s] = await candles(p);
  S.source = [...new Set(Object.values(data).map(d => d.src))].join(' + ');

  // Bougies terminées seulement ; la dernière ligne est la bougie en cours.
  const events = [];
  const live = {};
  for (const p of PAIRS) {
    const rows = data[p.s].rows;
    live[p.s] = rows[rows.length - 1].c;
    const closed = rows.filter(c => c.t + CANDLE_MS <= NOW);
    if (!S.closes[p.s] || RESET) {
      // Premier passage : on charge l'historique sans trader dessus.
      S.closes[p.s] = closed.slice(-MAX_CLOSES).map(c => c.c);
      S.lastCandle[p.s] = closed[closed.length - 1].t;
      S.prices[p.s] = closed[closed.length - 1].c;
      continue;
    }
    for (const c of closed) if (c.t > S.lastCandle[p.s]) events.push({ s: p.s, c });
  }
  events.sort((a, b) => a.c.t - b.c.t);

  let i = 0;
  while (i < events.length) {
    const t = events[i].c.t, closeTime = t + CANDLE_MS;
    for (; i < events.length && events[i].c.t === t; i++) {
      const { s, c } = events[i];
      S.prices[s] = c.c;
      const closes = S.closes[s];
      closes.push(c.c);
      if (closes.length > MAX_CLOSES) closes.splice(0, closes.length - MAX_CLOSES);
      S.lastCandle[s] = t;
      for (const [m, acc] of accounts) {
        if (acc.halted !== 'total') E.checkExits(acc.book, s, c, closeTime);
        if (!acc.halted) E.onCloseDecision(acc.book, s, closes, S.prices, closeTime, m);
      }
    }
    for (const [, acc] of accounts) pushEquity(acc, closeTime, riskCheck(acc, S.prices, closeTime));
  }

  // Prix du moment, pour l'affichage et le point de départ « acheter et garder ».
  Object.assign(S.prices, live);
  for (const [m, acc] of accounts) {
    if (!acc.startPrices) acc.startPrices = { ...live };
    pushEquity(acc, NOW, riskCheck(acc, S.prices, NOW));
    if (acc.book.trades.length > MAX_TRADES) acc.book.trades.splice(0, acc.book.trades.length - MAX_TRADES);
    if (acc.log.length > MAX_LOG) acc.log.splice(0, acc.log.length - MAX_LOG);
    if (acc.equity.length > MAX_EQUITY) acc.equity.splice(0, acc.equity.length - MAX_EQUITY);
    const eq = E.equityOf(acc.book, S.prices);
    console.log(`${MODES[m].name} : ${eq.toFixed(2)} €. Positions : ${Object.keys(acc.book.positions).join(', ') || 'aucune'}.`);
  }
  S.lastRun = NOW;

  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(S));
  console.log(`${events.length} bougie(s) traitée(s).`);
}

main().catch(e => { console.error(e); process.exit(1); });
