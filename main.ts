// DIPBUY: a mean-reversion dip-buying bot for cbBTC on 1-minute bars.
//
// Strategy (long only, one position, no leverage, no shorts):
//   * Mean: the simple moving average of the last SMA_BARS closes.
//     On 1-minute bars the price spends most of a day oscillating
//     around a slow mean; the bot buys the dips below it and sells the
//     reversion back to it.
//   * Entry: flat, and the close is at least DIP_BPS below the mean.
//     A full-size round trip costs about 26 bps in fees, slippage and
//     price impact, so the dip has to be deep enough that the reversion
//     to the mean pays for the trade several times over.
//   * Exit (whole position), whichever comes first:
//       - reversion: the close is back at or above the mean;
//       - take profit: the position is worth TAKE_PROFIT_BPS over its
//         cost (fees included);
//       - hard stop: the position is worth STOP_BPS under its cost, so
//         a dip that keeps falling is cut instead of ridden down.
//   * Cooldown: after any exit, no new entry for COOLDOWN_BARS bars, so
//     the bot does not buy straight back into the same falling dip.
//
// Why this shape: on the kit's frozen dev window the fast trend systems
// all lose money — 1-minute breakouts chase moves that are already
// done, and each round trip costs ~26 bps. Buying 80 bps below a
// 240-bar mean and selling the reversion makes money on the same
// window with only 4 trades, and the result holds across the whole
// neighbourhood (SMA 180–300, dip 70–90 bps all end positive), so it
// is a plateau of the rule, not one lucky parameter.
//
// Determinism: pure float64 arithmetic on the bars, no wall clock, no
// environment, no randomness, no files outside the repository. The same
// bars give the same orders, run after run, which the grader requires
// (two executions must produce byte-identical action logs).
//
// Risk rules: at most one open position; a buy never spends more than
// the cash on hand; every order caps slippage at 100 bps past the close
// it was decided on, so a fill into a liquidity gap is refused and
// retried rather than taken for almost nothing; the hard stop bounds
// the loss on any single trade to about 1% of equity, far inside the
// 25% maximum-drawdown guardrail.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// --- Tunable parameters (bps = basis points, 100 bps = 1%) -----------------
const SMA_BARS = 240; // mean lookback, in bars
const DIP_BPS = 80; // entry: close this far below the mean
const TAKE_PROFIT_BPS = 100; // exit when the position is this far over its cost
const STOP_BPS = 100; // exit when the position is this far under its cost
const COOLDOWN_BARS = 15; // bars to wait after an exit before a new entry
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

const SYMBOL = 'CBBTC';

const closes: number[] = [];
let cooldownLeft = 0;

/** The mean of the last SMA_BARS closes, or null before enough bars. */
function mean(): number | null {
  if (closes.length < SMA_BARS) return null;
  let sum = 0;
  for (let i = closes.length - SMA_BARS; i < closes.length; i++) sum += closes[i];
  return sum / SMA_BARS;
}

await runBars({
  onBatch(state: BarsState, batch) {
    if (state.warmingUp) return [];
    let fresh = false;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      closes.push(Number(bar.c));
      fresh = true;
    }
    if (!fresh) return [];
    if (cooldownLeft > 0) cooldownLeft -= 1;
    const m = mean();
    if (m === null) return [];
    const held = state.positions.get(SYMBOL);
    const closeBig = state.close(SYMBOL);
    if (closeBig === null) return [];
    const close = Number(closeBig);

    if (held !== undefined) {
      // --- exit checks, whole position ---
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      const profitHit = value * 10000n >= cost * BigInt(10000 + TAKE_PROFIT_BPS);
      const stopHit = value * 10000n <= cost * BigInt(10000 - STOP_BPS);
      if (close >= m || profitHit || stopHit) {
        cooldownLeft = COOLDOWN_BARS;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // --- entry checks, flat ---
    if (cooldownLeft > 0) return [];
    if (close * 10000 > m * (10000 - DIP_BPS)) return [];
    const room = state.weightRoom(SYMBOL);
    const notional = state.cash < room ? state.cash : room;
    if (notional <= 0n || notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
