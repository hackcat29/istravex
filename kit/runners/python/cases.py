"""Generated cases through a Python XDR package: every valid case must decode
and re-encode byte for byte; every hostile one (trailing bytes, truncation, an
unknown discriminant) must be refused. Types the package doesn't expose are
counted as unsupported.

    .cache/py/bin/python kit/runners/python/cases.py stellar-sdk   → corpus/results/cases-python.json
    .cache/py/bin/python kit/runners/python/cases.py stellar-xdr   → corpus/results/cases-python-xdr.json
"""

import gzip
import json
import sys
from importlib.metadata import version
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CORPUS = ROOT / "corpus"


def load(package):
    if package == "stellar-sdk":
        from stellar_sdk import xdr

        decode = lambda cls, b64: cls.from_xdr(b64)
        encode = lambda v: v.to_xdr()
        return xdr, decode, encode, "python"
    import stellar_xdr as xdr

    decode = lambda cls, b64: cls.from_xdr_base64(b64)
    encode = lambda v: v.to_xdr_base64()
    return xdr, decode, encode, "python-xdr"


def summarize(results):
    kinds, failing, unsupported = {}, {}, set()
    for r in results:
        k = kinds.setdefault(r["kind"], {"cases": 0, "supported": 0, "passed": 0})
        k["cases"] += 1
        if r["outcome"] == "unsupported":
            unsupported.add(r["type"])
            continue
        k["supported"] += 1
        if r["outcome"] == "pass":
            k["passed"] += 1
        else:
            t = failing.setdefault(r["kind"], {})
            t[r["type"]] = t.get(r["type"], 0) + 1
    fails = [{"type": r["type"], "kind": r["kind"], "b64": r["b64"][:120]} for r in results if r["outcome"] == "fail"][:200]
    return {
        "cases": len(results),
        "supported": sum(k["supported"] for k in kinds.values()),
        "passed": sum(k["passed"] for k in kinds.values()),
        "kinds": kinds,
        "failing_types": {k: dict(sorted(t.items())) for k, t in failing.items()},
        "unsupported_types": sorted(unsupported),
        "failures": fails,
    }


def main():
    package = sys.argv[1] if len(sys.argv) > 1 else "stellar-sdk"
    path = Path(sys.argv[2]) if len(sys.argv) > 2 else CORPUS / "generated" / "cases.jsonl.gz"
    xdr, decode, encode, sdk = load(package)
    by_name = {n.lower(): getattr(xdr, n) for n in dir(xdr) if not n.startswith("_") and isinstance(getattr(xdr, n), type)}
    results = []
    with gzip.open(path, "rt") as f:
        for line in f:
            c = json.loads(line)
            cls = by_name.get(c["type"].lower())
            if cls is None:
                results.append({**c, "outcome": "unsupported"})
                continue
            try:
                value = decode(cls, c["b64"])
            except Exception:
                results.append({**c, "outcome": "fail" if c["kind"] == "valid" else "pass"})
                continue
            if c["kind"] != "valid":
                results.append({**c, "outcome": "fail"})
                continue
            try:
                again = encode(value)
                results.append({**c, "outcome": "pass" if again == c["b64"] else "fail"})
            except Exception:
                results.append({**c, "outcome": "fail"})
    out = {"sdk": sdk, "package": package, "version": version(package), **summarize(results)}
    (CORPUS / "results" / f"cases-{sdk}.json").write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps({k: v for k, v in out.items() if k not in ("failures", "failing_types", "unsupported_types")}))


if __name__ == "__main__":
    sys.setrecursionlimit(20_000)
    main()
