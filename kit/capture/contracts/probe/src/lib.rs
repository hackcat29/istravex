//! istravex-probe: puts exact ScVal shapes and authorization trees into real
//! ledger data on a standalone network (kit/capture/generate.mjs).
//!
//! - `put(key, val)` stores any value under `key` in persistent storage, so a
//!   map with colliding or host-ordered keys lands in the envelope (as an
//!   argument), in the transaction meta and in a ContractData ledger entry.
//! - `nest(who, next)` requires `who`'s authorization, then calls `nest` on the
//!   first contract in `next` with the rest. Soroban forbids re-entry, so the
//!   chain runs through separate instances of this contract, and the
//!   authorization tree is as deep as the chain is long.
#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env, Symbol, Val, Vec};

#[contract]
pub struct Probe;

#[contractimpl]
impl Probe {
    pub fn put(env: Env, key: Symbol, val: Val) {
        env.storage().persistent().set(&key, &val);
    }

    pub fn nest(env: Env, who: Address, next: Vec<Address>) -> u32 {
        who.require_auth();
        match next.first() {
            None => 1,
            Some(callee) => {
                let rest = next.slice(1..);
                let depth: u32 = ProbeClient::new(&env, &callee).nest(&who, &rest);
                depth + 1
            }
        }
    }
}
