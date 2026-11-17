// SLOWBREAK: a slow trend-breakout bot for cbBTC on 1-minute bars.
//
// Strategy (long only, one position, no leverage, no shorts):
//   * Trend: EMA(FAST) above EMA(SLOW) on closes. Both EMAs seed as the
//     mean of their first span of closes, then move 2 / (span + 1) toward
//     each close.
//   * Breakout: the close breaks above the highest close of the last
//     DONCHIAN bars. A breakout in an uptrend is the only entry.
//   * Volatility filter: the mean absolute 1-minute return over the last
//     VOL_WINDOW bars must exceed VOL_MIN_BPS. A full-size round trip
//     costs about 26 bps in fees, slippage and price impact, so the bot
//     only trades when the market is actually moving enough to pay for a
//     trade.
//   * Entry: 100% of cash (up to the weight cap) on the breakout bar;
//     the order fills at the next bar's open.
//   * Exit (whole position), whichever comes first:
//       - trend flip: EMA(FAST) back below EMA(SLOW);
//       - trailing stop: the close falls TRAIL_BPS below the highest
//         close since entry;
//       - take profit: the position is worth TAKE_PROFIT_BPS over its
//         cost (fees included);
//       - hard stop: the position is worth STOP_BPS under its cost.
//   * Cooldown: after any exit, no new entry for COOLDOWN_BARS bars, so
//     the bot does not buy straight back into the same whipsaw.
//
// Determinism: pure float64 arithmetic on the bars, no wall clock, no
// environment, no randomness, no files outside the repository. The same
// bars give the same orders, run after run, which the grader requires
// (two executions must produce byte-identical action logs).
//
// Risk rules: at most one open position; a buy never spends more than
// the cash on hand; every order caps slippage at 100 bps past the close
// it was decided on, so a fill into a liquidity gap is refused and
// retried rather than taken for almost nothing; the hard stop plus the
// trailing stop bound the loss on any single trade to a few percent of
// equity, far inside the 25% maximum-drawdown guardrail.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// --- Tunable parameters (bps = basis points, 100 bps = 1%) -----------------
const FAST_BARS = 30; // fast EMA span, in bars
const SLOW_BARS = 90; // slow EMA span, in bars
const DONCHIAN_BARS = 90; // breakout window, in bars
const VOL_WINDOW = 60; // volatility lookback, in bars
const VOL_MIN_BPS = 4; // entry needs mean |1m return| above this, in bps
const TRAIL_BPS = 100; // trailing stop below the peak close since entry
const TAKE_PROFIT_BPS = 250; // exit when the position is this far over its cost
const STOP_BPS = 150; // exit when the position is this far under its cost
const COOLDOWN_BARS = 15; // bars to wait after an exit before a new entry
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

const SYMBOL = 'CBBTC';

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  closes: number[];
  prevClose: number | null;
  absReturns: number[];
  peakSinceEntry: number | null;
  cooldownLeft: number;
}

const series = new Map<string, Series>();

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = { fast: { span: FAST_BARS, warm: [], value: null }, slow: { span: SLOW_BARS, warm: [], value: null }, closes: [], prevClose: null, absReturns: [], peakSinceEntry: null, cooldownLeft: 0 };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  step(s.fast, c);
  step(s.slow, c);
  if (s.prevClose !== null && s.prevClose > 0) {
    s.absReturns.push((Math.abs(c - s.prevClose) * 10000) / s.prevClose);
    if (s.absReturns.length > VOL_WINDOW) s.absReturns.shift();
  }
  s.prevClose = c;
  s.closes.push(c);
  if (s.cooldownLeft > 0) s.cooldownLeft -= 1;
  return s;
}

/** Highest close of the last DONCHIAN_BARS bars, excluding this bar. */
function donchianHigh(s: Series): number | null {
  const window = s.closes.slice(-DONCHIAN_BARS - 1, -1);
  if (window.length < DONCHIAN_BARS) return null;
  return Math.max(...window);
}

function meanAbsReturnBps(s: Series): number | null {
  if (s.absReturns.length < VOL_WINDOW) return null;
  return s.absReturns.reduce((a, x) => a + x, 0) / VOL_WINDOW;
}

await runBars({
  onBatch(state: BarsState, batch) {
    if (state.warmingUp) return [];
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      push(bar);
      fresh.add(bar.symbol);
    }
    if (!fresh.has(SYMBOL)) return [];
    const s = series.get(SYMBOL)!;
    const held = state.positions.get(SYMBOL);
    const closeBig = state.close(SYMBOL);
    if (closeBig === null) return [];
    const close = Number(closeBig);

    if (held !== undefined) {
      // --- exit checks, whole position ---
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      if (s.peakSinceEntry === null || close > s.peakSinceEntry) s.peakSinceEntry = close;
      const stopHit = value * 10000n <= cost * BigInt(10000 - STOP_BPS);
      const profitHit = value * 10000n >= cost * BigInt(10000 + TAKE_PROFIT_BPS);
      const trailHit = BigInt(Math.round(close * 10000)) <= BigInt(Math.round(s.peakSinceEntry * (10000 - TRAIL_BPS)));
      if ((s.fast.value !== null && s.slow.value !== null && s.fast.value < s.slow.value) || stopHit || profitHit || trailHit) {
        s.peakSinceEntry = null;
        s.cooldownLeft = COOLDOWN_BARS;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // --- entry checks, flat ---
    if (s.cooldownLeft > 0) return [];
    if (s.fast.value === null || s.slow.value === null || s.fast.value <= s.slow.value) return [];
    const high = donchianHigh(s);
    if (high === null || close < high) return [];
    const vol = meanAbsReturnBps(s);
    if (vol === null || vol < VOL_MIN_BPS) return [];
    const room = state.weightRoom(SYMBOL);
    let notional = state.cash < room ? state.cash : room;
    if (notional <= 0n || notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    s.peakSinceEntry = close;
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
