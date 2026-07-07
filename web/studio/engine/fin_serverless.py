# FinField Studio serverless in-tab API bridge.
#
# Fetched by the engine worker (see fin-engine.js) and executed inside Pyodide
# AFTER the engine wheel (finfacts + finknit + knitweb, the UNCHANGED .py bytes)
# has been installed. It gives the tab ONE in-process peer: a single
# knitweb.fabric.web.Web + a finknit.FinFieldKnitweb built from a device-seed-
# derived key. No HTTP anywhere; the JS shell talks to it over postMessage RPC.
#
# Sacred-invariant discipline: nothing here recomputes CBOR / CID / signature.
# Every weave delegates to the UNCHANGED finknit / finfacts / knitweb code:
#   - fact records + CIDs  -> finknit.FinFieldKnitweb.to_record / emit / weave
#   - canonical bytes      -> knitweb.core.canonical.encode  (floats rejected)
#   - signatures           -> knitweb.fabric.attest.attest   (secp256k1 ECDSA)
#   - the graph            -> knitweb.fabric.web.Web.weave / link
#
# Personhood note: knitweb-vank (the personhood-gated fact poll of
# finknit.vote) is NOT available in-browser — there is no personhood anchor in
# a tab. Verdicts here are therefore *pubkey-weighted signed verdicts*: one
# vote per distinct signer, the latest verdict per author counting. The bridge
# reports mode="signed-verdict" so the UI can be honest about that.

import hashlib
import json

from finfacts.model import Entity, FinFact, Period, Source
from finknit.plugin import KIND_FACT, FinFieldKnitweb, InvariantError, from_record

from knitweb.core import canonical, crypto
from knitweb.fabric.attest import attest
from knitweb.fabric.web import Web

KIND_VERDICT = "finfact-verdict"
KIND_TERM = "knit-term"

# The Studio is a cross-field knitweb surface. A "field" is a domain knitweb;
# any signer can knit new terms into any field. finfield additionally has the
# integer-only fact path (propose). Other fields go through the generic term
# knit — one signed record shape that works for every field.
FIELDS = ("finfield", "chemfield", "intelfield", "ledgerfield")

# Domain-separated KDF: the device seed (32 bytes of WebCrypto CSPRNG, held only
# in this origin's localStorage) is stretched into the wallet private scalar.
# pbkdf2_hmac is Pyodide's OpenSSL hashlib (loaded by the shell); the resulting
# 32 bytes are a secp256k1 private key exactly as knitweb.core.crypto expects.
KDF_SALT = b"finfield:studio:wallet:v1"
KDF_ROUNDS = 100_000


def _priv_from_seed(seed: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", seed.encode(), KDF_SALT, KDF_ROUNDS).hex()


def _require_int(value, field: str) -> int:
    """Accept an integer; reject floats and non-integral strings (signed path is
    integer-only — canonical.encode forbids floats)."""
    if isinstance(value, bool):
        raise InvariantError(f"{field} must be an integer, not a bool")
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        s = value.strip()
        if s and (s[1:] if s[0] in "+-" else s).isdigit():
            return int(s)
        raise InvariantError(
            f"{field} must be a whole (scaled) integer — floats are forbidden on "
            f"the signed path; scale the decimal away instead (got {value!r})")
    if isinstance(value, float):
        raise InvariantError(
            f"{field} must be a whole (scaled) integer — floats are forbidden on "
            f"the signed path; scale the decimal away instead (got {value!r})")
    raise InvariantError(f"{field} must be an integer (got {type(value).__name__})")


class FinBridge:
    """One in-tab FinField peer: a Web + the device wallet, no HTTP anywhere."""

    def __init__(self, seed: str):
        self.seed = seed
        self.priv = _priv_from_seed(seed)
        self.kw = FinFieldKnitweb(self.priv)      # signs + weaves under our key
        self.web = Web()
        self._verdict_seq = 0                     # monotonic; latest per author wins
        self._entity_cids: dict[str, str] = {}    # entity_id -> knit-cid (dedupe)

    # -- account -----------------------------------------------------------
    def _rpc_account(self, _args) -> dict:
        return {"address": self.kw.address, "pubkey": self.kw.author_pub}

    # -- build a FinFact from a plain dict ---------------------------------
    def _fact_from(self, f: dict) -> tuple[Entity, FinFact]:
        ticker = str(f["entity"]).strip()
        if not ticker:
            raise InvariantError("entity (ticker) is required")
        entity = Entity(ticker=ticker, name=str(f.get("name", "")),
                        country=str(f.get("country", "")),
                        asset=str(f.get("asset", "equity")))
        p = f.get("period") or {}
        period = Period(
            end=str(p.get("end", "")),
            start=(str(p["start"]) if p.get("start") else None),
            fiscal_year=(int(p["fy"]) if p.get("fy") not in (None, "") else None),
            fiscal_period=(str(p["fp"]) if p.get("fp") else None),
        )
        s = f.get("source") or {}
        source = Source(kind=str(s.get("kind", "")), ref=str(s.get("ref", "")),
                        fetched=str(s.get("fetched", "")))
        dims = tuple((str(a), str(m)) for a, m in (f.get("dimensions") or ()))
        fact = FinFact(
            entity_id=entity.entity_id,
            concept=str(f["concept"]),
            value=_require_int(f.get("value"), "value"),
            scale=_require_int(f.get("scale", 0), "scale"),
            unit=str(f.get("unit", "")),
            period=period,
            source=source,
            dimensions=dims,
        )
        return entity, fact

    def _weave_fact(self, f: dict) -> dict:
        entity, fact = self._fact_from(f)
        # weave the entity once (idempotent CID) so facts point at a real node
        eid = self._entity_cids.get(entity.entity_id)
        if eid is None:
            eid = self.kw.weave_entity(entity, self.web)
            self._entity_cids[entity.entity_id] = eid
        knit_cid, att = self.kw.weave(fact, self.web)          # signed + woven
        self.web.link(knit_cid, eid, "about")
        return {
            "kind": KIND_FACT,
            "field": "finfield",
            "cid": knit_cid,
            "entity_cid": eid,
            "record": att.record,
            "ticker": entity.ticker,
            "concept": fact.concept,
            "value": fact.value,
            "scale": fact.scale,
            "unit": fact.unit,
            "period_end": fact.period.end,
            "source": {"kind": fact.source.kind, "ref": fact.source.ref},
        }

    # -- propose one finfield fact (integer-only path) ---------------------
    def _rpc_propose(self, args) -> dict:
        return self._weave_fact(args["fact"])

    # -- knit a new term into any field (the generic cross-field path) -----
    def _weave_term(self, t: dict) -> dict:
        field = str(t.get("field", "")).strip()
        if not field:
            raise InvariantError("field is required to knit a term")
        term = str(t.get("term", "")).strip()
        if not term:
            raise InvariantError("term is required")
        rec = {
            "kind": KIND_TERM,
            "field": field,
            "term": term,
            "definition": str(t.get("definition", "")),
            "author": self.kw.address,
        }
        rels = []
        for r in (t.get("relations") or []):
            rel = str(r.get("rel", "")).strip()
            target = str(r.get("target", "")).strip()
            if rel and target:
                rels.append([rel, target])
        if rels:
            rec["relations"] = sorted(rels)     # deterministic: equal knits share a CID
        canonical.encode(rec)                    # fail fast if non-canonical
        att = attest(rec, self.priv, author_field="author")
        cid = self.web.weave(att.record)
        return {"kind": KIND_TERM, "field": field, "cid": cid, "term": term,
                "definition": rec["definition"], "record": att.record}

    def _rpc_knit(self, args) -> dict:
        return self._weave_term(args["term"])

    def _rpc_seed_terms(self, args) -> dict:
        out = []
        for t in args.get("terms", []):
            try:
                out.append(self._weave_term(t))
            except (InvariantError, canonical.CanonicalError, KeyError,
                    ValueError, TypeError) as e:
                out.append({"error": str(e), "term": t.get("term")})
        return {"terms": out}

    # -- seed a handful of facts to vote on --------------------------------
    def _rpc_seed_facts(self, args) -> dict:
        out = []
        for f in args.get("facts", []):
            try:
                out.append(self._weave_fact(f))
            except (InvariantError, canonical.CanonicalError, KeyError,
                    ValueError, TypeError) as e:
                out.append({"error": str(e), "concept": f.get("concept")})
        return {"facts": out}

    # -- cast a signed verdict on a fact CID -------------------------------
    def _rpc_verdict(self, args) -> dict:
        cid = str(args["cid"])
        correct = bool(args["correct"])
        if cid not in self.web.nodes:
            raise InvariantError(f"unknown fact CID: {cid}")
        self._verdict_seq += 1
        rec = {
            "kind": KIND_VERDICT,
            "target": cid,
            "choice": 1 if correct else 0,
            "seq": self._verdict_seq,           # re-votes supersede (highest seq)
            "author": self.kw.address,
        }
        canonical.encode(rec)                    # fail fast if non-canonical
        att = attest(rec, self.priv, author_field="author")
        vcid = self.web.weave(att.record)
        return {"cid": vcid, "mode": "signed-verdict",
                "choice": rec["choice"], **self._tally(cid)}

    # -- tally distinct-author signed verdicts on a fact -------------------
    def _tally(self, cid: str) -> dict:
        latest: dict[str, tuple[int, int]] = {}   # author -> (seq, choice)
        for rec in self.web.nodes.values():
            if rec.get("kind") != KIND_VERDICT or rec.get("target") != cid:
                continue
            author = rec.get("author", "")
            seq = int(rec.get("seq", 0))
            if author not in latest or seq > latest[author][0]:
                latest[author] = (seq, int(rec.get("choice", 0)))
        yes = sum(1 for _seq, ch in latest.values() if ch == 1)
        no = sum(1 for _seq, ch in latest.values() if ch == 0)
        verdict = None if yes == no else (yes > no)
        return {"yes": yes, "no": no, "verdict": verdict, "voters": len(latest)}

    def _rpc_tally(self, args) -> dict:
        return self._tally(str(args["cid"]))

    # -- export everything this tab wove as JSONL --------------------------
    def _rpc_export(self, _args) -> dict:
        lines = []
        for cid, rec in self.web.nodes.items():
            lines.append(json.dumps({"cid": cid, "record": rec},
                                    sort_keys=True, separators=(",", ":")))
        return {"jsonl": "\n".join(lines), "count": len(lines)}

    # -- read a woven fact back (round-trip proof) -------------------------
    def _rpc_read(self, args) -> dict:
        rec = self.web.nodes.get(str(args["cid"]))
        if rec is None:
            raise InvariantError("unknown CID")
        if rec.get("kind") == KIND_FACT:
            fact = from_record(rec)               # inverse of to_record
            return {"kind": KIND_FACT, "concept": fact.concept,
                    "value": fact.value, "unit": fact.unit,
                    "decimal": str(fact.decimal)}
        return {"kind": rec.get("kind"), "record": rec}

    # -- RPC entry point ---------------------------------------------------
    def dispatch(self, method: str, args_json: str) -> str:
        try:
            args = json.loads(args_json) if args_json else {}
            fn = getattr(self, "_rpc_" + method, None)
            if fn is None:
                return json.dumps({"ok": False, "error": "unknown method: " + method})
            return json.dumps({"ok": True, "result": fn(args)})
        except (InvariantError, canonical.CanonicalError, KeyError, ValueError,
                TypeError) as e:
            return json.dumps({"ok": False, "error": str(e)})


def make_bridge(seed: str) -> FinBridge:
    return FinBridge(str(seed))
