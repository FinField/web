"""Static-site builder: universe + cached SEC facts -> web/data shards.

Compiles the FinField universe into the sharded JSON the static site serves:

    web/data/meta.json                     build counts + schema version
    web/data/index/search.json             [[ticker, name, country, active], ...]
    web/data/companies/{P2}/{TICKER}.json  one shard per company

A shard carries the entity, its curated base facts and derived metrics; every
fact is serialized with its CID and full source block, so the site can render
per-fact provenance and any reader can recompute the hashes offline
(`python -m finweb.build --verify web/data`).

The build is a pure function of the universe file and the local SEC cache:
same inputs -> byte-identical output tree.

    python -m finweb.build --out web/data
    python -m finweb.build --out web/data --facts "AAPL US,MSFT US" --fetch
    python -m finweb.build --verify web/data
"""
from __future__ import annotations

import argparse
import csv
import json
import shutil
import sys
from pathlib import Path
from typing import Iterable, Optional

from finfacts import universe as universe_mod
from finfacts.derive import derive_all
from finfacts.model import Entity, FactSet, FinFact, canonical_json, cid

SCHEMA = 1
MAX_TOTAL_BYTES = 900 * 1024 * 1024
MAX_FILE_BYTES = 90 * 1024 * 1024
YEARS_KEPT = 12

# curated statement lines shown on the company page (first matching tag wins)
CURATED = {
    "revenue": (
        "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
        "us-gaap:Revenues",
        "us-gaap:SalesRevenueNet",
    ),
    "net_income": ("us-gaap:NetIncomeLoss",),
    "operating_income": ("us-gaap:OperatingIncomeLoss",),
    "total_assets": ("us-gaap:Assets",),
    "total_liabilities": ("us-gaap:Liabilities",),
    "equity": (
        "us-gaap:StockholdersEquity",
        "us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ),
    "cash": ("us-gaap:CashAndCashEquivalentsAtCarryingValue",),
    "capex": ("us-gaap:PaymentsToAcquirePropertyPlantAndEquipment",),
    "opex": ("us-gaap:OperatingExpenses", "us-gaap:CostsAndExpenses"),
    "shares_outstanding": (
        "dei:EntityCommonStockSharesOutstanding",
        "us-gaap:CommonStockSharesOutstanding",
    ),
}


def julian_day(iso_date: str) -> int:
    """Julian day number of an ISO date (proleptic Gregorian, integer).

    Time-varying facts (shares outstanding, supply) join across datasets on
    this integer axis; it is derived from period.end, never stored in the
    CID payload.
    """
    y, m, d = (int(p) for p in iso_date.split("-"))
    a = (14 - m) // 12
    y2 = y + 4800 - a
    m2 = m + 12 * a - 3
    return d + (153 * m2 + 2) // 5 + 365 * y2 + y2 // 4 - y2 // 100 + y2 // 400 - 32045


def safe_ticker(ticker: str) -> str:
    return ticker.replace(" ", "_").replace("/", "-")


def shard_rel_path(ticker: str) -> str:
    name = safe_ticker(ticker)
    return f"companies/{name[:2].upper()}/{name}.json"


def _is_annual(f: FinFact) -> bool:
    if f.period.fiscal_period != "FY":
        return False
    if f.period.is_instant:
        return True
    from datetime import date

    days = (date.fromisoformat(f.period.end) - date.fromisoformat(f.period.start)).days
    return 300 <= days <= 400


def curated_annual(fs: FactSet) -> list[FinFact]:
    """Latest-restatement annual observation per curated line per year."""
    out: list[FinFact] = []
    for line, tags in CURATED.items():
        for tag in tags:
            rows = [f for f in fs.facts if f.concept == tag and _is_annual(f) and f.period.end]
            if not rows:
                continue
            per_year: dict[str, FinFact] = {}
            for f in sorted(rows, key=lambda f: f.source.ref):
                per_year[f.period.end[:4]] = f  # latest accession wins
            out.extend(sorted(per_year.values(), key=lambda f: f.period.end)[-YEARS_KEPT:])
            break
    return out


def fact_json(f: FinFact) -> dict:
    doc = {"cid": f.cid, **f.payload()}
    if f.period.end:
        doc["jdn"] = julian_day(f.period.end)
    return doc


def shard(entity: Entity, facts: Optional[FactSet] = None) -> dict:
    doc: dict = {
        "schema": SCHEMA,
        "entity": {
            k: v
            for k, v in (
                ("ticker", entity.ticker),
                ("name", entity.name),
                ("country", entity.country),
                ("asset", entity.asset),
                ("cik", entity.cik),
                ("lei", entity.lei),
                ("figi", entity.figi),
            )
            if v
        },
        "facts": [],
        "derived": [],
    }
    if facts is not None:
        doc["facts"] = [fact_json(f) for f in curated_annual(facts)]
        doc["derived"] = [fact_json(f) for f in derive_all(facts)]
    return doc


def _write(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(canonical_json(doc) + "\n", encoding="utf-8")


def _search_rows(universe_path: Optional[Path]) -> list[list]:
    src = Path(universe_path) if universe_path else universe_mod.DEFAULT_UNIVERSE
    rows = []
    with src.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rows.append(
                [
                    row["ticker"],
                    row.get("name", "") or "",
                    row.get("country", "") or "",
                    1 if row.get("active") == "1" else 0,
                    row.get("asset") or "equity",  # asset class: equity | crypto
                ]
            )
    rows.sort(key=lambda r: r[0])
    return rows


def build(
    out_dir: Path,
    universe_path: Optional[Path] = None,
    fact_tickers: Iterable[str] = (),
    cache_dir: Optional[Path] = None,
    fetch: bool = False,
    limit: Optional[int] = None,
) -> dict:
    out = Path(out_dir)
    if out.exists():
        shutil.rmtree(out)
    rows = _search_rows(universe_path)
    if limit:
        rows = rows[:limit]
    _write(out / "index/search.json", {"schema": SCHEMA, "rows": rows})

    wanted = {t.strip() for t in fact_tickers if t.strip()}
    factsets: dict[str, FactSet] = {}
    if wanted:
        from finscrapers.sec_edgar import SecEdgarSource

        src = SecEdgarSource(cache_dir=cache_dir)
        for ticker in sorted(wanted):
            ent = Entity(ticker=ticker)
            cik = src.resolve_cik(ent) if (fetch or cache_dir) else None
            if cik is None:
                print(f"  skip {ticker}: no CIK", file=sys.stderr)
                continue
            cached = cache_dir and (Path(cache_dir) / f"CIK{cik:010d}.json").exists()
            if not fetch and not cached:
                print(f"  skip {ticker}: not cached (pass --fetch)", file=sys.stderr)
                continue
            fs = src.fetch(Entity(ticker=ticker, cik=str(cik)))
            if fs is not None:
                factsets[ticker] = fs

    with_facts = fact_count = 0
    for row in rows:
        ticker = row[0]
        fs = factsets.get(ticker)
        ent = Entity(
            ticker=ticker,
            name=row[1],
            country=row[2],
            asset=row[4],
            cik=fs.entity.cik if fs else None,
        )
        doc = shard(ent, fs)
        if doc["facts"]:
            with_facts += 1
            fact_count += len(doc["facts"]) + len(doc["derived"])
        _write(out / shard_rel_path(ticker), doc)

    meta = {"schema": SCHEMA, "companies": len(rows), "with_facts": with_facts, "facts": fact_count}
    _write(out / "meta.json", meta)
    _guard_sizes(out)
    return meta


def _guard_sizes(out: Path) -> None:
    total = biggest = 0
    top: list[tuple[int, str]] = []
    for p in out.rglob("*.json"):
        n = p.stat().st_size
        total += n
        biggest = max(biggest, n)
        top.append((n, str(p.relative_to(out))))
    top.sort(reverse=True)
    if total > MAX_TOTAL_BYTES or biggest > MAX_FILE_BYTES:
        for n, name in top[:10]:
            print(f"  {n:>12,}  {name}", file=sys.stderr)
        raise SystemExit(f"size guard: total={total:,} max_file={biggest:,}")
    print(f"built {out}: {total:,} bytes, largest file {biggest:,}")


def verify(data_dir: Path) -> int:
    """Recompute every fact CID and check provenance completeness."""
    bad = 0
    for p in sorted(Path(data_dir).rglob("companies/*/*.json")):
        doc = json.loads(p.read_text())
        for fact in doc.get("facts", []) + doc.get("derived", []):
            claimed = fact.pop("cid")
            fact.pop("jdn", None)  # derived display field, not part of the CID payload
            if cid(fact) != claimed:
                print(f"CID mismatch in {p}: {claimed}", file=sys.stderr)
                bad += 1
            src = fact.get("source", {})
            if not src.get("kind") or (src["kind"] != "finfield-derived" and not src.get("ref")):
                print(f"missing provenance in {p}: {fact.get('concept')}", file=sys.stderr)
                bad += 1
    return bad


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="finweb.build", description=__doc__)
    p.add_argument("--out", type=Path, help="output data dir (e.g. web/data)")
    p.add_argument("--universe", type=Path, help="universe CSV (default: packaged)")
    p.add_argument("--facts", default="", help="comma-separated tickers to include SEC facts for")
    p.add_argument("--facts-file", type=Path, help="file with one ticker per line")
    p.add_argument("--cache", type=Path, help="SEC cache dir")
    p.add_argument("--fetch", action="store_true", help="allow network fetches for --facts")
    p.add_argument("--limit", type=int, help="cap universe size (testing)")
    p.add_argument("--verify", type=Path, metavar="DATA_DIR", help="verify CIDs + provenance")
    args = p.parse_args(argv)

    if args.verify:
        bad = verify(args.verify)
        if bad:
            raise SystemExit(f"{bad} verification failures")
        print("verify: all CIDs and provenance OK")
        return
    if not args.out:
        p.error("--out is required (or use --verify)")
    tickers = [t for t in args.facts.split(",") if t.strip()]
    if args.facts_file:
        tickers += [l.strip() for l in args.facts_file.read_text().splitlines() if l.strip()]
    meta = build(
        args.out,
        universe_path=args.universe,
        fact_tickers=tickers,
        cache_dir=args.cache,
        fetch=args.fetch,
        limit=args.limit,
    )
    print(canonical_json(meta))


if __name__ == "__main__":
    main()
