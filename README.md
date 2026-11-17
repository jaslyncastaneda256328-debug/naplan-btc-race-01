# SLOWBREAK — cbBTC trend-breakout bot

A long-only trading bot for the make.fun `btc-race-24h-20261117-0603`
competition: it trades Coinbase Wrapped BTC (cbBTC) against USDC on
1-minute on-chain bars, starting with $1,000 of paper money, for the
highest net PnL over 24 hours. Nothing is traded for real.

## How it works

The bot speaks `agent-fun/bars-replay/v1` (newline-delimited JSON on
stdin/stdout) through the kit's Python shim, vendored byte-for-byte
under `vendor/makefun_bars.py`.

On every bar it updates, for cbBTC only:

- **EMA(30) / EMA(90)** on closes, seeded as the mean of their first
  span of closes.
- **Donchian breakout**: the highest close of the last 90 bars.
- **Volatility**: mean absolute 1-minute return over the last 60 bars.

**Entry** (flat only): EMA(30) above EMA(90) **and** the close breaks
above the 90-bar high **and** mean |1m return| above 4 bps. It buys
100% of cash, up to the weight cap. A full-size round trip costs about
26 bps in fees, slippage and price impact, so the volatility filter
keeps the bot out when the market is too quiet to pay for a trade.

**Exit** (whole position), whichever comes first:

- trend flip: EMA(30) back below EMA(90);
- trailing stop: 1.00% below the highest close since entry;
- take profit: position worth 2.50% over its cost (fees included);
- hard stop: position worth 1.50% under its cost.

After any exit the bot waits 15 bars before a new entry, so it does
not buy straight back into the same whipsaw.

## Risk rules

- Long only, at most one open position, no leverage, no shorts.
- A buy never spends more than the cash on hand; sells never exceed the
  position held.
- Every order caps slippage at 100 bps past the close it was decided
  on, so a fill into a liquidity gap is refused and retried.
- The hard stop plus the trailing stop bound the loss on any single
  trade to a few percent of equity, far inside the 25% maximum-drawdown
  guardrail.
- Deterministic: pure float64 arithmetic on the bars, no wall clock, no
  environment, no randomness, no files outside the repository. The same
  bars give the same orders, run after run.

## Files

- `main.py` — the bot (Python 3.13, standard library only).
- `vendor/makefun_bars.py` — the kit's protocol shim, byte-identical.
- `LICENSE` — MIT.

## Local grading

From the unpacked kit directory:

```
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

## Dev-window result

Graded on the kit's frozen 24-hour dev window with the local grader
(see the build notes in the submission bundle): net PnL, trades and
maximum drawdown are reported by `grade-local`.
