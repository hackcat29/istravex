//! Rust conformance runner (stellar-xdr).
//! Checks per fixture: decode, byte-exact re-encode, and a high-level
//! ("native") conversion — the crate's serde XDR-JSON plus stellar-strkey —
//! compared against the fixture's expected values.
//!
//!     cargo run --release -- ../../../corpus

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::Path};
use stellar_xdr::{
    ChangeTrustAsset, FeeBumpTransactionInnerTx, Hash, LedgerCloseMeta, LedgerEntryChanges, LedgerEntryData, Limits,
    LiquidityPoolParameters, Memo, MuxedAccount, Operation, OperationBody, Preconditions, ReadXdr, ScMap, ScVal, Transaction,
    TransactionEnvelope, TransactionExt, TransactionMeta, TransactionResult, TransactionResultResult, TransactionSignaturePayload,
    TransactionSignaturePayloadTaggedTransaction, WriteXdr,
};

#[derive(Deserialize)]
struct File {
    name: String,
    xdr_type: String,
    path: String,
    #[serde(default)]
    expect: Option<String>,
}

#[derive(Deserialize, Default)]
struct Generator {
    #[serde(default)]
    network_passphrase: Option<String>,
}

#[derive(Deserialize, Default)]
struct Source {
    #[serde(default)]
    generator: Option<Generator>,
}

#[derive(Deserialize)]
struct Manifest {
    id: String,
    pattern: String,
    network: String,
    #[serde(default)]
    source: Source,
    #[serde(default)]
    expected_decoded: Value,
    #[serde(default)]
    expected_indexed: Value,
    files: Vec<File>,
}

impl Manifest {
    fn passphrase(&self) -> String {
        if let Some(pp) = self.source.generator.as_ref().and_then(|g| g.network_passphrase.clone()) {
            return pp;
        }
        match self.network.as_str() {
            "pubnet" => "Public Global Stellar Network ; September 2015",
            "local" => "Standalone Network ; February 2017",
            _ => "Test SDF Network ; September 2015",
        }
        .into()
    }
}

/// Untrusted input gets bounded limits, as the hardening guide recommends:
/// 500 levels of nesting and no more bytes than the input holds.
fn limits(input_len: usize) -> Limits {
    Limits { depth: 500, len: input_len }
}

enum Decoded {
    Env(TransactionEnvelope),
    Result(TransactionResult),
    Meta(TransactionMeta),
    Data(LedgerEntryData),
    Changes(LedgerEntryChanges),
    Val(ScVal),
    Lcm(LedgerCloseMeta),
}

impl Decoded {
    fn decode(t: &str, b64: &str) -> Result<Self, String> {
        let l = limits(b64.len());
        let e = |e: stellar_xdr::Error| e.to_string();
        Ok(match t {
            "TransactionEnvelope" => Self::Env(TransactionEnvelope::from_xdr_base64(b64, l).map_err(e)?),
            "TransactionResult" => Self::Result(TransactionResult::from_xdr_base64(b64, l).map_err(e)?),
            "TransactionMeta" => Self::Meta(TransactionMeta::from_xdr_base64(b64, l).map_err(e)?),
            "LedgerEntryData" => Self::Data(LedgerEntryData::from_xdr_base64(b64, l).map_err(e)?),
            "LedgerEntryChanges" => Self::Changes(LedgerEntryChanges::from_xdr_base64(b64, l).map_err(e)?),
            "ScVal" => Self::Val(ScVal::from_xdr_base64(b64, l).map_err(e)?),
            "LedgerCloseMeta" => Self::Lcm(LedgerCloseMeta::from_xdr_base64(b64, l).map_err(e)?),
            other => return Err(format!("unknown xdr type {other}")),
        })
    }
    fn encode(&self) -> Result<String, String> {
        let l = Limits::none();
        match self {
            Self::Env(v) => v.to_xdr_base64(l),
            Self::Result(v) => v.to_xdr_base64(l),
            Self::Meta(v) => v.to_xdr_base64(l),
            Self::Data(v) => v.to_xdr_base64(l),
            Self::Changes(v) => v.to_xdr_base64(l),
            Self::Val(v) => v.to_xdr_base64(l),
            Self::Lcm(v) => v.to_xdr_base64(l),
        }
        .map_err(|e| e.to_string())
    }
    fn json(&self) -> Value {
        match self {
            Self::Env(v) => serde_json::to_value(v),
            Self::Result(v) => serde_json::to_value(v),
            Self::Meta(v) => serde_json::to_value(v),
            Self::Data(v) => serde_json::to_value(v),
            Self::Changes(v) => serde_json::to_value(v),
            Self::Val(v) => serde_json::to_value(v),
            Self::Lcm(v) => serde_json::to_value(v),
        }
        .unwrap_or(Value::Null)
    }
}

/// JSON scalar → string (wide ints may serialize as strings or numbers).
fn s(v: &Value) -> String {
    match v {
        Value::String(x) => x.clone(),
        Value::Null => "—".into(),
        Value::Array(a) => a.iter().map(s).collect::<Vec<_>>().join(","),
        other => other.to_string(),
    }
}

fn asset(a: &Value) -> String {
    if a.as_str() == Some("native") {
        return "native".into();
    }
    let v = a.get("credit_alphanum4").or_else(|| a.get("credit_alphanum12")).unwrap_or(&Value::Null);
    format!("{}:{}", s(&v["asset_code"]), s(&v["issuer"]))
}

fn stroops(raw: &str) -> String {
    let n: i64 = raw.parse().unwrap_or(-1);
    format!("{}.{:07}", n / 10_000_000, n % 10_000_000)
}

fn tx_hash(tagged: TransactionSignaturePayloadTaggedTransaction, passphrase: &str) -> String {
    let payload = TransactionSignaturePayload {
        network_id: Hash(Sha256::digest(passphrase.as_bytes()).into()),
        tagged_transaction: tagged,
    };
    hex::encode(Sha256::digest(payload.to_xdr(Limits::none()).unwrap()))
}

/// (muxed id, base G-address) of an M-address.
fn muxed(addr: &str) -> Result<(String, String), String> {
    match stellar_strkey::Strkey::from_string(addr).map_err(|e| e.to_string())? {
        stellar_strkey::Strkey::MuxedAccountEd25519(mx) => Ok((mx.id.to_string(), format!("{}", stellar_strkey::ed25519::PublicKey(mx.ed25519)))),
        _ => Err(format!("{addr} is not muxed")),
    }
}

fn tx_body(env_json: &Value) -> Value {
    if env_json.get("tx_fee_bump").is_some() {
        env_json["tx_fee_bump"]["tx"]["inner_tx"]["tx"]["tx"].clone()
    } else {
        env_json["tx"]["tx"].clone()
    }
}

type Observe<'a> = Box<dyn Fn() -> Result<String, String> + 'a>;
type Check<'a> = (&'static str, String, Observe<'a>);

/// Named checks per pattern: (name, expected, a function producing the observed
/// value). Each is evaluated on its own, so one failing check doesn't hide the rest.
fn native<'a>(m: &'a Manifest, dec: &'a BTreeMap<String, Decoded>) -> Result<Vec<Check<'a>>, String> {
    let e = &m.expected_decoded;
    let ix = &m.expected_indexed;
    let get = move |name: &str| dec.get(name).ok_or(format!("missing {name}"));
    let env_json = move || get("envelope").map(|d| d.json());
    let checks: Vec<Check<'a>> = match m.pattern.as_str() {
        "muxed-payment" => {
            let i = e["op_index"].as_u64().unwrap_or(0) as usize;
            let pay = move || env_json().map(|j| tx_body(&j)["operations"][i]["body"]["payment"].clone());
            vec![
                ("destination_muxed", s(&e["destination_muxed"]), Box::new(move || Ok(s(&pay()?["destination"])))),
                ("muxed_id", s(&e["muxed_id"]), Box::new(move || Ok(muxed(&s(&pay()?["destination"]))?.0))),
                ("destination_account", s(&e["destination_account"]), Box::new(move || Ok(muxed(&s(&pay()?["destination"]))?.1))),
                ("asset", s(&e["asset"]), Box::new(move || Ok(asset(&pay()?["asset"])))),
                ("amount", s(&e["amount"]), Box::new(move || Ok(stroops(&s(&pay()?["amount"]))))),
            ]
        }
        "fee-bump" => {
            let pp = m.passphrase();
            let pp2 = pp.clone();
            let fb = move || match get("envelope") {
                Ok(Decoded::Env(TransactionEnvelope::TxFeeBump(fb))) => Ok(fb),
                _ => Err("not a fee-bump envelope".to_string()),
            };
            vec![
                ("tx_hash", s(&e["tx_hash"]), Box::new(move || Ok(tx_hash(TransactionSignaturePayloadTaggedTransaction::TxFeeBump(fb()?.tx.clone()), &pp)))),
                (
                    "inner_tx_hash",
                    s(&e["inner_tx_hash"]),
                    Box::new(move || {
                        let FeeBumpTransactionInnerTx::Tx(inner) = &fb()?.tx.inner_tx;
                        Ok(tx_hash(TransactionSignaturePayloadTaggedTransaction::Tx(inner.tx.clone()), &pp2))
                    }),
                ),
                ("fee_source", s(&e["fee_source"]), Box::new(move || Ok(s(&env_json()?["tx_fee_bump"]["tx"]["fee_source"])))),
                ("inner_source", s(&e["inner_source"]), Box::new(move || Ok(s(&env_json()?["tx_fee_bump"]["tx"]["inner_tx"]["tx"]["tx"]["source_account"])))),
            ]
        }
        "signed-payload-signer" => {
            let signer = move || get("ledger_entry").map(|d| d.json()["account"]["signers"][0].clone());
            let parts = move || -> Result<(String, String), String> {
                match stellar_strkey::Strkey::from_string(&s(&signer()?["key"])).map_err(|e| e.to_string())? {
                    stellar_strkey::Strkey::SignedPayloadEd25519(sp) => {
                        Ok((format!("{}", stellar_strkey::ed25519::PublicKey(*sp.ed25519())), hex::encode(sp.payload())))
                    }
                    _ => Err("not a signed-payload signer".into()),
                }
            };
            vec![
                ("signer_strkey", s(&e["signer_strkey"]), Box::new(move || Ok(s(&signer()?["key"])))),
                ("signer_ed25519", s(&e["signer_ed25519"]), Box::new(move || Ok(parts()?.0))),
                ("payload_hex", s(&e["payload_hex"]), Box::new(move || Ok(parts()?.1))),
                ("weight", s(&e["weight"]), Box::new(move || Ok(s(&signer()?["weight"])))),
            ]
        }
        "sac-trust" => {
            let created = move || -> Result<Vec<Value>, String> {
                let j = get("meta")?.json();
                let body = j.get("v4").or_else(|| j.get("v3")).or_else(|| j.get("v2")).cloned().unwrap_or(Value::Null);
                Ok(body["operations"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .flat_map(|op| op["changes"].as_array().cloned().unwrap_or_default())
                    .filter_map(|c| c.get("created").and_then(|c| c["data"].get("trustline")).cloned())
                    .collect())
            };
            let tl = move || created()?.first().cloned().ok_or("no trustline created".to_string());
            vec![
                ("trustline_created", "true".into(), Box::new(move || Ok((created()?.len() == 1).to_string()))),
                ("account", s(&ix["account"]), Box::new(move || Ok(s(&tl()?["account_id"])))),
                ("asset", s(&ix["asset"]), Box::new(move || Ok(asset(&tl()?["asset"])))),
                ("limit", s(&ix["limit"]), Box::new(move || Ok(s(&tl()?["limit"])))),
            ]
        }
        "muxed-max-id" => {
            let src = move || env_json().map(|j| s(&tx_body(&j)["source_account"]));
            let pay = move || env_json().map(|j| tx_body(&j)["operations"][0]["body"]["payment"].clone());
            vec![
                ("source_muxed", s(&e["source_muxed"]), Box::new(src)),
                ("source_muxed_id", s(&e["source_muxed_id"]), Box::new(move || Ok(muxed(&src()?)?.0))),
                ("source_account", s(&e["source_account"]), Box::new(move || Ok(muxed(&src()?)?.1))),
                ("destination_muxed_id", s(&e["destination_muxed_id"]), Box::new(move || Ok(muxed(&s(&pay()?["destination"]))?.0))),
                ("destination_account", s(&e["destination_account"]), Box::new(move || Ok(muxed(&s(&pay()?["destination"]))?.1))),
                ("amount", s(&e["amount"]), Box::new(move || Ok(stroops(&s(&pay()?["amount"]))))),
                ("muxed_address_roundtrip", s(&e["destination_muxed_id"]), Box::new(move || Ok(muxed(&s(&e["destination_muxed"]))?.0))),
            ]
        }
        "pool-issuer-order" => {
            let params = move || -> Result<stellar_xdr::LiquidityPoolConstantProductParameters, String> {
                let Decoded::Env(TransactionEnvelope::Tx(env)) = get("envelope")? else {
                    return Err("not a v1 envelope".into());
                };
                match &env.tx.operations[2].body {
                    OperationBody::ChangeTrust(ct) => match &ct.line {
                        ChangeTrustAsset::PoolShare(LiquidityPoolParameters::LiquidityPoolConstantProduct(p)) => Ok(p.clone()),
                        _ => Err("not a pool share".into()),
                    },
                    _ => Err("not changeTrust".into()),
                }
            };
            let canonical = |a: &stellar_xdr::Asset| asset(&serde_json::to_value(a).unwrap_or(Value::Null));
            vec![
                (
                    "decode_pool_share_op",
                    format!("{}/{}", s(&e["asset_a"]), s(&e["asset_b"])),
                    Box::new(move || {
                        let p = params()?;
                        Ok(format!("{}/{}", canonical(&p.asset_a), canonical(&p.asset_b)))
                    }),
                ),
                (
                    "asset_compare",
                    "-1".into(),
                    Box::new(move || {
                        let p = params()?;
                        Ok(if p.asset_a < p.asset_b { "-1" } else { "1" }.into())
                    }),
                ),
                (
                    "pool_id",
                    s(&e["pool_id"]),
                    Box::new(move || {
                        let p = LiquidityPoolParameters::LiquidityPoolConstantProduct(params()?);
                        Ok(hex::encode(Sha256::digest(p.to_xdr(Limits::none()).map_err(|e| e.to_string())?)))
                    }),
                ),
            ]
        }
        "max-amount" => {
            let pay = move || env_json().map(|j| tx_body(&j)["operations"][0]["body"]["payment"].clone());
            vec![
                ("amount", s(&e["amount"]), Box::new(move || Ok(stroops(&s(&pay()?["amount"]))))),
                ("amount_stroops", s(&e["amount_stroops"]), Box::new(move || Ok(s(&pay()?["amount"])))),
                ("asset", s(&e["asset"]), Box::new(move || Ok(asset(&pay()?["asset"])))),
            ]
        }
        "memo-non-utf8" => vec![(
            "memo_bytes",
            s(&e["memo_hex"]),
            Box::new(move || match get("envelope")? {
                Decoded::Env(TransactionEnvelope::Tx(env)) => match &env.tx.memo {
                    stellar_xdr::Memo::Text(t) => Ok(hex::encode(t.as_vec())),
                    _ => Err("not a text memo".into()),
                },
                _ => Err("not a v1 envelope".into()),
            }),
        )],
        "max-length-vectors" => {
            let acct = move || get("ledger_entry").map(|d| d.json()["account"].clone());
            vec![
                (
                    "operation_count",
                    s(&e["operation_count"]),
                    Box::new(move || Ok(tx_body(&env_json()?)["operations"].as_array().map_or(0, |a| a.len()).to_string())),
                ),
                (
                    "signature_count",
                    s(&e["signature_count"]),
                    Box::new(move || Ok(get("envelope_signatures")?.json()["tx"]["signatures"].as_array().map_or(0, |a| a.len()).to_string())),
                ),
                ("signer_count", s(&e["signer_count"]), Box::new(move || Ok(acct()?["signers"].as_array().map_or(0, |a| a.len()).to_string()))),
                (
                    "thresholds",
                    s(&e["thresholds"]),
                    Box::new(move || {
                        let t = hex::decode(s(&acct()?["thresholds"])).map_err(|e| e.to_string())?;
                        Ok(t[1..].iter().map(|b| b.to_string()).collect::<Vec<_>>().join(","))
                    }),
                ),
            ]
        }
        "scmap-host-order" => {
            let map = move || -> Result<ScMap, String> {
                match get("ledger_entry")? {
                    Decoded::Data(LedgerEntryData::ContractData(cd)) => match &cd.val {
                        ScVal::Map(Some(m)) => Ok(m.clone()),
                        _ => Err("not a map".into()),
                    },
                    _ => Err("not contract data".into()),
                }
            };
            vec![
                ("entry_count", s(&e["entry_count"]), Box::new(move || Ok(map()?.len().to_string()))),
                (
                    "key_order_preserved",
                    s(&e["keys_xdr"]),
                    Box::new(move || {
                        map()?
                            .iter()
                            .map(|en| en.key.to_xdr_base64(Limits::none()).map_err(|e| e.to_string()))
                            .collect::<Result<Vec<_>, _>>()
                            .map(|k| k.join(","))
                    }),
                ),
                (
                    "sorted_map_matches_host",
                    "host order".into(),
                    Box::new(move || {
                        let m = map()?;
                        let mut rev: Vec<_> = m.iter().cloned().collect();
                        rev.reverse();
                        let sorted = ScMap::sorted_from(rev).map_err(|e| e.to_string())?;
                        Ok(if sorted == m { "host order".into() } else { "differs from host order".into() })
                    }),
                ),
            ]
        }
        "nested-auth" => {
            let walk = move || -> Result<(usize, usize, String), String> {
                let j = env_json()?;
                let root = tx_body(&j)["operations"][0]["body"]["invoke_host_function"]["auth"][0]["root_invocation"].clone();
                let (mut depth, mut count) = (0, 0);
                let mut stack = vec![(root.clone(), 1usize)];
                while let Some((inv, d)) = stack.pop() {
                    if d > 100 {
                        // the host's own depth limit
                        return Err("auth tree deeper than 100".into());
                    }
                    depth = depth.max(d);
                    count += 1;
                    for sub in inv["sub_invocations"].as_array().into_iter().flatten() {
                        stack.push((sub.clone(), d + 1));
                    }
                }
                Ok((depth, count, s(&root["function"]["contract_fn"]["contract_address"])))
            };
            vec![
                ("auth_depth", s(&e["auth_depth"]), Box::new(move || Ok(walk()?.0.to_string()))),
                ("auth_invocations", s(&e["auth_invocations"]), Box::new(move || Ok(walk()?.1.to_string()))),
                ("root_contract", s(&e["root_contract"]), Box::new(move || Ok(walk()?.2))),
                ("return_value", s(&e["return_u32"]), Box::new(move || Ok(s(&get("meta")?.json()["v4"]["soroban_meta"]["return_value"]["u32"])))),
            ]
        }
        "muxed-soroban-source" => {
            let src = move || env_json().map(|j| s(&tx_body(&j)["source_account"]));
            vec![
                ("source_account", s(&e["source_account"]), Box::new(move || Ok(muxed(&src()?)?.1))),
                ("source_muxed_id", s(&e["source_muxed_id"]), Box::new(move || Ok(muxed(&src()?)?.0))),
                (
                    "operation",
                    s(&e["operation"]),
                    Box::new(move || {
                        let body = tx_body(&env_json()?)["operations"][0]["body"].clone();
                        Ok(if body.get("extend_footprint_ttl").is_some() { "extendFootprintTtl".into() } else { body.to_string() })
                    }),
                ),
            ]
        }
        "tx" => tx_profile(m, dec)?,
        "ledger" => ledger_profile(m, dec)?,
        other => return Err(format!("no native check for pattern {other}")),
    };
    Ok(checks)
}

// Generic profiles for fixtures chosen by set cover (kit/capture/shapes.mjs).
// Expected values come from Horizon; the crate reads them from typed XDR.

fn snake(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if i > 0 && c.is_ascii_uppercase() {
            out.push('_');
        }
        out.push(c.to_ascii_lowercase());
    }
    out
}

fn g_address(m: &MuxedAccount) -> String {
    let key = match m {
        MuxedAccount::Ed25519(k) => k.0,
        MuxedAccount::MuxedEd25519(mx) => mx.ed25519.0,
    };
    format!("{}", stellar_strkey::ed25519::PublicKey(key))
}

/// (inner transaction as a v1 Transaction, outer signature count, outer fee, fee source).
fn envelope_parts(env: &TransactionEnvelope) -> (Transaction, usize, i64, Option<MuxedAccount>) {
    match env {
        TransactionEnvelope::TxV0(v0) => {
            let t = &v0.tx;
            let tx = Transaction {
                source_account: MuxedAccount::Ed25519(t.source_account_ed25519.clone()),
                fee: t.fee,
                seq_num: t.seq_num.clone(),
                cond: match &t.time_bounds {
                    Some(tb) => Preconditions::Time(tb.clone()),
                    None => Preconditions::None,
                },
                memo: t.memo.clone(),
                operations: t.operations.clone(),
                ext: TransactionExt::V0,
            };
            (tx, v0.signatures.len(), t.fee as i64, None)
        }
        TransactionEnvelope::Tx(v1) => (v1.tx.clone(), v1.signatures.len(), v1.tx.fee as i64, None),
        TransactionEnvelope::TxFeeBump(fb) => {
            let FeeBumpTransactionInnerTx::Tx(inner) = &fb.tx.inner_tx;
            (inner.tx.clone(), fb.signatures.len(), fb.tx.fee, Some(fb.tx.fee_source.clone()))
        }
    }
}

fn envelope_hash(env: &TransactionEnvelope, pp: &str) -> String {
    match env {
        TransactionEnvelope::TxFeeBump(fb) => tx_hash(TransactionSignaturePayloadTaggedTransaction::TxFeeBump(fb.tx.clone()), pp),
        other => tx_hash(TransactionSignaturePayloadTaggedTransaction::Tx(envelope_parts(other).0), pp),
    }
}

fn tx_profile<'a>(m: &'a Manifest, dec: &'a BTreeMap<String, Decoded>) -> Result<Vec<Check<'a>>, String> {
    let e = &m.expected_decoded;
    let env = match dec.get("envelope") {
        Some(Decoded::Env(v)) => v,
        _ => return Err("missing envelope".into()),
    };
    let res = match dec.get("result") {
        Some(Decoded::Result(v)) => v,
        _ => return Err("missing result".into()),
    };
    let pp = m.passphrase();
    let ops = move || -> Vec<Operation> { envelope_parts(env).0.operations.to_vec() };
    let mut checks: Vec<Check<'a>> = vec![
        ("tx_hash", s(&e["tx_hash"]), Box::new(move || Ok(envelope_hash(env, &pp)))),
        (
            "successful",
            s(&e["successful"]),
            Box::new(move || Ok(matches!(res.result, TransactionResultResult::TxSuccess(_) | TransactionResultResult::TxFeeBumpInnerSuccess(_)).to_string())),
        ),
        ("source_account", s(&e["source_account"]), Box::new(move || Ok(g_address(&envelope_parts(env).0.source_account)))),
        ("fee_charged", s(&e["fee_charged"]), Box::new(move || Ok(res.fee_charged.to_string()))),
        ("max_fee", s(&e["max_fee"]), Box::new(move || Ok(envelope_parts(env).2.to_string()))),
        ("operation_count", s(&e["operation_count"]), Box::new(move || Ok(ops().len().to_string()))),
        (
            "operation_types",
            s(&e["operation_types"]),
            Box::new(move || Ok(ops().iter().map(|o| snake(o.body.name())).collect::<Vec<_>>().join(","))),
        ),
        (
            "memo_type",
            s(&e["memo_type"]),
            Box::new(move || {
                Ok(match envelope_parts(env).0.memo {
                    Memo::None => "none",
                    Memo::Text(_) => "text",
                    Memo::Id(_) => "id",
                    Memo::Hash(_) => "hash",
                    Memo::Return(_) => "return",
                }
                .to_string())
            }),
        ),
        ("signature_count", s(&e["signature_count"]), Box::new(move || Ok(envelope_parts(env).1.to_string()))),
    ];
    if e.get("fee_account").is_some() {
        checks.push((
            "fee_account",
            s(&e["fee_account"]),
            Box::new(move || envelope_parts(env).3.map(|f| g_address(&f)).ok_or("not a fee-bump".to_string())),
        ));
    }
    Ok(checks)
}

/// Unix seconds → RFC 3339 UTC (days-from-civil, no date crate).
fn rfc3339(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if mo <= 2 { 1 } else { 0 };
    format!("{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn ledger_profile<'a>(m: &'a Manifest, dec: &'a BTreeMap<String, Decoded>) -> Result<Vec<Check<'a>>, String> {
    let e = &m.expected_decoded;
    let lcm = match dec.get("ledger") {
        Some(Decoded::Lcm(v)) => v,
        _ => return Err("missing ledger".into()),
    };
    let (header, txs) = match lcm {
        LedgerCloseMeta::V0(v) => (&v.ledger_header.header, v.tx_processing.len()),
        LedgerCloseMeta::V1(v) => (&v.ledger_header.header, v.tx_processing.len()),
        LedgerCloseMeta::V2(v) => (&v.ledger_header.header, v.tx_processing.len()),
    };
    Ok(vec![
        ("ledger_hash", s(&e["ledger_hash"]), Box::new(move || Ok(hex::encode(Sha256::digest(header.to_xdr(Limits::none()).map_err(|e| e.to_string())?))))),
        ("prev_hash", s(&e["prev_hash"]), Box::new(move || Ok(hex::encode(header.previous_ledger_hash.0)))),
        ("sequence", s(&e["sequence"]), Box::new(move || Ok(header.ledger_seq.to_string()))),
        ("protocol_version", s(&e["protocol_version"]), Box::new(move || Ok(header.ledger_version.to_string()))),
        ("base_fee", s(&e["base_fee"]), Box::new(move || Ok(header.base_fee.to_string()))),
        ("base_reserve", s(&e["base_reserve"]), Box::new(move || Ok(header.base_reserve.to_string()))),
        ("max_tx_set_size", s(&e["max_tx_set_size"]), Box::new(move || Ok(header.max_tx_set_size.to_string()))),
        ("transaction_count", s(&e["transaction_count"]), Box::new(move || Ok(txs.to_string()))),
        ("closed_at", s(&e["closed_at"]), Box::new(move || Ok(rfc3339(header.scp_value.close_time.0)))),
    ])
}

/// `goldens <test-lcm-current dir> <corpus dir>`: decode and byte-exact
/// re-encode every LedgerCloseMeta frame in stellar-core's golden files.
fn goldens(dir: &Path, corpus: &Path) {
    let mut files: Vec<_> = fs::read_dir(dir)
        .expect("goldens dir")
        .filter_map(|d| d.ok())
        .filter(|d| d.path().is_dir())
        .flat_map(|d| fs::read_dir(d.path()).into_iter().flatten().filter_map(|e| e.ok()).map(|e| e.path()))
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("xdr"))
        .collect();
    files.sort();
    let (mut frames, mut exact) = (0usize, 0usize);
    let mut failures = vec![];
    for f in &files {
        let raw = fs::read(f).unwrap();
        let rel = f.strip_prefix(dir).unwrap().display().to_string();
        let mut off = 0usize;
        let mut i = 0usize;
        while off + 4 <= raw.len() {
            let n = (u32::from_be_bytes(raw[off..off + 4].try_into().unwrap()) & 0x7fff_ffff) as usize;
            if off + 4 + n > raw.len() {
                break;
            }
            let fr = &raw[off + 4..off + 4 + n];
            frames += 1;
            match stellar_xdr::LedgerCloseMeta::from_xdr(fr, Limits::none()) {
                Ok(v) => match v.to_xdr(Limits::none()) {
                    Ok(out) if out == fr => exact += 1,
                    _ => failures.push(json!({ "file": rel, "frame": i, "error": "re-encode differs" })),
                },
                Err(e) => failures.push(json!({ "file": rel, "frame": i, "error": e.to_string() })),
            }
            off += 4 + n;
            i += 1;
        }
    }
    println!("rust: {exact}/{frames} frames exact in {} files, {} failures", files.len(), failures.len());
    let ok = failures.is_empty();
    let out = json!({ "sdk": "rust", "package": "stellar-xdr", "version": "30.0.0", "files": files.len(), "frames": frames, "exact": exact, "failures": failures });
    fs::write(corpus.join("results").join("goldens-rust.json"), serde_json::to_string_pretty(&out).unwrap() + "\n").unwrap();
    if !ok {
        std::process::exit(1);
    }
}

/// Every TransactionEnvelope in a ledger's transaction set.
fn set_envelopes(lcm: &LedgerCloseMeta) -> Vec<TransactionEnvelope> {
    use stellar_xdr::{GeneralizedTransactionSet, TransactionPhase, TxSetComponent};
    let set = match lcm {
        LedgerCloseMeta::V0(v) => return v.tx_set.txs.to_vec(),
        LedgerCloseMeta::V1(v) => &v.tx_set,
        LedgerCloseMeta::V2(v) => &v.tx_set,
    };
    let GeneralizedTransactionSet::V1(v1) = set;
    let mut out = Vec::new();
    for phase in v1.phases.iter() {
        match phase {
            TransactionPhase::V0(components) => {
                for c in components.iter() {
                    let TxSetComponent::TxsetCompTxsMaybeDiscountedFee(t) = c;
                    out.extend(t.txs.iter().cloned());
                }
            }
            TransactionPhase::V1(p) => {
                for stage in p.execution_stages.iter() {
                    for cluster in stage.0.iter() {
                        out.extend(cluster.0.iter().cloned());
                    }
                }
            }
        }
    }
    out
}

/// `sweep <passphrase> <LedgerCloseMetaBatch file>...`: every batch round-trips
/// byte for byte, and every transaction hash the crate computes is the one
/// stellar-core recorded in the ledger's results.
fn sweep(passphrase: &str, files: &[String]) {
    use stellar_xdr::LedgerCloseMetaBatch;
    let (mut ledgers, mut txs, mut checks, mut passed) = (0usize, 0usize, 0usize, 0usize);
    let mut failures: Vec<Value> = Vec::new();
    let mut check = |ledger: String, name: &str, ok: bool, detail: String| {
        checks += 1;
        if ok {
            passed += 1;
        } else if failures.len() < 50 {
            failures.push(json!({ "ledger": ledger, "check": name, "detail": detail }));
        }
    };
    for path in files {
        let raw = fs::read(path).expect("ledger file");
        let name = Path::new(path).file_name().unwrap().to_string_lossy().to_string();
        let batch = match LedgerCloseMetaBatch::from_xdr(&raw, Limits { depth: 2000, len: raw.len() }) {
            Ok(b) => b,
            Err(e) => {
                check(name, "decode", false, e.to_string());
                continue;
            }
        };
        let again = batch.to_xdr(Limits::none()).unwrap_or_default();
        check(name, "reencode", again == raw, format!("{} vs {} bytes", again.len(), raw.len()));
        for lcm in batch.ledger_close_metas.iter() {
            ledgers += 1;
            let (seq, want): (u32, Vec<String>) = match lcm {
                LedgerCloseMeta::V0(v) => (v.ledger_header.header.ledger_seq, v.tx_processing.iter().map(|t| hex::encode(t.result.transaction_hash.0)).collect()),
                LedgerCloseMeta::V1(v) => (v.ledger_header.header.ledger_seq, v.tx_processing.iter().map(|t| hex::encode(t.result.transaction_hash.0)).collect()),
                LedgerCloseMeta::V2(v) => (v.ledger_header.header.ledger_seq, v.tx_processing.iter().map(|t| hex::encode(t.result.transaction_hash.0)).collect()),
            };
            let envs = set_envelopes(lcm);
            let got: std::collections::HashSet<String> = envs.iter().map(|e| envelope_hash(e, passphrase)).collect();
            txs += want.len();
            for h in &want {
                check(seq.to_string(), "tx_hash", got.contains(h), h.clone());
            }
            check(seq.to_string(), "tx_count", envs.len() == want.len(), format!("{} envelopes, {} results", envs.len(), want.len()));
        }
    }
    println!(
        "{}",
        json!({ "sdk": "rust", "package": "stellar-xdr", "version": "30.0.0", "ledgers": ledgers, "transactions": txs, "checks": checks, "passed": passed, "failures": failures })
    );
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("goldens") {
        return goldens(Path::new(&args[2]), Path::new(&args[3]));
    }
    if args.get(1).map(String::as_str) == Some("sweep") {
        return sweep(&args[2], &args[3..]);
    }
    let corpus = std::env::args().nth(1).unwrap_or("../../../corpus".into());
    let mut dirs: Vec<_> = fs::read_dir(Path::new(&corpus).join("fixtures"))
        .expect("corpus/fixtures")
        .filter_map(|d| d.ok().map(|d| d.path()))
        .filter(|p| p.join("manifest.json").exists())
        .collect();
    dirs.sort();

    let mut results = vec![];
    for dir in dirs {
        let m: Manifest = serde_json::from_str(&fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
        let mut checks = BTreeMap::from([("decode", "fail"), ("reencode", "fail"), ("native", "fail")]);
        let mut detail: Vec<String> = vec![];
        let mut failed: Vec<String> = vec![];
        let mut dec = BTreeMap::new();
        let mut blobs = BTreeMap::new();
        for f in &m.files {
            blobs.insert(f.name.clone(), fs::read_to_string(dir.join(&f.path)).unwrap().trim().to_string());
        }
        // Bytes a decoder must refuse: pass when every one fails to decode.
        if !m.files.is_empty() && m.files.iter().all(|f| f.expect.as_deref() == Some("decode_error")) {
            checks = BTreeMap::from([("decode", "pass"), ("reencode", "n/a"), ("native", "n/a")]);
            for f in &m.files {
                if Decoded::decode(&f.xdr_type, &blobs[&f.name]).is_ok() {
                    checks.insert("decode", "fail");
                    failed.push(format!("rejects:{}", f.name));
                    detail.push(format!("{}: decoded, but must be rejected", f.name));
                }
            }
            println!("{:<44} {:?} {}", m.id, checks, detail.join("; "));
            results.push(json!({ "fixture": m.id, "checks": checks, "failed": failed, "detail": detail }));
            continue;
        }
        let mut ok = true;
        for f in &m.files {
            match Decoded::decode(&f.xdr_type, &blobs[&f.name]) {
                Ok(v) => {
                    dec.insert(f.name.clone(), v);
                }
                Err(err) => {
                    detail.push(format!("decode {}: {err}", f.name));
                    ok = false;
                }
            }
        }
        if ok {
            checks.insert("decode", "pass");
            let bad: Vec<_> = m.files.iter().filter(|f| dec[&f.name].encode().ok().as_ref() != Some(&blobs[&f.name])).map(|f| f.name.clone()).collect();
            checks.insert("reencode", if bad.is_empty() { "pass" } else { "fail" });
            if !bad.is_empty() {
                detail.push(format!("re-encode differs: {}", bad.join(", ")));
            }
            match native(&m, &dec) {
                Ok(rows) => {
                    for (name, want, observe) in rows {
                        // A check whose expected value this fixture doesn't carry doesn't apply.
                        if want == "—" {
                            continue;
                        }
                        let got = observe().unwrap_or_else(|e| format!("error: {e}"));
                        if got != want {
                            failed.push(name.to_string());
                            detail.push(format!("{name}: expected {want}, got {got}"));
                        }
                    }
                    checks.insert("native", if failed.is_empty() { "pass" } else { "fail" });
                }
                Err(err) => detail.push(err),
            }
        }
        println!("{:<44} {:?} {}", m.id, checks, detail.join("; "));
        results.push(json!({ "fixture": m.id, "checks": checks, "failed": failed, "detail": detail }));
    }
    let out = json!({
        "sdk": "rust", "package": "stellar-xdr", "version": "30.0.0",
        "runtime": env!("ISTRAVEX_RUSTC"), "results": results,
    });
    fs::write(Path::new(&corpus).join("results").join("rust.json"), serde_json::to_string_pretty(&out).unwrap() + "\n").unwrap();
}
