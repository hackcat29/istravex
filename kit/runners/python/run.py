"""Python conformance runner (stellar-sdk, py-stellar-base).

Per fixture: decode, byte-exact re-encode, and named "native" checks of the
SDK's high-level forms against the fixture's expected values. Files marked
`expect: decode_error` pass when decoding fails cleanly.

    .cache/py/bin/python kit/runners/python/run.py [corpus dir]
writes <corpus>/results/python.json.
"""

import json
import platform
import sys
from importlib.metadata import version
from decimal import Decimal
from pathlib import Path

import stellar_sdk
from stellar_sdk import (
    Address,
    Asset,
    LiquidityPoolAsset,
    MuxedAccount,
    Network,
    StrKey,
    TransactionBuilder,
    scval,
    xdr,
)

ROOT = Path(__file__).resolve().parents[3]
CORPUS = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "corpus"
PASSPHRASE = {"pubnet": Network.PUBLIC_NETWORK_PASSPHRASE, "testnet": Network.TESTNET_NETWORK_PASSPHRASE, "local": "Standalone Network ; February 2017"}


def passphrase(m):
    return ((m.get("source") or {}).get("generator") or {}).get("network_passphrase") or PASSPHRASE.get(m["network"])


def codec(t):
    return getattr(xdr, t)


def account(acc_id) -> str:
    return StrKey.encode_ed25519_public_key(acc_id.account_id.ed25519.uint256)


def asset_str(a) -> str:
    return "native" if a.is_native() else f"{a.code}:{a.issuer}"


def xdr_asset_str(a) -> str:
    return asset_str(Asset.from_xdr_object(a))


def stroops(n: int) -> str:
    return f"{n // 10_000_000}.{n % 10_000_000:07d}"


def amount7(a) -> str:
    """An SDK amount in Horizon's 7-decimal form (the SDK normalises 70.0000000 to 70)."""
    return f"{Decimal(str(a)):.7f}"


def tx_of(env):
    """The transaction that carries the operations (the inner one for a fee-bump)."""
    t = env.transaction
    return t.inner_transaction_envelope.transaction if hasattr(t, "inner_transaction_envelope") else t


def checks_for(m, blobs, dec):
    e = m.get("expected_decoded") or {}
    ix = m.get("expected_indexed") or {}
    pp = passphrase(m)
    env = lambda: TransactionBuilder.from_xdr(blobs["envelope"], pp)
    p = m["pattern"]

    if p == "muxed-payment":
        i = int(e.get("op_index", 0))
        op = lambda: tx_of(env()).operations[i]
        return [
            ("destination_muxed", e.get("destination_muxed"), lambda: op().destination.account_muxed),
            ("muxed_id", e.get("muxed_id"), lambda: str(op().destination.account_muxed_id)),
            ("destination_account", e.get("destination_account"), lambda: op().destination.account_id),
            ("asset", e.get("asset"), lambda: asset_str(op().asset)),
            ("amount", e.get("amount"), lambda: amount7(op().amount)),
        ]
    if p == "fee-bump":
        return [
            ("tx_hash", e.get("tx_hash"), lambda: env().hash_hex()),
            ("inner_tx_hash", e.get("inner_tx_hash"), lambda: env().transaction.inner_transaction_envelope.hash_hex()),
            ("fee_source", e.get("fee_source"), lambda: env().transaction.fee_source.account_id),
            ("inner_source", e.get("inner_source"), lambda: tx_of(env()).source.account_id),
        ]
    if p == "signed-payload-signer":
        signer = lambda: dec["ledger_entry"].account.signers[0]
        sp = lambda: signer().key.ed25519_signed_payload
        return [
            ("signer_strkey", e.get("signer_strkey"), lambda: StrKey.encode_ed25519_signed_payload(sp().to_xdr_bytes())),
            ("signer_ed25519", e.get("signer_ed25519"), lambda: StrKey.encode_ed25519_public_key(sp().ed25519.uint256)),
            ("payload_hex", e.get("payload_hex"), lambda: sp().payload.hex()),
            ("weight", e.get("weight"), lambda: str(signer().weight.uint32)),
        ]
    if p == "sac-trust":
        def created():
            ops = dec["meta"].v4.operations
            return [c.created.data.trust_line for op in ops for c in op.changes.ledger_entry_changes if c.created and c.created.data.trust_line]
        tl = lambda: created()[0]
        return [
            ("trustline_created", "true", lambda: "true" if len(created()) == 1 else "false"),
            ("account", ix.get("account"), lambda: account(tl().account_id)),
            ("asset", ix.get("asset"), lambda: f"{tl().asset.alpha_num4.asset_code.asset_code4.decode().rstrip(chr(0))}:{account(tl().asset.alpha_num4.issuer)}" if tl().asset.alpha_num4 else "other"),
            ("limit", ix.get("limit"), lambda: str(tl().limit.int64)),
        ]
    if p == "muxed-max-id":
        op = lambda: env().transaction.operations[0]
        return [
            ("source_muxed", e.get("source_muxed"), lambda: env().transaction.source.account_muxed),
            ("source_muxed_id", e.get("source_muxed_id"), lambda: str(env().transaction.source.account_muxed_id)),
            ("source_account", e.get("source_account"), lambda: env().transaction.source.account_id),
            ("destination_muxed_id", e.get("destination_muxed_id"), lambda: str(op().destination.account_muxed_id)),
            ("destination_account", e.get("destination_account"), lambda: op().destination.account_id),
            ("amount", e.get("amount"), lambda: amount7(op().amount)),
            ("muxed_address_roundtrip", e.get("destination_muxed_id"), lambda: str(MuxedAccount.from_account(e["destination_muxed"]).account_muxed_id)),
        ]
    if p == "pool-issuer-order":
        line = lambda: env().transaction.operations[2].asset
        ca, ia = e["asset_a"].split(":")
        cb, ib = e["asset_b"].split(":")
        A, B = Asset(ca, ia), Asset(cb, ib)
        return [
            ("decode_pool_share_op", f"{e['asset_a']}/{e['asset_b']}", lambda: f"{asset_str(line().asset_a)}/{asset_str(line().asset_b)}"),
            ("asset_compare", "-1", lambda: "-1" if LiquidityPoolAsset.is_valid_lexicographic_order(A, B) else "1"),
            ("pool_id", e.get("pool_id"), lambda: LiquidityPoolAsset(A, B).liquidity_pool_id),
        ]
    if p == "memo-non-utf8":
        return [
            ("memo_bytes", e.get("memo_hex"), lambda: dec["envelope"].v1.tx.memo.text.hex()),
            ("transaction_roundtrip", blobs["envelope"], lambda: env().to_xdr()),
        ]
    if p == "max-length-vectors":
        acct = lambda: dec["ledger_entry"].account
        return [
            ("operation_count", e.get("operation_count"), lambda: str(len(dec["envelope"].v1.tx.operations))),
            ("signature_count", e.get("signature_count"), lambda: str(len(dec["envelope_signatures"].v1.signatures))),
            ("signer_count", e.get("signer_count"), lambda: str(len(acct().signers))),
            ("thresholds", ",".join(map(str, e["thresholds"])) if "thresholds" in e else None, lambda: ",".join(str(b) for b in acct().thresholds.thresholds[1:])),
        ]
    if p == "max-amount":
        op = lambda: env().transaction.operations[0]
        return [
            ("amount", e.get("amount"), lambda: amount7(op().amount)),
            ("amount_stroops", e.get("amount_stroops"), lambda: str(dec["envelope"].v1.tx.operations[0].body.payment_op.amount.int64)),
            ("asset", e.get("asset"), lambda: asset_str(op().asset)),
        ]
    if p == "scmap-host-order":
        entries = lambda: dec["ledger_entry"].contract_data.val.map.sc_map
        def keeps_every_entry():
            try:
                native = scval.to_native(dec["ledger_entry"].contract_data.val)
            except Exception:
                return "all entries or an error"
            n = len(native)
            return "all entries or an error" if n == e["entry_count"] else f"{n} of {e['entry_count']} entries, no error"
        return [
            ("entry_count", e.get("entry_count"), lambda: str(len(entries()))),
            ("key_order_preserved", ",".join(e["keys_xdr"]), lambda: ",".join(x.key.to_xdr() for x in entries())),
            ("native_keeps_every_entry", "all entries or an error", keeps_every_entry),
        ]
    if p == "nested-auth":
        def walk():
            root = dec["envelope"].v1.tx.operations[0].body.invoke_host_function_op.auth[0].root_invocation
            depth, count, stack = 0, 0, [(root, 1)]
            while stack:
                inv, d = stack.pop()
                if d > 100:
                    raise ValueError("authorization tree deeper than 100 (the host's own limit)")
                depth, count = max(depth, d), count + 1
                stack.extend((s, d + 1) for s in inv.sub_invocations)
            return depth, count, root
        return [
            ("auth_depth", e.get("auth_depth"), lambda: str(walk()[0])),
            ("auth_invocations", e.get("auth_invocations"), lambda: str(walk()[1])),
            ("root_contract", e.get("root_contract"), lambda: Address.from_xdr_sc_address(walk()[2].function.contract_fn.contract_address).address),
            ("return_value", e.get("return_u32"), lambda: str(dec["meta"].v4.soroban_meta.return_value.u32.uint32)),
        ]
    if p == "muxed-soroban-source":
        src = lambda: MuxedAccount.from_xdr_object(dec["envelope"].v1.tx.source_account)
        return [
            ("source_account", e.get("source_account"), lambda: src().account_id),
            ("source_muxed_id", e.get("source_muxed_id"), lambda: str(src().account_muxed_id)),
            ("operation", e.get("operation"), lambda: "extendFootprintTtl" if dec["envelope"].v1.tx.operations[0].body.extend_footprint_ttl_op else "other"),
        ]
    if p == "tx":
        return tx_profile(m, blobs, dec, pp)
    if p == "ledger":
        return ledger_profile(m, dec)
    raise ValueError(f"no native check for pattern {p}")


# Generic profiles for fixtures chosen by set cover (kit/capture/shapes.mjs).
# Expected values come from Horizon; the SDK reads them from raw XDR.


def env_parts(env):
    """(transaction that carries the operations, envelope that carries the signatures, its fee)."""
    t = env.type.name
    if t == "ENVELOPE_TYPE_TX_FEE_BUMP":
        return env.fee_bump.tx.inner_tx.v1.tx, env.fee_bump, env.fee_bump.tx.fee.int64
    if t == "ENVELOPE_TYPE_TX_V0":
        return env.v0.tx, env.v0, env.v0.tx.fee.uint32
    return env.v1.tx, env.v1, env.v1.tx.fee.uint32


def tx_profile(m, blobs, dec, pp):
    e = m.get("expected_decoded") or {}
    env = dec["envelope"]
    sdk_env = lambda: TransactionBuilder.from_xdr(blobs["envelope"], pp)
    inner_tx = lambda: sdk_env().transaction.inner_transaction_envelope.transaction if hasattr(sdk_env().transaction, "inner_transaction_envelope") else sdk_env().transaction
    return [
        ("tx_hash", e.get("tx_hash"), lambda: sdk_env().hash_hex()),
        ("successful", str(e.get("successful")).lower(), lambda: str(dec["result"].result.code.name in ("txSUCCESS", "txFEE_BUMP_INNER_SUCCESS")).lower()),
        ("source_account", e.get("source_account"), lambda: inner_tx().source.account_id),
        ("fee_account", e.get("fee_account"), lambda: sdk_env().transaction.fee_source.account_id),
        ("fee_charged", e.get("fee_charged"), lambda: str(dec["result"].fee_charged.int64)),
        ("max_fee", e.get("max_fee"), lambda: str(env_parts(env)[2])),
        ("operation_count", e.get("operation_count"), lambda: str(len(env_parts(env)[0].operations))),
        ("operation_types", e.get("operation_types"), lambda: ",".join(o.body.type.name.lower() for o in env_parts(env)[0].operations)),
        ("memo_type", e.get("memo_type"), lambda: env_parts(env)[0].memo.type.name.lower().removeprefix("memo_")),
        ("signature_count", e.get("signature_count"), lambda: str(len(env_parts(env)[1].signatures))),
    ]


def ledger_profile(m, dec):
    import hashlib
    from datetime import datetime, timezone

    e = m.get("expected_decoded") or {}
    lcm = dec["ledger"]
    body = lambda: lcm.v2 or lcm.v1 or lcm.v0
    h = lambda: body().ledger_header.header
    closed = lambda: datetime.fromtimestamp(h().scp_value.close_time.time_point.uint64, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return [
        ("ledger_hash", e.get("ledger_hash"), lambda: hashlib.sha256(h().to_xdr_bytes()).hexdigest()),
        ("prev_hash", e.get("prev_hash"), lambda: h().previous_ledger_hash.hash.hex()),
        ("sequence", e.get("sequence"), lambda: str(h().ledger_seq.uint32)),
        ("protocol_version", e.get("protocol_version"), lambda: str(h().ledger_version.uint32)),
        ("base_fee", e.get("base_fee"), lambda: str(h().base_fee.uint32)),
        ("base_reserve", e.get("base_reserve"), lambda: str(h().base_reserve.uint32)),
        ("max_tx_set_size", e.get("max_tx_set_size"), lambda: str(h().max_tx_set_size.uint32)),
        ("transaction_count", e.get("transaction_count"), lambda: str(len(body().tx_processing))),
        ("closed_at", e.get("closed_at"), lambda: closed()),
    ]


def run(m, blobs):
    files = m["files"]
    detail, failed = [], []
    if files and all(f.get("expect") == "decode_error" for f in files):
        checks = {"decode": "pass", "reencode": "n/a", "native": "n/a"}
        for f in files:
            try:
                codec(f["xdr_type"]).from_xdr(blobs[f["name"]])
            except Exception:
                continue
            checks["decode"] = "fail"
            failed.append(f"rejects:{f['name']}")
            detail.append(f"{f['name']}: decoded, but must be rejected")
        return checks, failed, detail
    checks = {"decode": "fail", "reencode": "fail", "native": "fail"}
    try:
        dec = {f["name"]: codec(f["xdr_type"]).from_xdr(blobs[f["name"]]) for f in files}
    except Exception as err:
        detail.append(f"decode: {err!r}"[:200])
        return checks, failed, detail
    checks["decode"] = "pass"
    bad = [f["name"] for f in files if dec[f["name"]].to_xdr() != blobs[f["name"]]]
    checks["reencode"] = "fail" if bad else "pass"
    if bad:
        detail.append("re-encode differs: " + ", ".join(bad))
    try:
        rows = checks_for(m, blobs, dec)
    except Exception as err:
        detail.append(repr(err)[:200])
        return checks, failed, detail
    for name, expected, observe in rows:
        if expected is None:
            continue  # this fixture doesn't carry the value
        try:
            got = observe()
        except Exception as err:
            got = f"threw: {err!r}"[:160]
        if str(got) != str(expected):
            failed.append(name)
            detail.append(f"{name}: expected {str(expected)[:80]}, got {str(got)[:120]}")
    checks["native"] = "fail" if failed else "pass"
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
        "sdk": "python",
        "package": "stellar-sdk",
        "version": version("stellar-sdk"),
        "runtime": f"python {platform.python_version()}",
        "results": results,
    }
    (CORPUS / "results" / "python.json").write_text(json.dumps(out, indent=2) + "\n")


if __name__ == "__main__":
    sys.setrecursionlimit(10_000)
    main()
