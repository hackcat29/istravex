<?php
// Generated cases through soneso/stellar-php-sdk: every valid case must decode
// and re-encode byte for byte; every hostile one (trailing bytes, truncation,
// a bad first word) must be refused. Types without an XDR class are counted
// as unsupported.
//
//   php kit/runners/php/cases.php corpus/generated/cases.jsonl.gz > corpus/results/cases-php.json

require __DIR__ . '/vendor/autoload.php';

$path = $argv[1];
$dir = __DIR__ . '/vendor/soneso/stellar-php-sdk/Soneso/StellarSDK/Xdr';
$byName = [];
foreach (glob($dir . '/Xdr*.php') as $file) {
    $cls = basename($file, '.php');
    $byName[strtolower(substr($cls, 3))] = 'Soneso\\StellarSDK\\Xdr\\' . $cls;
}

$kinds = [];
$failing = [];
$unsupported = [];
$fails = [];
$n = 0;
$lines = array_filter(explode("\n", gzdecode(file_get_contents($path))), fn($l) => $l !== "");
foreach ($lines as $line) {
    $c = json_decode($line, true);
    $type = $c['type'];
    $kind = $c['kind'];
    $b64 = $c['b64'];
    $n++;
    $kinds[$kind] ??= ['cases' => 0, 'supported' => 0, 'passed' => 0];
    $kinds[$kind]['cases']++;
    $cls = $byName[strtolower($type)] ?? null;
    if ($cls === null || !method_exists($cls, 'fromBase64Xdr')) {
        $unsupported[$type] = true;
        continue;
    }
    $kinds[$kind]['supported']++;
    try {
        $v = $type === 'TransactionEnvelope' ? $cls::fromEnvelopeBase64XdrString($b64) : $cls::fromBase64Xdr($b64);
        $pass = $kind === 'valid' ? ($v->toBase64Xdr() === $b64) : false;
    } catch (Throwable $t) {
        $pass = $kind !== 'valid';
    }
    if ($pass) {
        $kinds[$kind]['passed']++;
    } else {
        $failing[$kind][$type] = ($failing[$kind][$type] ?? 0) + 1;
        if (count($fails) < 200) $fails[] = ['type' => $type, 'kind' => $kind, 'b64' => substr($b64, 0, 120)];
    }
}
foreach ($failing as &$t) ksort($t);
ksort($unsupported);
$installed = json_decode(file_get_contents(__DIR__ . '/vendor/composer/installed.json'), true);
$pkgs = $installed['packages'] ?? $installed;
$sdk = array_values(array_filter($pkgs, fn($p) => $p['name'] === 'soneso/stellar-php-sdk'))[0];
echo json_encode([
    'sdk' => 'php',
    'package' => 'soneso/stellar-php-sdk',
    'version' => ltrim($sdk['version'], 'v'),
    'cases' => $n,
    'supported' => array_sum(array_column($kinds, 'supported')),
    'passed' => array_sum(array_column($kinds, 'passed')),
    'kinds' => $kinds,
    'failing_types' => $failing ?: new stdClass(),
    'unsupported_types' => array_keys($unsupported),
    'failures' => $fails,
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
