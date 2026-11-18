#!/bin/sh
# Fetch ledgers from SDF's public data lake and decompress them to raw
# LedgerCloseMetaBatch XDR, for the SDK sweeps (.github/workflows/sweep.yml).
#   kit/sweep/fetch.sh <pubnet|testnet> <first> <last> <step> <out dir>
set -eu
net=$1; first=$2; last=$3; step=$4; out=$5
case $net in
  pubnet) lake=https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet ;;
  testnet) lake=https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/testnet/2025-12-18 ;;
  *) echo "network must be pubnet or testnet" >&2; exit 2 ;;
esac
mkdir -p "$out"
seq "$first" "$step" "$last" | xargs -P 32 -I{} sh -c '
  s={}; start=$(( s / 64000 * 64000 ))
  rev() { printf "%08X" $(( 4294967295 - $1 )); }
  url="'"$lake"'/$(rev $start)--$start-$(( start + 63999 ))/$(rev $s)--$s.xdr.zst"
  curl -fsS --retry 5 "$url" | zstd -q -d -o "'"$out"'/$s.xdr"
'
ls "$out" | wc -l
