<?php
// PHP conformance runner (soneso/stellar-php-sdk).
//
// Per fixture: decode, byte-exact re-encode, and for the generic profiles
// (tx, ledger) named checks against Horizon's values: the transaction hash
// from the SDK's own AbstractTransaction::hash, the rest from its SEP-51 JSON
// (toJsonValue). Files marked `expect: decode_error` pass when decoding fails
// cleanly. The hand-written patterns' native checks are n/a here.
//
//   composer install (kit/runners/php), then
//   php kit/runners/php/run.php [corpus dir]   → <corpus>/results/php.json

require __DIR__ . '/vendor/autoload.php';

use Soneso\StellarSDK\AbstractTransaction;
use Soneso\StellarSDK\Network;

$root = dirname(__DIR__, 3);
$corpus = realpath($argv[1] ?? $root . '/corpus');
$PASSPHRASE = ['pubnet' => 'Public Global Stellar Network ; September 2015', 'testnet' => 'Test SDF Network ; September 2015', 'local' => 'Standalone Network ; February 2017'];
// LedgerEntryChanges is an XDR typedef with no class here; its bytes are an OperationMeta.
$CLASS = ['LedgerEntryChanges' => 'OperationMeta', 'ScVal' => 'SCVal'];

function cls(string $type): string {
    global $CLASS;
    return 'Soneso\\StellarSDK\\Xdr\\Xdr' . ($CLASS[$type] ?? $type);
}

function decode(string $type, string $b64) {
    $c = cls($type);
    if (!class_exists($c)) throw new RuntimeException("no class $c");
    if ($type === 'TransactionEnvelope') return $c::fromEnvelopeBase64XdrString($b64);
    return $c::fromBase64Xdr($b64);
}

function js($v) { return json_decode(json_encode($v->toJsonValue()), true); }
function arm($v) { return is_string($v) ? $v : array_key_first($v); }

function gAccount(string $addr): string {
    if ($addr[0] !== 'M') return $addr;
    $m = Soneso\StellarSDK\MuxedAccount::fromMed25519AccountId($addr);
    return $m->getEd25519AccountId();
}

function txParts(array $env): array {
    if (isset($env['tx_fee_bump'])) { $o = $env['tx_fee_bump']; return [$o['tx']['inner_tx']['tx']['tx'], $o]; }
    if (isset($env['tx_v0'])) { $o = $env['tx_v0']; return [$o['tx'], $o]; }
    $o = $env['tx']; return [$o['tx'], $o];
}

function passphraseOf(array $m): string {
    global $PASSPHRASE;
    return $m['source']['generator']['network_passphrase'] ?? $PASSPHRASE[$m['network']];
}

function txProfile(array $m, array $blobs, array $dec): array {
    $e = $m['expected_decoded'];
    $env = js($dec['envelope']);
    $res = js($dec['result']);
    [$tx, $outer] = txParts($env);
    $rows = [
        ['tx_hash', $e['tx_hash'], fn() => bin2hex(AbstractTransaction::fromEnvelopeBase64XdrString($blobs['envelope'])->hash(new Network(passphraseOf($m))))],
        ['successful', $e['successful'] ? 'true' : 'false', fn() => in_array(arm($res['result']), ['tx_success', 'tx_fee_bump_inner_success'], true) ? 'true' : 'false'],
        ['source_account', $e['source_account'], fn() => gAccount($tx['source_account'] ?? '')],
        ['fee_charged', $e['fee_charged'], fn() => (string) $res['fee_charged']],
        ['max_fee', $e['max_fee'], fn() => (string) $outer['tx']['fee']],
        ['operation_count', (string) $e['operation_count'], fn() => (string) count($tx['operations'])],
        ['operation_types', $e['operation_types'], fn() => implode(',', array_map(fn($o) => arm($o['body']), $tx['operations']))],
        ['memo_type', $e['memo_type'], fn() => arm($tx['memo'])],
        ['signature_count', (string) $e['signature_count'], fn() => (string) count($outer['signatures'])],
    ];
    if (isset($e['fee_account'])) $rows[] = ['fee_account', $e['fee_account'], fn() => gAccount($env['tx_fee_bump']['tx']['fee_source'])];
    return $rows;
}

function ledgerProfile(array $m, array $dec): array {
    $e = $m['expected_decoded'];
    $lcm = js($dec['ledger']);
    $body = $lcm[array_key_first($lcm)];
    $h = $body['ledger_header']['header'];
    return [
        ['ledger_hash', $e['ledger_hash'], fn() => hash('sha256', base64_decode(Soneso\StellarSDK\Xdr\XdrLedgerHeader::fromJsonValue($h)->toBase64Xdr()))],
        ['prev_hash', $e['prev_hash'], fn() => $h['previous_ledger_hash']],
        ['sequence', (string) $e['sequence'], fn() => (string) $h['ledger_seq']],
        ['protocol_version', (string) $e['protocol_version'], fn() => (string) $h['ledger_version']],
        ['base_fee', $e['base_fee'], fn() => (string) $h['base_fee']],
        ['base_reserve', $e['base_reserve'], fn() => (string) $h['base_reserve']],
        ['max_tx_set_size', (string) $e['max_tx_set_size'], fn() => (string) $h['max_tx_set_size']],
        ['transaction_count', (string) $e['transaction_count'], fn() => (string) count($body['tx_processing'])],
        ['closed_at', $e['closed_at'], fn() => gmdate('Y-m-d\TH:i:s\Z', (int) $h['scp_value']['close_time'])],
    ];
}

// Muxed accounts in the hand-written fixtures: IDs are unsigned 64-bit, and
// the corpus has real ones above 2^63.
// The muxed id as an unsigned decimal string. getIdAsString() (added after
// 1.18.0, Soneso/stellar-php-sdk#226) is the SDK's own accessor for the full
// range; before it, getId() is the only one, and it returns ids from 2^63 up
// as negative two's complement integers (F-0021).
function muxedId($m): string {
    return method_exists($m, 'getIdAsString') ? (string) $m->getIdAsString() : (string) $m->getId();
}

function muxedChecks(array $m, array $dec): array {
    $e = $m['expected_decoded'] ?? [];
    $rows = [];
    if (isset($e['destination_muxed'], $e['muxed_id'])) {
        $rows[] = ['muxed_id', $e['muxed_id'], fn() => muxedId(Soneso\StellarSDK\MuxedAccount::fromMed25519AccountId($e['destination_muxed']))];
        $rows[] = ['destination_account', $e['destination_account'], fn() => Soneso\StellarSDK\MuxedAccount::fromMed25519AccountId($e['destination_muxed'])->getEd25519AccountId()];
        // The SDK's own M-address for the decoded payment destination.
        $rows[] = ['destination_muxed', $e['destination_muxed'], function () use ($dec, $e) {
            $tx = Soneso\StellarSDK\AbstractTransaction::fromEnvelopeBase64XdrString($dec['envelope']->toBase64Xdr());
            $inner = $tx instanceof Soneso\StellarSDK\FeeBumpTransaction ? $tx->getInnerTx() : $tx;
            return $inner->getOperations()[(int) ($e['op_index'] ?? 0)]->getDestination()->getAccountId();
        }];
    }
    if (isset($e['source_muxed'], $e['source_muxed_id'])) {
        $rows[] = ['source_muxed_id', $e['source_muxed_id'], fn() => muxedId(Soneso\StellarSDK\MuxedAccount::fromMed25519AccountId($e['source_muxed']))];
        $rows[] = ['source_muxed', $e['source_muxed'], function () use ($dec) {
            $tx = Soneso\StellarSDK\AbstractTransaction::fromEnvelopeBase64XdrString($dec['envelope']->toBase64Xdr());
            return $tx->getSourceAccount()->getAccountId();
        }];
    }
    return $rows;
}

function runFixture(array $m, array $blobs): array {
    $files = $m['files'];
    $detail = [];
    $failed = [];
    $negative = count(array_filter($files, fn($f) => ($f['expect'] ?? null) === 'decode_error'));
    if ($negative === count($files)) {
        $checks = ['decode' => 'pass', 'reencode' => 'n/a', 'native' => 'n/a'];
        foreach ($files as $f) {
            try {
                decode($f['xdr_type'], $blobs[$f['name']]);
            } catch (Throwable $t) {
                continue;
            }
            $checks['decode'] = 'fail';
            $failed[] = 'rejects:' . $f['name'];
            $detail[] = $f['name'] . ': decoded, but must be rejected';
        }
        return [$checks, $failed, $detail];
    }
    $checks = ['decode' => 'fail', 'reencode' => 'fail', 'native' => 'n/a'];
    $dec = [];
    try {
        foreach ($files as $f) $dec[$f['name']] = decode($f['xdr_type'], $blobs[$f['name']]);
    } catch (Throwable $t) {
        $failed[] = 'decode';
        $detail[] = 'decode: ' . substr(get_class($t) . ': ' . $t->getMessage(), 0, 200);
        return [$checks, $failed, $detail];
    }
    $checks['decode'] = 'pass';
    $bad = [];
    foreach ($files as $f) {
        try {
            if ($dec[$f['name']]->toBase64Xdr() !== $blobs[$f['name']]) $bad[] = $f['name'];
        } catch (Throwable $t) {
            $bad[] = $f['name'] . ' (' . substr($t->getMessage(), 0, 80) . ')';
        }
    }
    $checks['reencode'] = $bad ? 'fail' : 'pass';
    if ($bad) {
        $failed[] = 'reencode';
        $detail[] = 're-encode differs: ' . implode(', ', $bad);
    }
    try {
        $rows = match ($m['pattern']) {
            'tx' => txProfile($m, $blobs, $dec),
            'ledger' => ledgerProfile($m, $dec),
            default => muxedChecks($m, $dec),
        };
        if (!$rows) return [$checks, $failed, $detail];
    } catch (Throwable $t) {
        $checks['native'] = 'fail';
        $detail[] = substr($t->getMessage(), 0, 200);
        return [$checks, $failed, $detail];
    }
    $nf = [];
    foreach ($rows as [$name, $want, $got]) {
        try {
            $g = (string) $got();
        } catch (Throwable $t) {
            $g = 'threw: ' . substr($t->getMessage(), 0, 120);
        }
        if ($g !== (string) $want) {
            $nf[] = $name;
            $detail[] = "$name: expected " . substr((string) $want, 0, 80) . ", got " . substr($g, 0, 120);
        }
    }
    $failed = array_merge($failed, $nf);
    $checks['native'] = $nf ? 'fail' : 'pass';
    return [$checks, $failed, $detail];
}

$results = [];
$dirs = glob($corpus . '/fixtures/*/manifest.json');
sort($dirs);
foreach ($dirs as $mf) {
    $m = json_decode(file_get_contents($mf), true);
    $blobs = [];
    foreach ($m['files'] as $f) $blobs[$f['name']] = trim(file_get_contents(dirname($mf) . '/' . $f['path']));
    [$checks, $failed, $detail] = runFixture($m, $blobs);
    $results[] = ['fixture' => $m['id'], 'checks' => $checks, 'failed' => $failed, 'detail' => $detail];
    printf("%-44s %s %s\n", $m['id'], json_encode($checks), implode('; ', $detail));
}
$installed = json_decode(file_get_contents(__DIR__ . '/vendor/composer/installed.json'), true);
$pkgs = $installed['packages'] ?? $installed;
$sdk = array_values(array_filter($pkgs, fn($p) => $p['name'] === 'soneso/stellar-php-sdk'))[0];
$out = [
    'sdk' => 'php',
    'package' => 'soneso/stellar-php-sdk',
    'version' => ltrim($sdk['version'], 'v'),
    'runtime' => 'php ' . PHP_VERSION,
    'note' => 'Decode and byte-exact re-encode for every fixture; native checks for the tx and ledger profiles.',
    'results' => $results,
];
file_put_contents($corpus . '/results/php.json', json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
