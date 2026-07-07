"""Build the rich /fin data pack from a published FinField feed.

Reads a feed working copy (feed/records-*.jsonl + feed/head.json) and emits a
broad, downloadable per-entity view — every fact the field holds for a
company across every source, grouped and provenance-carried, plus a display
integrity hash any browser can recompute:

    fin/data/meta.json              build + feed head (publisher, root, length)
    fin/data/index.json             [{ticker, name, cik, asset, facts, sources}]
    fin/data/e/{TICKER}.json        entity + all facts, grouped by concept

Unlike a single FactSet shard, an entity pack carries the *whole* fact
history the feed has for that entity — every period, every source (SEC
fundamentals, ESEF, prices, on-chain, macro, identity) — so the explorer can
show the full, broad picture and hand it back as a clean download.

    python -m finweb.fin_pack --feed /path/to/feed-repo --out web/fin/data
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from collections import defaultdict
from pathlib import Path

SCHEMA = 1


def canonical_json(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def display_cid(record: dict) -> str:
    """A browser-recomputable integrity hash: sha256 over the canonical record
    (the record minus any transport-added fields). Lets the page prove the
    bytes it shows are the bytes that were signed, using only SubtleCrypto."""
    core = {k: v for k, v in record.items() if k not in ("sig", "author_pub")}
    return "sha256:" + hashlib.sha256(canonical_json(core).encode()).hexdigest()


def safe_ticker(ticker: str) -> str:
    return ticker.replace(" ", "_").replace("/", "-")


def iter_records(feed_dir: Path):
    for shard in sorted((feed_dir / "feed").glob("records-*.jsonl")):
        with shard.open() as f:
            for line in f:
                line = line.strip()
                if line:
                    yield json.loads(line)


def build(feed_dir: Path, out: Path) -> dict:
    out = Path(out)
    if out.exists():
        shutil.rmtree(out)
    (out / "e").mkdir(parents=True)

    entities: dict[str, dict] = {}
    facts: dict[str, list] = defaultdict(list)
    author = ""  # publisher address on the signed records — the browser needs
                 # it to reconstruct each record and recompute its CID
    for rec in iter_records(feed_dir):
        kind = rec.get("kind")
        if kind == "finfield-entity":
            entities[rec["ticker"]] = rec
        elif kind == "finfact-record":
            eid = rec.get("entity", "")
            ticker = eid.split(":", 1)[-1] if eid.startswith("ticker:") else eid
            facts[ticker].append(rec)
            if not author:
                author = rec.get("author", "")

    head = {}
    hp = feed_dir / "feed" / "head.json"
    if hp.exists():
        head = json.loads(hp.read_text())

    index = []
    for ticker in sorted(set(entities) | set(facts)):
        ent = entities.get(ticker, {"kind": "finfield-entity", "ticker": ticker})
        rows = facts.get(ticker, [])
        # group facts by concept; newest period first within a concept
        by_concept: dict[str, list] = defaultdict(list)
        sources: set = set()
        for r in rows:
            item = {
                "concept": r["concept"],
                "value": r["value"],
                "scale": r.get("scale", 0),
                "unit": r.get("unit", ""),
                "period": r.get("period", {}),
                "source": r.get("source", {}),
                "dimensions": r.get("dimensions", []),
                "derived_from": r.get("derived_from", []),
                "cid": display_cid(r),
            }
            by_concept[r["concept"]].append(item)
            sources.add(r.get("source", {}).get("kind", "?"))
        for c in by_concept:
            by_concept[c].sort(key=lambda x: x["period"].get("end", ""), reverse=True)

        pack = {
            "schema": SCHEMA,
            "entity": {k: v for k, v in ent.items() if k not in ("author", "kind")},
            "author": author,  # publisher address — for client-side CID recompute
            "concepts": dict(sorted(by_concept.items())),
            "sources": sorted(sources),
            "fact_count": len(rows),
        }
        (out / "e" / f"{safe_ticker(ticker)}.json").write_text(
            canonical_json(pack) + "\n", encoding="utf-8")
        index.append({
            "ticker": ticker,
            "name": ent.get("name", ""),
            "cik": ent.get("cik", ""),
            "asset": ent.get("asset", "equity"),
            "facts": len(rows),
            "sources": sorted(sources),
        })

    (out / "index.json").write_text(canonical_json({"schema": SCHEMA, "entities": index}) + "\n")
    meta = {
        "schema": SCHEMA,
        "entities": len(index),
        "facts": sum(e["facts"] for e in index),
        "author": author,  # lets the explorer recompute each fact's CID client-side
        "feed": {"publisher": head.get("feed", ""), "root": head.get("root", ""),
                 "length": head.get("length", 0), "sig": head.get("sig", "")},
        "sources": sorted({s for e in index for s in e["sources"]}),
    }
    (out / "meta.json").write_text(canonical_json(meta) + "\n")
    total = sum(p.stat().st_size for p in out.rglob("*.json"))
    print(f"built {out}: {len(index)} entities, {meta['facts']} facts, "
          f"{total:,} bytes, sources {meta['sources']}")
    return meta


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="finweb.fin_pack")
    p.add_argument("--feed", type=Path, required=True, help="feed repo working copy")
    p.add_argument("--out", type=Path, default=Path("web/fin/data"))
    args = p.parse_args(argv)
    build(args.feed, args.out)


if __name__ == "__main__":
    main()
