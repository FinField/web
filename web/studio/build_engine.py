#!/usr/bin/env python3
"""Build the FinField Studio serverless engine wheel the dapp boots from.

The browser shell (``web/studio/fin-engine.js``) installs ONE wheel,
``engine/finfield_engine-0.0.0-py3-none-any.whl``, into Pyodide — the UNCHANGED
pure-Python ``finfacts`` + ``finknit`` + ``knitweb`` packages. Shipping the exact
``.py`` bytes is what makes every node that ingests the same filing mint the
byte-identical CIDv1 (finfacts README). This script assembles that wheel
reproducibly from the live sources, so the Studio always runs the current engine
instead of a stale hand-built artifact.

All three packages are stdlib-only pure Python; the one compiled dependency
(``cryptography`` for secp256k1/SHA-256, which ``knitweb.core.crypto`` imports)
is installed separately by the shell via micropip, so this wheel needs no binary
content.

Source resolution (each independently overridable):
    FINFACTS_SRC   -> package parent of finfacts/   (github.com/FinField/facts)
    FINKNIT_SRC    -> package parent of finknit/     (github.com/FinField/knit)
    KNITWEB_SRC    -> package parent of knitweb/      (github.com/knitweb/pulse)
Missing sources are git-cloned into a temp dir so the build works on a bare CI.

Usage:
    python3 web/fin/build_engine.py
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent          # .../web/fin
WHEEL_NAME = "finfield_engine-0.0.0-py3-none-any.whl"
OUT_DIR = HERE / "engine"

# (package, env var, candidate source parents, clone url) — a "source parent" is
# the directory that CONTAINS the importable package dir (e.g. .../src).
SOURCES = [
    ("finfacts", "FINFACTS_SRC",
     ["/tmp/finfacts-repo/src", "/tmp/facts/src"],
     "https://github.com/FinField/facts"),
    ("finknit", "FINKNIT_SRC",
     ["/tmp/finknit-repo/src", "/tmp/knit/src"],
     "https://github.com/FinField/knit"),
    ("knitweb", "KNITWEB_SRC",
     ["/tmp/pulse-work/src", "/tmp/pulse/src", "/tmp/pulse-clean/src"],
     "https://github.com/knitweb/pulse"),
]

PYPROJECT = """\
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "finfield_engine"
version = "0.0.0"
description = "FinField Studio serverless engine bundle — finfacts + finknit + knitweb pure-Python for Pyodide"
requires-python = ">=3.11"

[tool.setuptools]
include-package-data = true

[tool.setuptools.packages.find]
where = ["."]
include = ["finfacts*", "finknit*", "knitweb*"]

[tool.setuptools.package-data]
finfacts = ["data/*.csv"]
"""


def _resolve(pkg: str, env: str, candidates: list[str], clone_url: str,
             clone_root: Path) -> Path:
    """Return a source-parent dir that contains ``pkg``/__init__.py."""
    tried = []
    for cand in ([os.environ[env]] if os.environ.get(env) else []) + candidates:
        p = Path(cand)
        tried.append(str(p))
        if (p / pkg / "__init__.py").is_file():
            return p
    # Not found locally — clone the public repo into the build temp dir.
    dest = clone_root / pkg
    print(f"  {pkg}: not found locally ({', '.join(tried)}); cloning {clone_url}")
    subprocess.run(["git", "clone", "--depth", "1", clone_url, str(dest)], check=True)
    for parent in (dest / "src", dest):
        if (parent / pkg / "__init__.py").is_file():
            return parent
    raise SystemExit(f"cloned {clone_url} but {pkg}/__init__.py not found")


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        stage = Path(tmp) / "stage"
        stage.mkdir()
        clone_root = Path(tmp) / "clones"
        clone_root.mkdir()

        for pkg, env, candidates, url in SOURCES:
            src_parent = _resolve(pkg, env, candidates, url, clone_root)
            shutil.copytree(src_parent / pkg, stage / pkg,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            print(f"staged {pkg} from {src_parent}")

        (stage / "pyproject.toml").write_text(PYPROJECT, encoding="utf-8")

        print(f"building {WHEEL_NAME} …")
        subprocess.run(
            [sys.executable, "-m", "build", "--wheel", "--outdir", str(stage / "dist")],
            cwd=stage, check=True)

        built = sorted((stage / "dist").glob("finfield_engine-*.whl"))
        if not built:
            raise SystemExit("wheel build produced no output")
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        target = OUT_DIR / WHEEL_NAME
        shutil.copyfile(built[0], target)
        size_kb = target.stat().st_size // 1024
        print(f"wrote {target}  ({size_kb} KiB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
