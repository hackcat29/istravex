//! RFP sightings stellar/rs-stellar-xdr#581 and #598, before and after.
//!
//! 581: decoding a VecM reserved capacity from the untrusted length prefix.
//!      A 12-byte ScVal claiming 2^32 - 1 vec elements made the decoder try to
//!      allocate hundreds of gigabytes before reading one element. Run as
//!      `check 581`; the workflow records an abort (allocation failure) as the
//!      bug and a clean error as the fix.
//! 598: serde deserialize didn't enforce a VecM's maximum length: a 33-byte
//!      symbol (ScSymbol is StringM<32>) was accepted from JSON. Run as
//!      `check 598`.

use stellar_xdr::curr::{Limits, ReadXdr, ScSymbol, ScVal};

fn main() {
    let which = std::env::args().nth(1).unwrap_or_default();
    let version = env!("XDR_VERSION");
    match which.as_str() {
        "581" => {
            // SCV_VEC, vec present, length 0xFFFFFFFF, and no elements.
            let bytes = [0, 0, 0, 0x10, 0, 0, 0, 1, 0xff, 0xff, 0xff, 0xff];
            let outcome = match ScVal::from_xdr(bytes, Limits::none()) {
                Ok(_) => "accepted".to_string(),
                Err(e) => format!("error: {e}"),
            };
            println!("{{\"sighting\":\"stellar/rs-stellar-xdr#581\",\"stellar_xdr\":\"{version}\",\"outcome\":\"{}\"}}", outcome.replace('"', "'"));
        }
        "598" => {
            let json = format!("\"{}\"", "a".repeat(33));
            let outcome = match serde_json::from_str::<ScSymbol>(&json) {
                Ok(s) => format!("accepted: {} bytes", s.0.len()),
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
