---
title: "5. Signed-payload signers (CAP-0040)"
sidebar_label: "Signed-payload signers"
sidebar_position: 10
description: "The payload is part of the signer's identity."
---

:::warning Draft, not reviewed

This page has not yet been reviewed by a stellar-core or platform engineer and is not ready to publish.

:::

CAP-0040 added the signer type `SIGNER_KEY_TYPE_ED25519_SIGNED_PAYLOAD`: an ed25519 public key **and** a payload of 1 to 64 bytes. A signature only counts for this signer if it signs that payload. Its strkey is a `P…` address.

## The rule

Store the full `P…` key, not just the ed25519 key inside it. Two signers with the same key and different payloads are different signers, with different weights, and they authorise different things.

## What goes wrong

Code written before CAP-0040 often maps every signer to a `G…` key. For a signed-payload signer that loses the payload, and then:

- two distinct signers collapse into one row, and one weight overwrites the other;
- a security review of "who can sign for this account" shows a key that can't actually sign anything on its own.

Fixtures: `cap40-signed-payload-signer-testnet-0001` and `…-local-0001`. Every SDK round-trips the key and payload; [wallet-backend](https://docs.istravex.com/pilots/wallet-backend) stores the full `P…` key with its weight.
