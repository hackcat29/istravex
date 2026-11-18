#!/bin/sh
# Fetch ledgers from SDF's public data lake and decompress them to raw
# LedgerCloseMetaBatch XDR, for the SDK sweeps (.github/workflows/sweep.yml).
# A ledger the lake does not hold (yet) is skipped.
#   kit/sweep/fetch.sh <pubnet|testnet> <first> <last> <step> <out dir>
set -eu
net=$1; first=$2; last=$3; step=$4; out=$5
case $net in
  pubnet) lake=https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet ;;
  testnet) lake=https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/testnet/2025-12-18 ;;
  *) echo "network must be pubnet or testnet" >&2; exit 2 ;;
esac
mkdir -p "$out"
export lake out
seq -f %.0f "$first" "$step" "$last" | xargs -P 32 -n 1 sh -c '
  s=$0; start=$(( s / 64000 * 64000 ))
  key=$(printf "%08X--%d-%d/%08X--%d.xdr.zst" $(( 4294967295 - start )) $start $(( start + 63999 )) $(( 4294967295 - s )) $s)
  if curl -fsS --retry 5 -o "$out/$s.xdr.zst" "$lake/$key" 2>/dev/null; then
    zstd -q -d --rm "$out/$s.xdr.zst" -o "$out/$s.xdr"
  else
    rm -f "$out/$s.xdr.zst"
  fi
'
echo "$(ls "$out" | grep -c '\.xdr$') ledgers in $out"
