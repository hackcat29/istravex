"""Python conformance runner for stellar-xdr (the package replacing py-stellar-base's XDR module).

Per fixture: decode, byte-exact re-encode, and for the generic profiles (tx,
ledger) named checks read from the package's SEP-51 JSON against Horizon's
values. Files marked `expect: decode_error` pass when decoding fails cleanly.
The package has no high-level forms (no transaction builder, no native value
conversion), so the hand-written patterns' native checks are n/a here.

    .cache/py/bin/python kit/runners/python-xdr/run.py [corpus dir]
writes <corpus>/results/python-xdr.json.
"""

import hashlib
import json
import platform
import sys
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path

import stellar_strkey
import stellar_xdr as x

ROOT = Path(__file__).resolve().parents[3]
CORPUS = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "corpus"
PASSPHRASE = {"pubnet": "Public Global Stellar Network ; September 2015", "testnet": "Test SDF Network ; September 2015", "local": "Standalone Network ; February 2017"}
PROFILES = {"tx", "ledger"}


def passphrase(m):
    return ((m.get("source") or {}).get("generator") or {}).get("network_passphrase") or PASSPHRASE.get(m["network"])


def codec(t):
    return getattr(x, t)


def g_account(addr: str) -> str:
    """The G-address of a G- or M-address."""
    if addr.startswith("M"):
        return stellar_strkey.MuxedAccountEd25519.from_string(addr).ed25519_public_key().to_string() if hasattr(stellar_strkey, "MuxedAccountEd25519") else addr
    return addr


def arm(v) -> str:
    """A union's arm name in SEP-51 JSON: the key, or the string for a void arm."""
    return v if isinstance(v, str) else next(iter(v))


def tx_parts(env_json):
    """(transaction that carries the operations, its outer envelope, the tagged transaction to hash)."""
    if "tx_fee_bump" in env_json:
        outer = env_json["tx_fee_bump"]
        return outer["tx"]["inner_tx"]["tx"]["tx"], outer, {"tx_fee_bump": outer["tx"]}
    if "tx_v0" in env_json:
        outer = env_json["tx_v0"]
        v0 = outer["tx"]
        tb = v0.get("time_bounds")
        tx = {
            "source_account": str(stellar_strkey.Ed25519PublicKey(bytes.fromhex(v0["source_account_ed25519"]))),
            "fee": v0["fee"],
            "seq_num": v0["seq_num"],
            "cond": {"time": tb} if tb else "none",
            "memo": v0["memo"],
            "operations": v0["operations"],
            "ext": "v0",
        }
        return v0, outer, {"tx": tx}
    outer = env_json["tx"]
    return outer["tx"], outer, {"tx": outer["tx"]}


def tx_profile(m, dec):
    e = m.get("expected_decoded") or {}
    env = dec["envelope"].to_json_value()
    res = dec["result"].to_json_value()
    tx, outer, tagged = tx_parts(env)

    def tx_hash():
        payload = x.TransactionSignaturePayload.from_json_value({"network_id": hashlib.sha256(passphrase(m).encode()).hexdigest(), "tagged_transaction": tagged})
        return hashlib.sha256(payload.to_xdr_bytes()).hexdigest()

    rows = [
        ("tx_hash", e.get("tx_hash"), tx_hash),
        ("successful", str(e.get("successful")).lower(), lambda: str(arm(res["result"]) in ("tx_success", "tx_fee_bump_inner_success")).lower()),
        ("source_account", e.get("source_account"), lambda: g_account(tx.get("source_account") or str(stellar_strkey.Ed25519PublicKey(bytes.fromhex(tx["source_account_ed25519"]))))),
        ("fee_charged", e.get("fee_charged"), lambda: str(res["fee_charged"])),
        ("max_fee", e.get("max_fee"), lambda: str(outer["tx"]["fee"])),
        ("operation_count", e.get("operation_count"), lambda: str(len(tx["operations"]))),
        ("operation_types", e.get("operation_types"), lambda: ",".join(arm(o["body"]) for o in tx["operations"])),
        ("memo_type", e.get("memo_type"), lambda: arm(tx["memo"])),
        ("signature_count", e.get("signature_count"), lambda: str(len(outer["signatures"]))),
    ]
    if "fee_account" in e:
        rows.append(("fee_account", e["fee_account"], lambda: g_account(env["tx_fee_bump"]["tx"]["fee_source"])))
    return rows


def ledger_profile(m, dec):
    e = m.get("expected_decoded") or {}
    lcm = dec["ledger"].to_json_value()
    body = lcm[next(iter(lcm))]
    h = body["ledger_header"]["header"]
    closed = datetime.fromtimestamp(int(h["scp_value"]["close_time"]), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return [
        ("ledger_hash", e.get("ledger_hash"), lambda: hashlib.sha256(x.LedgerHeader.from_json_value(h).to_xdr_bytes()).hexdigest()),
        ("prev_hash", e.get("prev_hash"), lambda: h["previous_ledger_hash"]),
        ("sequence", e.get("sequence"), lambda: str(h["ledger_seq"])),
        ("protocol_version", e.get("protocol_version"), lambda: str(h["ledger_version"])),
        ("base_fee", e.get("base_fee"), lambda: str(h["base_fee"])),
        ("base_reserve", e.get("base_reserve"), lambda: str(h["base_reserve"])),
        ("max_tx_set_size", e.get("max_tx_set_size"), lambda: str(h["max_tx_set_size"])),
        ("transaction_count", e.get("transaction_count"), lambda: str(len(body["tx_processing"]))),
        ("closed_at", e.get("closed_at"), lambda: closed),
    ]


def run(m, blobs):
    files = m["files"]
    detail, failed = [], []
    if files and all(f.get("expect") == "decode_error" for f in files):
        checks = {"decode": "pass", "reencode": "n/a", "native": "n/a"}
        for f in files:
            try:
                codec(f["xdr_type"]).from_xdr_base64(blobs[f["name"]])
            except Exception:
                continue
            checks["decode"] = "fail"
            failed.append(f"rejects:{f['name']}")
            detail.append(f"{f['name']}: decoded, but must be rejected")
        return checks, failed, detail
    checks = {"decode": "fail", "reencode": "fail", "native": "n/a"}
    try:
        dec = {f["name"]: codec(f["xdr_type"]).from_xdr_base64(blobs[f["name"]]) for f in files}
    except Exception as err:
        detail.append(f"decode: {err!r}"[:200])
        failed.append("decode")
        return checks, failed, detail
    checks["decode"] = "pass"
    bad = [f["name"] for f in files if dec[f["name"]].to_xdr_base64() != blobs[f["name"]]]
    checks["reencode"] = "fail" if bad else "pass"
    if bad:
        failed.append("reencode")
        detail.append("re-encode differs: " + ", ".join(bad))
    if m["pattern"] not in PROFILES:
        return checks, failed, detail
    try:
        rows = tx_profile(m, dec) if m["pattern"] == "tx" else ledger_profile(m, dec)
    except Exception as err:
        detail.append(repr(err)[:200])
        checks["native"] = "fail"
        return checks, failed, detail
    native_failed = []
    for name, expected, observe in rows:
        if expected is None:
            continue
        try:
            got = observe()
        except Exception as err:
            got = f"threw: {err!r}"[:160]
        if str(got) != str(expected):
            native_failed.append(name)
            detail.append(f"{name}: expected {str(expected)[:80]}, got {str(got)[:120]}")
    failed += native_failed
    checks["native"] = "fail" if native_failed else "pass"
    return checks, failed, detail


def main():
    results = []
    for mf in sorted((CORPUS / "fixtures").glob("*/manifest.json")):
        m = json.loads(mf.read_text())
        blobs = {f["name"]: (mf.parent / f["path"]).read_text().strip() for f in m["files"]}
        checks, failed, detail = run(m, blobs)
        results.append({"fixture": m["id"], "checks": checks, "failed": failed, "detail": detail})
        print(f"{m['id']:<44} {json.dumps(checks)} {'; '.join(detail)}")
    out = {
        "sdk": "python-xdr",
        "package": "stellar-xdr",
        "version": version("stellar-xdr"),
        "runtime": f"python {platform.python_version()}",
        "note": "Decode and byte-exact re-encode for every fixture; native checks for the tx and ledger profiles only (the package has no high-level forms).",
        "results": results,
    }
    (CORPUS / "results" / "python-xdr.json").write_text(json.dumps(out, indent=2) + "\n")


if __name__ == "__main__":
    sys.setrecursionlimit(10_000)
    main()
