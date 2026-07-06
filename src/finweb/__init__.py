"""finweb — the FinField explorer: a framework-free static site plus the
deterministic builder that compiles the universe and cached SEC facts into
the content-addressed data shards it serves.

Build with ``python -m finweb.build --out web/data``; recheck every CID and
source block offline with ``python -m finweb.build --verify web/data``.
"""
__version__ = "0.1.0"
