// Moteur du bot : règles, indicateurs et portefeuille fictif.
// Partagé entre le bot (Node, sur GitHub Actions) et le tableau de bord (navigateur).
(function (root, factory) {
  const m = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = m;
  else root.Engine = m;
})(typeof self !== 'undefined' ? self : this, function () {
  const PAIRS = [
    { s: 'BTCEUR', name: 'Bitcoin', tk: 'BTC', kraken: 'XBTEUR', ws: 'BTC/EUR', coinbase: 'BTC-EUR' },
    { s: 'ETHEUR', name: 'Ethereum', tk: 'ETH', kraken: 'ETHEUR', ws: 'ETH/EUR', coinbase: 'ETH-EUR' },
    { s: 'SOLEUR', name: 'Solana', tk: 'SOL', kraken: 'SOLEUR', ws: 'SOL/EUR', coinbase: 'SOL-EUR' },
  ];

  // Règles de sécurité : codées en dur, le bot ne peut pas les modifier.
  const RULES = {
    startCash: 1000,   // capital fictif de départ (€)
    alloc: 0.25,       // 25 % maximum du portefeuille par crypto
    fee: 0.001,        // 0,1 % de frais par ordre
    slip: 0.0005,      // 0,05 % de glissement de prix
    stop: 0.02,        // stop-loss à -2 %
    target: 0.04,      // objectif à +4 %
    dayLoss: 0.05,     // arrêt pour la journée à -5 %
    totalLoss: 0.20,   // coupe-circuit définitif à -20 %
    minOrder: 10,      // pas d'ordre de moins de 10 €
  };
  const CANDLE_MS = 5 * 60 * 1000;

  function ema(v, n) {
    const k = 2 / (n + 1), out = [];
    let e;
    for (let i = 0; i < v.length; i++) { e = i === 0 ? v[i] : v[i] * k + e * (1 - k); out.push(e); }
    return out;
  }

  // Croisement de moyennes mobiles 9/21, filtré par la tendance de fond (50).
  function signal(closes) {
    if (closes.length < 60) return null;
    const a = ema(closes, 9), b = ema(closes, 21), c = ema(closes, 50), i = closes.length - 1;
    return {
      up: a[i - 1] <= b[i - 1] && a[i] > b[i],
      down: a[i - 1] >= b[i - 1] && a[i] < b[i],
      trendUp: closes[i] > c[i],
      fastAbove: a[i] > b[i],
    };
  }

  function newBook(cash) { return { cash, positions: {}, trades: [] }; }

  function equityOf(book, prices) {
    let v = book.cash;
    for (const s in book.positions) { const p = book.positions[s]; v += p.qty * (prices[s] ?? p.entry); }
    return v;
  }

  function openPos(book, s, price, time, reason, eq) {
    if (book.positions[s]) return null;
    const alloc = Math.min(eq * RULES.alloc, book.cash);
    if (alloc < RULES.minOrder) return null;
    const fill = price * (1 + RULES.slip), fee = alloc * RULES.fee, qty = (alloc - fee) / fill;
    book.cash -= alloc;
    book.positions[s] = { qty, entry: fill, cost: alloc, time, stop: fill * (1 - RULES.stop), target: fill * (1 + RULES.target) };
    const t = { s, side: 'achat', price: fill, qty, time, amount: alloc, reason };
    book.trades.push(t);
    return t;
  }

  function closePos(book, s, price, time, reason) {
    const p = book.positions[s];
    if (!p) return null;
    const fill = price * (1 - RULES.slip), gross = p.qty * fill, net = gross - gross * RULES.fee;
    book.cash += net;
    delete book.positions[s];
    const pnl = net - p.cost;
    const t = { s, side: 'vente', price: fill, qty: p.qty, time, amount: net, pnl, pnlPct: pnl / p.cost, reason };
    book.trades.push(t);
    return t;
  }

  // Vérifie stop-loss et objectif sur une bougie (plus haut / plus bas). Le stop passe en premier, par prudence.
  function checkExits(book, s, candle, time) {
    const p = book.positions[s];
    if (!p) return null;
    if (candle.l <= p.stop) return closePos(book, s, Math.min(p.stop, candle.o), time, 'Stop-loss touché : on coupe la perte à −2 %');
    if (candle.h >= p.target) return closePos(book, s, Math.max(p.target, candle.o), time, 'Objectif atteint : on encaisse le gain de +4 %');
    return null;
  }

  // Décision à la clôture d'une bougie de 5 minutes.
  function onCloseDecision(book, s, closes, prices, time) {
    const sig = signal(closes);
    if (!sig) return null;
    if (book.positions[s] && sig.down)
      return closePos(book, s, closes[closes.length - 1], time, 'La moyenne rapide repasse sous la lente : la hausse s\'essouffle');
    if (!book.positions[s] && sig.up && sig.trendUp)
      return openPos(book, s, closes[closes.length - 1], time, 'La moyenne rapide passe au-dessus de la lente, tendance de fond haussière', equityOf(book, prices));
    return null;
  }

  return { PAIRS, RULES, CANDLE_MS, ema, signal, newBook, equityOf, openPos, closePos, checkExits, onCloseDecision };
});
