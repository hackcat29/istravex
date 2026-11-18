//! RFP sightings stellar/rs-stellar-xdr#581 and #598, before and after.
//!
//! 581: decoding a VecM built its Vec by pushing, so Vec's doubling growth
//!      reserved more capacity than the length the decoder already knew. A
//!      5-element vec ends with capacity 8; the fix reserves exactly 5. Run as
//!      `check 581`.
//! 598: serde deserialize didn't enforce a VecM's maximum length: 21
//!      signatures deserialize into VecM<DecoratedSignature, 20> (a
//!      transaction's signatures) from JSON. Run as `check 598`.

use stellar_xdr::{DecoratedSignature, Limits, ReadXdr, ScVal, VecM};

fn main() {
    let which = std::env::args().nth(1).unwrap_or_default();
    let version = env!("XDR_VERSION");
    match which.as_str() {
        "581" => {
            // SCV_VEC, present, 5 elements, each SCV_U32.
            let mut bytes = vec![0, 0, 0, 0x10, 0, 0, 0, 1, 0, 0, 0, 5];
            for n in 0..5u8 {
                bytes.extend([0, 0, 0, 3, 0, 0, 0, n]);
            }
            let outcome = match ScVal::from_xdr(&bytes, Limits::none()) {
                Ok(ScVal::Vec(Some(v))) => {
                    let inner: Vec<ScVal> = v.0.into();
                    format!("len {} capacity {}", inner.len(), inner.capacity())
                }
                Ok(other) => format!("unexpected value {other:?}"),
                Err(e) => format!("error: {e}"),
            };
            println!("{{\"sighting\":\"stellar/rs-stellar-xdr#581\",\"stellar_xdr\":\"{version}\",\"outcome\":\"{outcome}\"}}");
        }
        "598" => {
            let one = r#"{"hint":"00000000","signature":""}"#;
            let json = format!("[{}]", vec![one; 21].join(","));
            let outcome = match serde_json::from_str::<VecM<DecoratedSignature, 20>>(&json) {
                Ok(v) => format!("accepted: {} signatures", v.len()),
                Err(e) => format!("error: {e}"),
            };
            println!("{{\"sighting\":\"stellar/rs-stellar-xdr#598\",\"stellar_xdr\":\"{version}\",\"outcome\":\"{}\"}}", outcome.replace('"', "'"));
        }
        _ => {
            eprintln!("usage: check 581|598");
            std::process::exit(2);
        }
    }
}
