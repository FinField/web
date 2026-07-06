# finweb

The FinField explorer — a framework-free static site over 20,000+ listed
companies and crypto assets, live at
**[finfield.github.io/web](https://finfield.github.io/web/)**, plus the
deterministic builder that compiles its data.

- **`web/`** — the site: plain HTML/CSS/JS, no framework, no build step.
  Instant search over the whole universe; a company page that renders every
  curated annual fact and derived metric **with its provenance**: source kind,
  SEC accession (linked to the filing), fetch date, CID, and `derived_from`
  links you can click to walk a ratio back to the audited filing.
- **`src/finweb/build.py`** — the shard compiler: universe + cached SEC facts
  → `web/data/` (per-company JSON shards, search index, meta). A pure function
  of its inputs: same universe + same cache → **byte-identical** output tree.
  Values stay exact scaled integers end to end; the browser renders them from
  the integers, no floats anywhere.

## Build the shards

```bash
pip install -e ".[dev]"                       # finfacts comes from ../facts or git

python -m finweb.build --out web/data                              # identity-only universe
python -m finweb.build --out web/data --facts "AAPL US" --fetch    # + SEC facts (needs finscrapers)
python -m finweb.build --out web/data --facts-file web/facts_tickers.txt --cache .cache/sec
python -m finweb.build --verify web/data                           # recompute every CID offline
```

`--verify` re-hashes every fact in the tree and checks each one carries a
complete source block — anyone can audit a deployed site without trusting the
builder. A size guard fails the build before it can outgrow static hosting.

## Serve locally

```bash
python -m http.server -d web    # then open http://localhost:8000/
```

All asset and data URLs are relative, so the site works from any mount path
(GitHub Pages serves it under `/web/`). The built `web/data/` tree is not in
this branch — it is deployed to the `gh-pages` branch.

## Tests

```bash
python -m pytest -q     # offline: synthetic universe + canned facts, no network
```

Part of the [FinField](https://github.com/FinField) field: [facts](https://github.com/FinField/facts) ·
[scrapers](https://github.com/FinField/scrapers) · [knit](https://github.com/FinField/knit) ·
[agents](https://github.com/FinField/agents) · [signals](https://github.com/FinField/signals) ·
[crypto](https://github.com/FinField/crypto)
