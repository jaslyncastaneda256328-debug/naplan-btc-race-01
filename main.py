"""SLOWBREAK: a slow trend-breakout bot for cbBTC on 1-minute bars.

Strategy (long only, one position, no leverage, no shorts):
  * Trend: EMA(FAST) above EMA(SLOW) on closes. Both EMAs seed as the mean
    of their first span of closes, then move 2 / (span + 1) toward each close.
  * Breakout: the close breaks above the highest close of the last DONCHIAN
    bars. A breakout in an uptrend is the only entry.
  * Volatility filter: the mean absolute 1-minute return over the last
    VOL_WINDOW bars must exceed VOL_MIN_BPS. A full-size round trip costs
    about 26 bps in fees, slippage and price impact, so the bot only trades
    when the market is actually moving enough to pay for a trade.
  * Entry: 100% of cash (up to the weight cap) on the breakout bar; the
    order fills at the next bar's open.
  * Exit (whole position), whichever comes first:
      - trend flip: EMA(FAST) back below EMA(SLOW);
      - trailing stop: the close falls TRAIL_BPS below the highest close
        since entry;
      - take profit: the position is worth TP_BPS over its cost (fees in);
      - hard stop: the position is worth STOP_BPS under its cost.
  * Cooldown: after any exit, no new entry for COOLDOWN bars, so the bot
    does not buy straight back into the same whipsaw.

Determinism: pure float64 arithmetic on the bars, no wall clock, no
environment, no randomness, no files outside the repository. The same bars
give the same orders, run after run, which the grader requires (two
executions must produce byte-identical action logs).

Risk rules: at most one open position; a buy never spends more than the
cash on hand; every order caps slippage at 100 bps past the close it was
decided on, so a fill into a liquidity gap is refused and retried rather
than taken for almost nothing; the hard stop plus the trailing stop bound
the loss on any single trade to a few percent of equity, far inside the
25% maximum-drawdown guardrail.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))
import makefun_bars

# --- Tunable parameters (bps = basis points, 100 bps = 1%) -----------------
FAST_BARS = 30        # fast EMA span, in bars
SLOW_BARS = 90        # slow EMA span, in bars
DONCHIAN_BARS = 90    # breakout window, in bars
VOL_WINDOW = 60       # volatility lookback, in bars
VOL_MIN_BPS = 4       # entry needs mean |1m return| above this, in bps
TRAIL_BPS = 100       # trailing stop below the peak close since entry
TAKE_PROFIT_BPS = 250  # exit when the position is this far over its cost
STOP_BPS = 150        # exit when the position is this far under its cost
COOLDOWN_BARS = 15    # bars to wait after an exit before a new entry
MAX_SLIPPAGE_BPS = 100  # 1% past the close the order was decided on

SYMBOL = "CBBTC"


class Ema:
    """One EMA: the closes it has seen until it starts, then its value."""

    def __init__(self, span):
        self.span = span
        self.warm = []
        self.value = None

    def step(self, close):
        if self.value is not None:
            self.value += (2.0 / (self.span + 1)) * (close - self.value)
            return
        self.warm.append(close)
        if len(self.warm) == self.span:
            self.value = sum(self.warm) / self.span


class Series:
    """Per-symbol state: EMAs, Donchian window, volatility, trade state."""

    def __init__(self):
        self.fast = Ema(FAST_BARS)
        self.slow = Ema(SLOW_BARS)
        self.closes = []          # every close seen, oldest first
        self.prev_close = None
        self.abs_returns = []     # |1m return| in bps, last VOL_WINDOW bars
        self.peak_since_entry = None
        self.cooldown_left = 0

    def push(self, close):
        self.fast.step(close)
        self.slow.step(close)
        if self.prev_close is not None and self.prev_close > 0:
            move_bps = abs(close - self.prev_close) * 10000.0 / self.prev_close
            self.abs_returns.append(move_bps)
            if len(self.abs_returns) > VOL_WINDOW:
                self.abs_returns.pop(0)
        self.prev_close = close
        self.closes.append(close)

    def donchian_high(self):
        """Highest close of the last DONCHIAN_BARS bars, excluding this bar."""
        window = self.closes[-DONCHIAN_BARS - 1:-1]
        if len(window) < DONCHIAN_BARS:
            return None
        return max(window)

    def mean_abs_return_bps(self):
        if len(self.abs_returns) < VOL_WINDOW:
            return None
        return sum(self.abs_returns) / len(self.abs_returns)

    def trend_up(self):
        if self.fast.value is None or self.slow.value is None:
            return False
        return self.fast.value > self.slow.value

    def trend_down(self):
        if self.fast.value is None or self.slow.value is None:
            return False
        return self.fast.value < self.slow.value


series = {}


def on_batch(state, batch):
    if state.warming_up:
        return []
    fresh = set()
    for bar in batch["bars"]:
        symbol = bar["symbol"]
        if symbol != SYMBOL:
            continue
        fresh.add(symbol)
        s = series.get(symbol)
        if s is None:
            s = Series()
            series[symbol] = s
        s.push(float(bar["c"]))
        if s.cooldown_left > 0:
            s.cooldown_left -= 1
    if SYMBOL not in fresh:
        return []

    s = series[SYMBOL]
    held = state.positions.get(SYMBOL)
    close = state.close(SYMBOL)
    if close is None:
        return []

    orders = []
    if held is not None:
        # --- exit checks, whole position ---
        value = state.value(SYMBOL, held.qty)
        cost = held.cost
        if s.peak_since_entry is None or close > s.peak_since_entry:
            s.peak_since_entry = close
        stop_hit = value * 10000 <= cost * (10000 - STOP_BPS)
        profit_hit = value * 10000 >= cost * (10000 + TAKE_PROFIT_BPS)
        trail_hit = close * 10000 <= s.peak_since_entry * (10000 - TRAIL_BPS)
        if s.trend_down() or stop_hit or profit_hit or trail_hit:
            orders.append({
                "side": "sell",
                "symbol": SYMBOL,
                "qty": held.qty,
                "max_slippage_bps": MAX_SLIPPAGE_BPS,
            })
            s.peak_since_entry = None
            s.cooldown_left = COOLDOWN_BARS
        return orders

    # --- entry checks, flat ---
    if s.cooldown_left > 0:
        return []
    if not s.trend_up():
        return []
    high = s.donchian_high()
    if high is None or close < high:
        return []
    vol = s.mean_abs_return_bps()
    if vol is None or vol < VOL_MIN_BPS:
        return []

    room = state.weight_room(SYMBOL)
    notional = min(state.cash, room)
    if notional <= 0 or notional < int(state.hello["fees"]["min_notional_quote_units"]):
        return []
    s.peak_since_entry = close
    return [{
        "side": "buy",
        "symbol": SYMBOL,
        "notional_quote_units": notional,
        "max_slippage_bps": MAX_SLIPPAGE_BPS,
    }]


makefun_bars.run(on_batch)
