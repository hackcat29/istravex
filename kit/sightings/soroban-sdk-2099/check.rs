//! RFP sighting stellar/rs-soroban-sdk#2099: MuxedAddress::try_from_val
//! panics on a non-address ScVal although it declares ConversionError.
//!
//! Converts a non-address ScVal of each kind, and the two ScAddress arms a
//! MuxedAddress can't hold, and reports per case: converted, error (the fix)
//! or panic (the bug). Built twice, against the last release before the fix
//! and the first with it (before/ and after/ pin the versions).

use soroban_sdk::{
    xdr::{ClaimableBalanceId, Hash, PoolId, ScAddress, ScVal},
    Env, MuxedAddress, TryFromVal,
};
use std::panic::{self, AssertUnwindSafe};

fn main() {
    panic::set_hook(Box::new(|_| {}));
    let env = Env::default();
    let cases: Vec<(&str, ScVal)> = vec![
        ("void", ScVal::Void),
        ("bool", ScVal::Bool(true)),
        ("u32", ScVal::U32(7)),
        ("i64", ScVal::I64(-7)),
        ("claimable balance address", ScVal::Address(ScAddress::ClaimableBalance(ClaimableBalanceId::ClaimableBalanceIdTypeV0(Hash([1; 32]))))),
        ("liquidity pool address", ScVal::Address(ScAddress::LiquidityPool(PoolId(Hash([2; 32]))))),
    ];
    let mut rows = Vec::new();
    for (name, val) in cases {
        let outcome = match panic::catch_unwind(AssertUnwindSafe(|| MuxedAddress::try_from_val(&env, &val))) {
            Ok(Ok(_)) => "converted",
            Ok(Err(_)) => "error",
            Err(_) => "panic",
        };
        rows.push(format!("{{\"case\":\"{name}\",\"outcome\":\"{outcome}\"}}"));
    }
    println!(
        "{{\"sighting\":\"stellar/rs-soroban-sdk#2099\",\"soroban_sdk\":\"{}\",\"results\":[{}]}}",
        env!("SDK_VERSION"),
        rows.join(",")
    );
}
