"""Cross-sectional risk-factor signals → an expected-return term structure.

The company page's "time/risk-factor graph" is the equity analog of oil's
futures term structure: horizon on X, cumulative expected *excess* return on
Y, built from the asset's cross-sectional exposure to classic risk factors.

From the feed's latest value per concept we compute four point-in-time
factors and z-score each across the whole universe:

  value        book / free-float market cap   (dei:EntityPublicFloat)   HML, +
  earnings     net income / free-float mcap                             +
  profitability operating income / total assets                        RMW, +
  size         -log(free-float mcap)          (small = premium)        SMB, +

Expected annual excess return = Σ zᵢ · premiumᵢ (documented long-run premia,
per 1σ of exposure — an assumption, labelled as such, never a fact). The
"most important prediction" is the factor with the largest signed
contribution. The term structure spreads that annual number linearly over
the horizon with a √t uncertainty band.

Everything is emitted as integer basis points so a reader can recompute it;
these are model *estimates*, kept separate from the signed facts.
"""
from __future__ import annotations

import glob
import json
import math
from collections import defaultdict
from pathlib import Path

# per-1σ annual premium, in basis points — long-run academic estimates, an
# assumption surfaced in the UI, not a measured fact
PREMIUM_BPS = {"value": 200, "earnings": 150, "profitability": 200, "size": 150}
FACTOR_LABEL = {"value": "Value (book / free-float)", "earnings": "Earnings yield",
                "profitability": "Operating profitability", "size": "Size (small-cap)"}
HORIZON_MONTHS = 24
CLIP_BPS = 3000  # ±30%/yr expected-excess ceiling

C_FLOAT = "dei:EntityPublicFloat"
C_EQUITY = "us-gaap:StockholdersEquity"
C_NI = "us-gaap:NetIncomeLoss"
C_OI = "us-gaap:OperatingIncomeLoss"
C_ASSETS = "us-gaap:Assets"


def _latest_by_concept(feed_dir: Path) -> dict:
    """{ticker: {concept: (value*10^-scale, asof_end)}} — latest period wins."""
    need = {C_FLOAT, C_EQUITY, C_NI, C_OI, C_ASSETS}
    out: dict = defaultdict(dict)
    seen_end: dict = defaultdict(dict)
    for shard in sorted((feed_dir / "feed").glob("records-*.jsonl")):
        with open(shard) as f:
            for line in f:
                r = json.loads(line)
                if r.get("kind") != "finfact-record":
                    continue
                c = r["concept"]
                if c not in need:
                    continue
                t = r["entity"].split(":", 1)[-1]
                end = r.get("period", {}).get("end", "")
                if end >= seen_end[t].get(c, ""):  # latest observation wins
                    seen_end[t][c] = end
                    out[t][c] = r["value"] * (10 ** -r.get("scale", 0))
    return out


def _raw_factors(vals: dict) -> dict:
    f = {}
    flt = vals.get(C_FLOAT)
    eq = vals.get(C_EQUITY)
    ni = vals.get(C_NI)
    oi = vals.get(C_OI)
    assets = vals.get(C_ASSETS)
    if flt and flt > 0:
        if eq is not None:
            f["value"] = eq / flt
        if ni is not None:
            f["earnings"] = ni / flt
        f["size"] = -math.log(flt)  # small mcap → high value → positive premium
    if oi is not None and assets and assets > 0:
        f["profitability"] = oi / assets
    return f


def _zscores(raw_by_ticker: dict) -> dict:
    """Winsorized cross-sectional z per factor. Returns {ticker:{factor:z}}."""
    cols: dict = defaultdict(list)
    for vals in raw_by_ticker.values():
        for k, v in vals.items():
            cols[k].append(v)
    stats = {}
    for k, xs in cols.items():
        xs = sorted(xs)
        n = len(xs)
        lo, hi = xs[max(0, n // 100)], xs[min(n - 1, n - 1 - n // 100)]  # 1/99 pct
        clipped = [min(max(x, lo), hi) for x in xs]
        mean = sum(clipped) / n
        var = sum((x - mean) ** 2 for x in clipped) / n if n > 1 else 0.0
        std = math.sqrt(var) or 1.0
        stats[k] = (mean, std, lo, hi)
    z: dict = defaultdict(dict)
    for t, vals in raw_by_ticker.items():
        for k, v in vals.items():
            mean, std, lo, hi = stats[k]
            z[t][k] = (min(max(v, lo), hi) - mean) / std
    return z, {k: sorted(v) for k, v in cols.items()}


def _percentile(sorted_xs: list, x: float, invert: bool) -> int:
    import bisect
    p = bisect.bisect_right(sorted_xs, x) / len(sorted_xs)
    if invert:  # size raw is -log(mcap); a small mcap is a HIGH percentile of "smallness"
        p = p
    return round(100 * p)


def compute_signals(feed_dir: Path) -> dict:
    feed_dir = Path(feed_dir)
    latest = _latest_by_concept(feed_dir)
    raw = {t: _raw_factors(v) for t, v in latest.items()}
    raw = {t: v for t, v in raw.items() if v}
    z, cols = _zscores(raw)

    signals = {}
    for t, zf in z.items():
        factors = []
        exp_bps = 0
        for k, zz in sorted(zf.items()):
            contrib = round(zz * PREMIUM_BPS[k])
            exp_bps += contrib
            # percentile of the SIGNED exposure (higher z = more of the premium)
            pct = _percentile(cols[k], raw[t][k], invert=False)
            factors.append({
                "key": k, "label": FACTOR_LABEL[k],
                "z": round(zz * 1000),  # milli-sigma, integer
                "percentile": pct,
                "premium_bps": PREMIUM_BPS[k],
                "contribution_bps": contrib,
            })
        exp_bps = max(-CLIP_BPS, min(CLIP_BPS, exp_bps))
        dom = max(factors, key=lambda x: abs(x["contribution_bps"]))
        direction = "positive" if dom["contribution_bps"] >= 0 else "negative"
        # term structure: linear-in-time mid, √t band (premium uncertainty)
        band_annual = max(600, abs(exp_bps) // 2)  # ≥6%/yr 1σ band
        term = []
        for m in range(0, HORIZON_MONTHS + 1, 3):
            frac = m / 12.0
            mid = round(exp_bps * frac)
            band = round(band_annual * math.sqrt(frac))
            term.append({"m": m, "mid_bps": mid, "lo_bps": mid - band, "hi_bps": mid + band})
        signals[t] = {
            "expected_annual_bps": exp_bps,
            "dominant": {"key": dom["key"], "label": dom["label"],
                         "direction": direction, "percentile": dom["percentile"],
                         "contribution_bps": dom["contribution_bps"]},
            "factors": factors,
            "term": term,
            "premia_note": "premia are long-run academic estimates per 1σ (assumption, not a fact)",
        }
    return signals


if __name__ == "__main__":
    import sys
    sigs = compute_signals(Path(sys.argv[1]))
    print(f"signals for {len(sigs)} entities")
    for t in ("AAPL US", "MSFT US", "XOM US"):
        s = sigs.get(t)
        if s:
            d = s["dominant"]
            print(f"  {t}: E[excess]={s['expected_annual_bps']/100:.1f}%/yr | "
                  f"top={d['label']} ({d['direction']}, pct {d['percentile']})")
