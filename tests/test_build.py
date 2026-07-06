"""Tests for the static-site builder (web/data shards)."""
import json
from pathlib import Path

from finweb.build import build, curated_annual, julian_day, shard, shard_rel_path, verify
from finfacts.model import Entity, FactSet, FinFact, Period, Source, cid

SRC = Source(kind="sec-companyfacts", ref="0000320193-25-000073", fetched="2026-07-06")


def _fact(concept, value, end, start=None, fp="FY", fy=2025, unit="USD"):
    return FinFact(
        entity_id="ticker:AAPL US",
        concept=concept,
        value=value,
        unit=unit,
        period=Period(end=end, start=start, fiscal_year=fy, fiscal_period=fp),
        source=SRC,
    )


def _factset():
    fs = FactSet(entity=Entity(ticker="AAPL US", name="Apple Inc", country="US", cik="320193"))
    fs.add(_fact("us-gaap:Revenues", 391_035_000_000, "2025-09-27", "2024-09-29"))
    fs.add(_fact("us-gaap:Revenues", 383_285_000_000, "2024-09-28", "2023-10-01", fy=2024))
    fs.add(_fact("us-gaap:Assets", 364_980_000_000, "2025-09-27"))
    # quarterly row must not appear in the annual table
    fs.add(_fact("us-gaap:Revenues", 94_930_000_000, "2025-06-28", "2025-03-30", fp="Q3"))
    return fs


def test_curated_annual_selects_annual_rows_only():
    rows = curated_annual(_factset())
    concepts = {(f.concept, f.period.end) for f in rows}
    assert ("us-gaap:Revenues", "2025-09-27") in concepts
    assert ("us-gaap:Revenues", "2024-09-28") in concepts
    assert ("us-gaap:Assets", "2025-09-27") in concepts
    assert not any(f.period.fiscal_period == "Q3" for f in rows)


def test_shard_carries_cid_and_provenance():
    doc = shard(_factset().entity, _factset())
    assert doc["entity"]["ticker"] == "AAPL US"
    for fact in doc["facts"]:
        claimed = fact.pop("cid")
        assert fact.pop("jdn") == julian_day(fact["period"]["end"])
        assert cid(fact) == claimed
        assert fact["source"]["kind"] == "sec-companyfacts"
        assert fact["source"]["ref"]


def test_julian_day_known_values():
    assert julian_day("2000-01-01") == 2451545
    assert julian_day("1970-01-01") == 2440588
    assert julian_day("2026-07-06") == 2461228
    # strictly increasing across a month/year boundary
    assert julian_day("2025-12-31") + 1 == julian_day("2026-01-01")


def test_curated_includes_capex_and_opex():
    fs = _factset()
    fs.add(_fact("us-gaap:PaymentsToAcquirePropertyPlantAndEquipment", 11_000_000_000, "2025-09-27", "2024-09-29"))
    fs.add(_fact("us-gaap:OperatingExpenses", 57_000_000_000, "2025-09-27", "2024-09-29"))
    concepts = {f.concept for f in curated_annual(fs)}
    assert "us-gaap:PaymentsToAcquirePropertyPlantAndEquipment" in concepts
    assert "us-gaap:OperatingExpenses" in concepts


def test_shard_rel_path_layout():
    assert shard_rel_path("AAPL US") == "companies/AA/AAPL_US.json"
    assert shard_rel_path("BRK/B US") == "companies/BR/BRK-B_US.json"


def _universe_csv(tmp_path):
    p = tmp_path / "universe.csv"
    p.write_text(
        "ticker,asset,country,name,active,first_seen,last_seen\n"
        "AAPL US,equity,US,Apple Inc,1,2000-01-01,2026-07-01\n"
        "ASML NA,equity,NL,ASML Holding,1,2000-01-01,2026-07-01\n"
        "BTC CRYPTO,crypto,,Bitcoin,1,2015-01-01,2026-07-01\n"
    )
    return p


def test_build_is_deterministic(tmp_path):
    uni = _universe_csv(tmp_path)
    a, b = tmp_path / "a", tmp_path / "b"
    build(a, universe_path=uni)
    build(b, universe_path=uni)
    fa = sorted(p.relative_to(a) for p in a.rglob("*.json"))
    fb = sorted(p.relative_to(b) for p in b.rglob("*.json"))
    assert fa == fb
    for rel in fa:
        assert (a / rel).read_bytes() == (b / rel).read_bytes()


def test_build_and_verify_roundtrip(tmp_path):
    uni = _universe_csv(tmp_path)
    out = tmp_path / "data"
    meta = build(out, universe_path=uni)
    assert meta["companies"] == 3
    idx = json.loads((out / "index/search.json").read_text())
    assert ["AAPL US", "Apple Inc", "US", 1, "equity"] in idx["rows"]
    assert ["BTC CRYPTO", "Bitcoin", "", 1, "crypto"] in idx["rows"]
    btc = json.loads((out / "companies/BT/BTC_CRYPTO.json").read_text())
    assert btc["entity"]["asset"] == "crypto"
    assert (out / "companies/AA/AAPL_US.json").exists()
    assert verify(out) == 0


def test_verify_catches_tampering(tmp_path):
    out = tmp_path / "data"
    build(out, universe_path=_universe_csv(tmp_path))
    shard_path = out / "companies/AA/AAPL_US.json"
    doc = json.loads(shard_path.read_text())
    doc["facts"] = [
        {"cid": "ff1:" + "0" * 64, "concept": "us-gaap:Revenues", "value": 1, "scale": 0,
         "unit": "USD", "entity_id": "ticker:AAPL US", "derived_from": [],
         "period": {"end": "2025-09-27"},
         "source": {"kind": "sec-companyfacts", "ref": "x", "fetched": "2026-07-06"}}
    ]
    shard_path.write_text(json.dumps(doc))
    assert verify(out) > 0
