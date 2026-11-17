# DIPBUY — cbBTC mean-reversion dip-buying bot

A long-only trading bot for the make.fun `btc-race-24h-20261117-0603`
competition: it trades Coinbase Wrapped BTC (cbBTC) against USDC on
1-minute on-chain bars, starting with $1,000 of paper money, for the
highest net PnL over 24 hours. Nothing is traded for real.

## How it works

The bot speaks `agent-fun/bars-replay/v1` (newline-delimited JSON on
stdin/stdout) through the kit's TypeScript shim, vendored byte-for-byte
under `vendor/makefun-bars.ts`.

On every bar it updates the simple moving average of the last 240
closes. On 1-minute bars the price spends most of a day oscillating
around a slow mean; the bot buys the dips below it and sells the
reversion back to it.

**Entry** (flat only): the close is at least 80 bps below the 240-bar
mean. It buys 100% of cash, up to the weight cap. A full-size round
trip costs about 26 bps in fees, slippage and price impact, so the dip
has to be deep enough that the reversion to the mean pays for the trade
several times over.

**Exit** (whole position), whichever comes first:

- reversion: the close is back at or above the mean;
- take profit: position worth 1.00% over its cost (fees included);
- hard stop: position worth 1.00% under its cost, so a dip that keeps
  falling is cut instead of ridden down.

After any exit the bot waits 15 bars before a new entry, so it does
not buy straight back into the same falling dip.

## Why this shape

On the kit's frozen dev window the fast trend systems all lose money —
1-minute breakouts chase moves that are already done, and each round
trip costs ~26 bps. Buying 80 bps below a 240-bar mean and selling the
reversion makes money on the same window with only 4 trades, and the
result holds across the whole neighbourhood (SMA 180–300, dip 70–90
bps all end positive), so it is a plateau of the rule, not one lucky
parameter.

## Risk rules

- Long only, at most one open position, no leverage, no shorts.
- A buy never spends more than the cash on hand; sells never exceed the
  position held.
- Every order caps slippage at 100 bps past the close it was decided
  on, so a fill into a liquidity gap is refused and retried.
- The hard stop bounds the loss on any single trade to about 1% of
  equity, far inside the 25% maximum-drawdown guardrail.
- Deterministic: pure float64 arithmetic on the bars, no wall clock, no
  environment, no randomness, no files outside the repository. The same
  bars give the same orders, run after run.

## Files

- `main.ts` — the bot (Node 22, TypeScript with erasable syntax only).
- `vendor/makefun-bars.ts` — the kit's protocol shim, byte-identical.
- `LICENSE` — MIT.

## Local grading

From the unpacked kit directory:

```
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

## Dev-window result

Graded on the kit's frozen 24-hour dev window with the local grader:
**net PnL +$2.79, 4 trades, maximum drawdown 0.72%** — above $0, so
the entry passes the dev gate and races.
