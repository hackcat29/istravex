"""Sweep the Python stellar-sdk over whole ledgers of real traffic.

For every LedgerCloseMetaBatch file given (raw XDR): the batch decodes and
re-encodes byte for byte, and the hash the SDK computes for every transaction
in the transaction set equals the hash stellar-core recorded for it in the
ledger's results. Both oracles are stellar-core's own bytes.

    .cache/py/bin/python kit/runners/python/sweep.py "<passphrase>" ledger1.xdr ... > sweep-python.json
"""

import json
import sys
from importlib.metadata import version
from pathlib import Path

from stellar_sdk import TransactionBuilder, xdr


def envelopes(node, out, depth=0):
    """Every TransactionEnvelope in a transaction set, whatever its shape."""
    if depth > 64 or node is None:
        return out
    if isinstance(node, xdr.TransactionEnvelope):
        out.append(node)
        return out
    if isinstance(node, (list, tuple)):
        for v in node:
            envelopes(v, out, depth + 1)
        return out
    if hasattr(node, "__dict__"):
        for v in vars(node).values():
            if isinstance(v, (int, str, bytes, bool, float)):
                continue
            envelopes(v, out, depth + 1)
    return out


def main():
    passphrase, files = sys.argv[1], sys.argv[2:]
    failures, counts = [], {"ledgers": 0, "transactions": 0, "checks": 0, "passed": 0}

    def check(ledger, name, ok, detail):
        counts["checks"] += 1
        if ok:
            counts["passed"] += 1
        elif len(failures) < 50:
            failures.append({"ledger": ledger, "check": name, "detail": detail})

    for path in files:
        raw = Path(path).read_bytes()
        try:
            batch = xdr.LedgerCloseMetaBatch.from_xdr_bytes(raw)
        except Exception as err:
            check(Path(path).name, "decode", False, repr(err)[:200])
            continue
        again = batch.to_xdr_bytes()
        check(Path(path).name, "reencode", again == raw, f"{len(again)} vs {len(raw)} bytes")
        for lcm in batch.ledger_close_metas:
            counts["ledgers"] += 1
            body = lcm.v2 or lcm.v1 or lcm.v0
            seq = str(body.ledger_header.header.ledger_seq.uint32)
            want = [t.result.transaction_hash.hash.hex() for t in body.tx_processing]
            envs = envelopes(body.tx_set, [])
            got = set()
            for env in envs:
                try:
                    got.add(TransactionBuilder.from_xdr(env.to_xdr(), passphrase).hash_hex())
                except Exception as err:
                    got.add(f"error: {err!r}")
            counts["transactions"] += len(want)
            for h in want:
                check(seq, "tx_hash", h in got, h)
            check(seq, "tx_count", len(envs) == len(want), f"{len(envs)} envelopes, {len(want)} results")
    print(json.dumps({"sdk": "python", "package": "stellar-sdk", "version": version("stellar-sdk"), **counts, "failures": failures}))


if __name__ == "__main__":
    sys.setrecursionlimit(20_000)
    main()
