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
    FeeBumpTransactionInnerTx, Hash, LedgerEntryChanges, LedgerEntryData, Limits, ReadXdr,
    TransactionEnvelope, TransactionMeta, TransactionResult, TransactionSignaturePayload,
    TransactionSignaturePayloadTaggedTransaction, WriteXdr,
};

#[derive(Deserialize)]
struct File {
    name: String,
    xdr_type: String,
    path: String,
}

#[derive(Deserialize)]
struct Manifest {
    id: String,
    cap_ids: Vec<String>,
    network: String,
    #[serde(default)]
    expected_decoded: Value,
    #[serde(default)]
    expected_indexed: Value,
    files: Vec<File>,
}

enum Decoded {
    Env(TransactionEnvelope),
    Result(TransactionResult),
    Meta(TransactionMeta),
    Data(LedgerEntryData),
    Changes(LedgerEntryChanges),
}

impl Decoded {
    fn decode(t: &str, b64: &str) -> Result<Self, String> {
        let l = Limits::none();
        let e = |e: stellar_xdr::Error| e.to_string();
        Ok(match t {
            "TransactionEnvelope" => Self::Env(TransactionEnvelope::from_xdr_base64(b64, l).map_err(e)?),
            "TransactionResult" => Self::Result(TransactionResult::from_xdr_base64(b64, l).map_err(e)?),
            "TransactionMeta" => Self::Meta(TransactionMeta::from_xdr_base64(b64, l).map_err(e)?),
            "LedgerEntryData" => Self::Data(LedgerEntryData::from_xdr_base64(b64, l).map_err(e)?),
            "LedgerEntryChanges" => Self::Changes(LedgerEntryChanges::from_xdr_base64(b64, l).map_err(e)?),
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
        }
        .unwrap_or(Value::Null)
    }
}

/// JSON scalar → string (wide ints may serialize as strings or numbers).
fn s(v: &Value) -> String {
    match v {
        Value::String(x) => x.clone(),
        Value::Null => "—".into(),
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

type Rows = Vec<(String, String, String)>;

fn native(m: &Manifest, dec: &BTreeMap<String, Decoded>) -> Result<Rows, String> {
    let e = &m.expected_decoded;
    let ix = &m.expected_indexed;
    let row = |k: &str, want: &Value, got: String| (k.to_string(), s(want), got);
    let get = |name: &str| dec.get(name).ok_or(format!("missing {name}"));
    match m.cap_ids[0].as_str() {
        "CAP-0027" => {
            let j = get("envelope")?.json();
            let inner = if j.get("tx_fee_bump").is_some() { &j["tx_fee_bump"]["tx"]["inner_tx"]["tx"]["tx"] } else { &j["tx"]["tx"] };
            let i = e["op_index"].as_u64().unwrap_or(0) as usize;
            let pay = &inner["operations"][i]["body"]["payment"];
            let dest = s(&pay["destination"]);
            let (id, key) = match stellar_strkey::Strkey::from_string(&dest).map_err(|e| e.to_string())? {
                stellar_strkey::Strkey::MuxedAccountEd25519(mx) => (
                    mx.id.to_string(),
                    format!("{}", stellar_strkey::ed25519::PublicKey(mx.ed25519)),
                ),
                _ => (String::from("—"), String::from("—")),
            };
            Ok(vec![
                row("destination_muxed", &e["destination_muxed"], dest.clone()),
                row("muxed_id", &e["muxed_id"], id),
                row("destination_account", &e["destination_account"], key),
                row("asset", &e["asset"], asset(&pay["asset"])),
                row("amount", &e["amount"], stroops(&s(&pay["amount"]))),
            ])
        }
        "CAP-0015" => {
            let Decoded::Env(TransactionEnvelope::TxFeeBump(fb)) = get("envelope")? else {
                return Err("not a fee-bump envelope".into());
            };
            let pp = match m.network.as_str() {
                "pubnet" => "Public Global Stellar Network ; September 2015",
                "local" => "Standalone Network ; February 2017",
                _ => "Test SDF Network ; September 2015",
            };
            let FeeBumpTransactionInnerTx::Tx(inner) = &fb.tx.inner_tx;
            let j = get("envelope")?.json();
            let t = &j["tx_fee_bump"]["tx"];
            Ok(vec![
                row("tx_hash", &e["tx_hash"], tx_hash(TransactionSignaturePayloadTaggedTransaction::TxFeeBump(fb.tx.clone()), pp)),
                row("inner_tx_hash", &e["inner_tx_hash"], tx_hash(TransactionSignaturePayloadTaggedTransaction::Tx(inner.tx.clone()), pp)),
                row("fee_source", &e["fee_source"], s(&t["fee_source"])),
                row("inner_source", &e["inner_source"], s(&t["inner_tx"]["tx"]["tx"]["source_account"])),
            ])
        }
        "CAP-0040" => {
            let j = get("ledger_entry")?.json();
            let signer = &j["account"]["signers"][0];
            let p = s(&signer["key"]);
            let (g, payload) = match stellar_strkey::Strkey::from_string(&p).map_err(|e| e.to_string())? {
                stellar_strkey::Strkey::SignedPayloadEd25519(sp) => (
                    format!("{}", stellar_strkey::ed25519::PublicKey(*sp.ed25519())),
                    hex::encode(sp.payload()),
                ),
                _ => (String::from("—"), String::from("—")),
            };
            Ok(vec![
                row("signer_strkey", &e["signer_strkey"], p),
                row("signer_ed25519", &e["signer_ed25519"], g),
                row("payload_hex", &e["payload_hex"], payload),
                row("weight", &e["weight"], s(&signer["weight"])),
            ])
        }
        "CAP-0073" => {
            let j = get("meta")?.json();
            let body = j.get("v4").or_else(|| j.get("v3")).or_else(|| j.get("v2")).unwrap_or(&Value::Null);
            let created: Vec<&Value> = body["operations"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|op| op["changes"].as_array().into_iter().flatten())
                .filter_map(|c| c.get("created").and_then(|c| c["data"].get("trustline")))
                .collect();
            let tl = created.first().copied().unwrap_or(&Value::Null);
            Ok(vec![
                ("trustline_created".into(), "true".into(), (created.len() == 1).to_string()),
                row("account", &ix["account"], s(&tl["account_id"])),
                row("asset", &ix["asset"], if tl.is_null() { "—".into() } else { asset(&tl["asset"]) }),
                row("limit", &ix["limit"], s(&tl["limit"])),
            ])
        }
        other => Err(format!("no native check for {other}")),
    }
}

fn main() {
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
        let mut dec = BTreeMap::new();
        let mut blobs = BTreeMap::new();
        let mut ok = true;
        for f in &m.files {
            let b64 = fs::read_to_string(dir.join(&f.path)).unwrap().trim().to_string();
            match Decoded::decode(&f.xdr_type, &b64) {
                Ok(v) => {
                    dec.insert(f.name.clone(), v);
                }
                Err(err) => {
                    detail.push(format!("decode {}: {err}", f.name));
                    ok = false;
                }
            }
            blobs.insert(f.name.clone(), b64);
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
                    let diffs: Vec<_> = rows.iter().filter(|(_, a, b)| a != b).collect();
                    checks.insert("native", if diffs.is_empty() { "pass" } else { "fail" });
                    for (k, a, b) in diffs {
                        detail.push(format!("{k}: expected {a}, got {b}"));
                    }
                }
                Err(err) => detail.push(err),
            }
        }
        println!("{:<42} {:?} {}", m.id, checks, detail.join("; "));
        results.push(json!({ "fixture": m.id, "checks": checks, "detail": detail }));
    }
    let out = json!({
        "sdk": "rust", "package": "stellar-xdr", "version": "30.0.0",
        "runtime": env!("ISTRAVEX_RUSTC"), "results": results,
    });
    fs::write(Path::new(&corpus).join("results").join("rust.json"), serde_json::to_string_pretty(&out).unwrap() + "\n").unwrap();
}
