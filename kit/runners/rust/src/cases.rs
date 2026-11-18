//! Generated cases: a value of every XDR type, and hostile variants of each.
//!
//! `cases-generate <out.jsonl.gz> [per-type] [seed]` writes, for every type in
//! the pinned stellar-xdr, up to `per-type` distinct valid values (drawn with
//! the crate's `arbitrary` support from a deterministic, seeded entropy
//! stream, so the same seed always gives the same bytes), and for each valid
//! value the hostile variants a decoder must refuse:
//!
//! - `trailing`: four extra bytes after a complete value;
//! - `truncated`: the value with its last byte cut off;
//! - `bad_first_word`: the first four bytes replaced by 0x7FFFFFFF, kept only
//!   where the reference decoder refuses the result: there the first word is
//!   a union discriminant, an enum, a bool or an optional flag, and
//!   0x7FFFFFFF is none of its allowed values.
//!
//! `cases-check <cases.jsonl.gz>` runs them through this crate and prints the
//! result JSON (corpus/results/cases-rust.json).
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::File,
    io::{BufRead, BufReader, Write},
    str::FromStr,
};
use stellar_xdr::{Limits, Type, TypeVariant, WriteXdr};

const MAX_BYTES: usize = 16 * 1024;

/// Deterministic entropy: SHA-256 in counter mode over (seed, type, index).
fn entropy(seed: &str, ty: &str, i: usize, len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    let mut n = 0u32;
    while out.len() < len {
        let mut h = Sha256::new();
        h.update(seed.as_bytes());
        h.update([0]);
        h.update(ty.as_bytes());
        h.update((i as u64).to_be_bytes());
        h.update(n.to_be_bytes());
        out.extend_from_slice(&h.finalize());
        n += 1;
    }
    out.truncate(len);
    out
}

fn limits(len: usize) -> Limits {
    Limits { depth: 500, len }
}

fn decodes(v: TypeVariant, bytes: &[u8]) -> bool {
    Type::from_xdr(v, bytes, limits(bytes.len())).is_ok()
}

pub fn generate(out: &str, per_type: usize, seed: &str) {
    let file = File::create(out).expect("output file");
    let mut gz = GzEncoder::new(file, Compression::best());
    let (mut valid, mut hostile, mut types_with_cases) = (0usize, 0usize, 0usize);
    let mut no_case: Vec<&str> = Vec::new();
    for v in TypeVariant::VARIANTS {
        let name = v.name();
        let mut seen = HashSet::new();
        // Small types (enums, booleans) have few distinct values: stop after a
        // run of attempts that add nothing new.
        let mut misses = 0;
        let mut i = 0;
        while seen.len() < per_type && misses < 64 && i < per_type * 32 {
            let e = entropy(seed, name, i, 8192);
            i += 1;
            let mut u = arbitrary::Unstructured::new(&e);
            let Ok(t) = Type::arbitrary(v, &mut u) else {
                misses += 1;
                continue;
            };
            let Ok(bytes) = t.to_xdr(Limits::none()) else {
                misses += 1;
                continue;
            };
            if bytes.len() > MAX_BYTES || !decodes(v, &bytes) || !seen.insert(bytes.clone()) {
                misses += 1;
                continue;
            }
            misses = 0;
            let b64 = |b: &[u8]| base64_encode(b);
            let mut line = |kind: &str, b: &[u8]| {
                writeln!(gz, "{}", json!({ "type": name, "kind": kind, "b64": b64(b) })).unwrap();
            };
            line("valid", &bytes);
            valid += 1;
            let mut trailing = bytes.clone();
            trailing.extend_from_slice(&[0, 0, 0, 0]);
            line("trailing", &trailing);
            hostile += 1;
            if !bytes.is_empty() {
                line("truncated", &bytes[..bytes.len() - 1]);
                hostile += 1;
            }
            if bytes.len() >= 4 {
                let mut bad = bytes.clone();
                bad[..4].copy_from_slice(&0x7FFF_FFFFu32.to_be_bytes());
                if !decodes(v, &bad) {
                    line("bad_first_word", &bad);
                    hostile += 1;
                }
            }
        }
        if seen.is_empty() {
            no_case.push(name);
        } else {
            types_with_cases += 1;
        }
    }
    gz.finish().unwrap();
    eprintln!(
        "{} types, {} with cases; {} valid and {} hostile cases; none for: {}",
        TypeVariant::VARIANTS.len(),
        types_with_cases,
        valid,
        hostile,
        no_case.join(", ")
    );
}

fn base64_encode(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(b)
}

/// Read a cases file: one JSON object per line.
pub fn read_cases(path: &str) -> Vec<Value> {
    let f = File::open(path).expect("cases file");
    BufReader::new(GzDecoder::new(f))
        .lines()
        .map(|l| serde_json::from_str(&l.unwrap()).unwrap())
        .collect()
}

pub fn check(path: &str) {
    let cases = read_cases(path);
    let mut by_kind: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut failures: Vec<Value> = Vec::new();
    for c in &cases {
        let kind = c["kind"].as_str().unwrap().to_string();
        let ty = c["type"].as_str().unwrap();
        let b64 = c["b64"].as_str().unwrap();
        let v = TypeVariant::from_str(ty).expect("known type");
        let decoded = Type::from_xdr_base64(v, b64, limits(b64.len()));
        let ok = if kind == "valid" {
            match &decoded {
                Ok(t) => t.to_xdr_base64(Limits::none()).map(|s| s == b64).unwrap_or(false),
                Err(_) => false,
            }
        } else {
            decoded.is_err()
        };
        let e = by_kind.entry(kind.clone()).or_default();
        e.0 += 1;
        if ok {
            e.1 += 1;
        } else if failures.len() < 200 {
            failures.push(json!({ "type": ty, "kind": kind, "b64": b64.chars().take(120).collect::<String>() }));
        }
    }
    let kinds: BTreeMap<_, _> = by_kind.iter().map(|(k, (n, p))| (k.clone(), json!({ "cases": n, "passed": p }))).collect();
    println!(
        "{}",
        json!({ "sdk": "rust", "package": "stellar-xdr", "version": "30.0.0", "cases": cases.len(), "supported": cases.len(),
                "passed": by_kind.values().map(|x| x.1).sum::<usize>(), "kinds": kinds, "failures": failures })
    );
}
