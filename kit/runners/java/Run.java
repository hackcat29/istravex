// Java conformance runner (java-stellar-sdk, network.lightsail:stellar-sdk).
//
// Per fixture: decode, byte-exact re-encode, and named "native" checks of the
// SDK's high-level forms against the fixture's expected values. Files marked
// `expect: decode_error` pass when decoding fails cleanly.
//
// A single source file: no build tool. kit/runners/java/run.mjs fetches the
// pinned jars from Maven Central (sha256-checked) and runs
//   java -cp <jars> kit/runners/java/Run.java <corpus dir>
// which writes <corpus>/results/java.json.

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.Callable;
import java.util.stream.Collectors;
import org.stellar.sdk.AbstractTransaction;
import org.stellar.sdk.Address;
import org.stellar.sdk.Asset;
import org.stellar.sdk.AssetTypeCreditAlphaNum;
import org.stellar.sdk.ChangeTrustAsset;
import org.stellar.sdk.FeeBumpTransaction;
import org.stellar.sdk.LiquidityPool;
import org.stellar.sdk.MemoText;
import org.stellar.sdk.MuxedAccount;
import org.stellar.sdk.Network;
import org.stellar.sdk.StrKey;
import org.stellar.sdk.Transaction;
import org.stellar.sdk.operations.ChangeTrustOperation;
import org.stellar.sdk.operations.PaymentOperation;
import org.stellar.sdk.scval.Scv;
import org.stellar.sdk.xdr.LedgerEntryChange;
import org.stellar.sdk.xdr.LedgerEntry.LedgerEntryData;
import org.stellar.sdk.xdr.SCMapEntry;
import org.stellar.sdk.xdr.SCVal;
import org.stellar.sdk.xdr.SorobanAuthorizedInvocation;
import org.stellar.sdk.xdr.TransactionEnvelope;
import org.stellar.sdk.xdr.TransactionMeta;
import org.stellar.sdk.xdr.TrustLineEntry;

public class Run {
  record Check(String name, String want, Callable<String> got) {}

  static final Map<String, String> PASSPHRASE =
      Map.of(
          "pubnet", "Public Global Stellar Network ; September 2015",
          "testnet", "Test SDF Network ; September 2015",
          "local", "Standalone Network ; February 2017");

  // XDR type names as the manifest writes them → the SDK's classes (nested where the SDK nests them).
  static final Map<String, String> CLASS = Map.of("LedgerEntryData", "LedgerEntry$LedgerEntryData", "ScVal", "SCVal");

  static Object decode(String type, String b64) throws Exception {
    try {
      return Class.forName("org.stellar.sdk.xdr." + CLASS.getOrDefault(type, type)).getMethod("fromXdrBase64", String.class).invoke(null, b64);
    } catch (java.lang.reflect.InvocationTargetException ex) {
      throw ex.getCause() instanceof Exception c ? c : ex;
    }
  }

  static String encode(Object v) throws Exception {
    return (String) v.getClass().getMethod("toXdrBase64").invoke(v);
  }

  static String str(JsonObject o, String k) {
    if (o == null || !o.has(k) || o.get(k).isJsonNull()) return null;
    JsonElement e = o.get(k);
    if (e.isJsonArray()) {
      List<String> parts = new ArrayList<>();
      for (JsonElement x : e.getAsJsonArray()) parts.add(x.getAsString());
      return String.join(",", parts);
    }
    return e.getAsString();
  }

  static String asset(Asset a) {
    if (a instanceof AssetTypeCreditAlphaNum c) return c.getCode() + ":" + c.getIssuer();
    return "native";
  }

  static String amount7(BigDecimal a) {
    return a.setScale(7).toPlainString();
  }

  static String account(org.stellar.sdk.xdr.AccountID id) {
    return StrKey.encodeEd25519PublicKey(id.getAccountID().getEd25519().getUint256());
  }

  static Transaction inner(AbstractTransaction t) {
    return t instanceof FeeBumpTransaction f ? f.getInnerTransaction() : (Transaction) t;
  }

  static List<Check> checks(JsonObject m, Map<String, String> blobs, Map<String, Object> dec) throws Exception {
    JsonObject e = m.has("expected_decoded") ? m.getAsJsonObject("expected_decoded") : new JsonObject();
    JsonObject ix = m.has("expected_indexed") ? m.getAsJsonObject("expected_indexed") : new JsonObject();
    JsonObject gen = m.getAsJsonObject("source").has("generator") ? m.getAsJsonObject("source").getAsJsonObject("generator") : null;
    String pp = gen != null && gen.has("network_passphrase") ? gen.get("network_passphrase").getAsString() : PASSPHRASE.get(m.get("network").getAsString());
    Network net = new Network(pp);
    Callable<AbstractTransaction> tx = () -> AbstractTransaction.fromEnvelopeXdr(blobs.get("envelope"), net);
    TransactionEnvelope env = (TransactionEnvelope) dec.get("envelope");
    String p = m.get("pattern").getAsString();
    switch (p) {
      case "muxed-payment": {
        int i = e.has("op_index") ? e.get("op_index").getAsInt() : 0;
        Callable<PaymentOperation> pay = () -> (PaymentOperation) inner(tx.call()).getOperations()[i];
        Callable<MuxedAccount> dest = () -> new MuxedAccount(pay.call().getDestination());
        return List.of(
            new Check("destination_muxed", str(e, "destination_muxed"), () -> pay.call().getDestination()),
            new Check("muxed_id", str(e, "muxed_id"), () -> dest.call().getMuxedId().toString()),
            new Check("destination_account", str(e, "destination_account"), () -> dest.call().getAccountId()),
            new Check("asset", str(e, "asset"), () -> asset(pay.call().getAsset())),
            new Check("amount", str(e, "amount"), () -> amount7(pay.call().getAmount())));
      }
      case "fee-bump": {
        Callable<FeeBumpTransaction> fb = () -> (FeeBumpTransaction) tx.call();
        return List.of(
            new Check("tx_hash", str(e, "tx_hash"), () -> fb.call().hashHex()),
            new Check("inner_tx_hash", str(e, "inner_tx_hash"), () -> fb.call().getInnerTransaction().hashHex()),
            new Check("fee_source", str(e, "fee_source"), () -> fb.call().getFeeSource()),
            new Check("inner_source", str(e, "inner_source"), () -> fb.call().getInnerTransaction().getSourceAccount()));
      }
      case "signed-payload-signer": {
        var signer = ((LedgerEntryData) dec.get("ledger_entry")).getAccount().getSigners()[0];
        var sp = signer.getKey().getEd25519SignedPayload();
        return List.of(
            new Check("signer_strkey", str(e, "signer_strkey"), () -> StrKey.encodeSignedPayload(sp.toXdrByteArray())),
            new Check("signer_ed25519", str(e, "signer_ed25519"), () -> StrKey.encodeEd25519PublicKey(sp.getEd25519().getUint256())),
            new Check("payload_hex", str(e, "payload_hex"), () -> hex(sp.getPayload())),
            new Check("weight", str(e, "weight"), () -> signer.getWeight().getUint32().getNumber().toString()));
      }
      case "sac-trust": {
        Callable<List<TrustLineEntry>> created =
            () -> {
              List<TrustLineEntry> out = new ArrayList<>();
              for (var op : ((TransactionMeta) dec.get("meta")).getV4().getOperations())
                for (LedgerEntryChange c : op.getChanges().getLedgerEntryChanges())
                  if (c.getCreated() != null && c.getCreated().getData().getTrustLine() != null) out.add(c.getCreated().getData().getTrustLine());
              return out;
            };
        return List.of(
            new Check("trustline_created", "true", () -> String.valueOf(created.call().size() == 1)),
            new Check("account", str(ix, "account"), () -> account(created.call().get(0).getAccountID())),
            new Check(
                "asset",
                str(ix, "asset"),
                () -> {
                  var a = created.call().get(0).getAsset().getAlphaNum4();
                  return new String(a.getAssetCode().getAssetCode4()).replace("\0", "") + ":" + account(a.getIssuer());
                }),
            new Check("limit", str(ix, "limit"), () -> created.call().get(0).getLimit().getInt64().toString()));
      }
      case "muxed-max-id": {
        Callable<Transaction> t = () -> (Transaction) tx.call();
        Callable<MuxedAccount> src = () -> new MuxedAccount(t.call().getSourceAccount());
        Callable<PaymentOperation> pay = () -> (PaymentOperation) t.call().getOperations()[0];
        return List.of(
            new Check("source_muxed", str(e, "source_muxed"), () -> t.call().getSourceAccount()),
            new Check("source_muxed_id", str(e, "source_muxed_id"), () -> src.call().getMuxedId().toString()),
            new Check("source_account", str(e, "source_account"), () -> src.call().getAccountId()),
            new Check("destination_muxed_id", str(e, "destination_muxed_id"), () -> new MuxedAccount(pay.call().getDestination()).getMuxedId().toString()),
            new Check("destination_account", str(e, "destination_account"), () -> new MuxedAccount(pay.call().getDestination()).getAccountId()),
            new Check("amount", str(e, "amount"), () -> amount7(pay.call().getAmount())),
            new Check("muxed_address_roundtrip", str(e, "destination_muxed_id"), () -> new MuxedAccount(str(e, "destination_muxed")).getMuxedId().toString()));
      }
      case "pool-issuer-order": {
        String[] a = str(e, "asset_a").split(":"), b = str(e, "asset_b").split(":");
        Asset A = Asset.createNonNativeAsset(a[0], a[1]), B = Asset.createNonNativeAsset(b[0], b[1]);
        Callable<LiquidityPool> line = () -> ((ChangeTrustOperation) ((Transaction) tx.call()).getOperations()[2]).getAsset().getLiquidityPool();
        return List.of(
            new Check("decode_pool_share_op", str(e, "asset_a") + "/" + str(e, "asset_b"), () -> asset(line.call().getAssetA()) + "/" + asset(line.call().getAssetB())),
            new Check("asset_compare", "-1", () -> A.compareTo(B) < 0 ? "-1" : "1"),
            new Check("pool_id", str(e, "pool_id"), () -> new LiquidityPool(A, B).getLiquidityPoolId()));
      }
      case "memo-non-utf8":
        return List.of(
            new Check("memo_bytes", str(e, "memo_hex"), () -> hex(((MemoText) ((Transaction) tx.call()).getMemo()).getBytes())),
            new Check("transaction_roundtrip", blobs.get("envelope"), () -> tx.call().toEnvelopeXdrBase64()));
      case "max-length-vectors": {
        return List.of(
            new Check("operation_count", str(e, "operation_count"), () -> String.valueOf(env.getV1().getTx().getOperations().length)),
            new Check("signature_count", str(e, "signature_count"), () -> String.valueOf(((TransactionEnvelope) dec.get("envelope_signatures")).getV1().getSignatures().length)),
            new Check("signer_count", str(e, "signer_count"), () -> String.valueOf(((LedgerEntryData) dec.get("ledger_entry")).getAccount().getSigners().length)),
            new Check(
                "thresholds",
                str(e, "thresholds"),
                () -> {
                  byte[] t = ((LedgerEntryData) dec.get("ledger_entry")).getAccount().getThresholds().getThresholds();
                  return (t[1] & 0xff) + "," + (t[2] & 0xff) + "," + (t[3] & 0xff);
                }));
      }
      case "max-amount": {
        Callable<PaymentOperation> pay = () -> (PaymentOperation) ((Transaction) tx.call()).getOperations()[0];
        return List.of(
            new Check("amount", str(e, "amount"), () -> amount7(pay.call().getAmount())),
            new Check("amount_stroops", str(e, "amount_stroops"), () -> env.getV1().getTx().getOperations()[0].getBody().getPaymentOp().getAmount().getInt64().toString()),
            new Check("asset", str(e, "asset"), () -> asset(pay.call().getAsset())));
      }
      case "scmap-host-order": {
        SCVal map = ((LedgerEntryData) dec.get("ledger_entry")).getContractData().getVal();
        SCMapEntry[] entries = map.getMap().getSCMap();
        return List.of(
            new Check("entry_count", str(e, "entry_count"), () -> String.valueOf(entries.length)),
            new Check("key_order_preserved", str(e, "keys_xdr"), () -> java.util.Arrays.stream(entries).map(x -> unchecked(() -> x.getKey().toXdrBase64())).collect(Collectors.joining(","))),
            new Check(
                "sorted_map_matches_host",
                map.toXdrBase64(),
                () -> {
                  // Scv.toMap(Map) orders the keys itself; hand it the entries reversed.
                  Map<SCVal, SCVal> m2 = new LinkedHashMap<>();
                  List<SCMapEntry> rev = new ArrayList<>(List.of(entries));
                  Collections.reverse(rev);
                  for (SCMapEntry x : rev) m2.put(x.getKey(), x.getVal());
                  return Scv.toMap((Map<SCVal, SCVal>) m2).toXdrBase64();
                }),
            new Check("native_keeps_every_entry", "all entries or an error", () -> {
              try {
                return Scv.fromMap(map).size() == entries.length ? "all entries or an error" : Scv.fromMap(map).size() + " of " + entries.length + " entries, no error";
              } catch (Exception ex) {
                return "all entries or an error";
              }
            }));
      }
      case "nested-auth": {
        Callable<int[]> walk =
            () -> {
              SorobanAuthorizedInvocation root = env.getV1().getTx().getOperations()[0].getBody().getInvokeHostFunctionOp().getAuth()[0].getRootInvocation();
              int depth = 0, count = 0;
              List<Object[]> stack = new ArrayList<>();
              stack.add(new Object[] {root, 1});
              while (!stack.isEmpty()) {
                Object[] it = stack.remove(stack.size() - 1);
                int d = (int) it[1];
                if (d > 100) throw new IllegalStateException("authorization tree deeper than 100 (the host's own limit)");
                depth = Math.max(depth, d);
                count++;
                for (SorobanAuthorizedInvocation s : ((SorobanAuthorizedInvocation) it[0]).getSubInvocations()) stack.add(new Object[] {s, d + 1});
              }
              return new int[] {depth, count};
            };
        return List.of(
            new Check("auth_depth", str(e, "auth_depth"), () -> String.valueOf(walk.call()[0])),
            new Check("auth_invocations", str(e, "auth_invocations"), () -> String.valueOf(walk.call()[1])),
            new Check(
                "root_contract",
                str(e, "root_contract"),
                () -> Address.fromSCAddress(env.getV1().getTx().getOperations()[0].getBody().getInvokeHostFunctionOp().getAuth()[0].getRootInvocation().getFunction().getContractFn().getContractAddress()).toString()),
            new Check("return_value", str(e, "return_u32"), () -> ((TransactionMeta) dec.get("meta")).getV4().getSorobanMeta().getReturnValue().getU32().getUint32().getNumber().toString()));
      }
      case "muxed-soroban-source": {
        Callable<MuxedAccount> src = () -> MuxedAccount.fromXdr(env.getV1().getTx().getSourceAccount());
        return List.of(
            new Check("source_account", str(e, "source_account"), () -> src.call().getAccountId()),
            new Check("source_muxed_id", str(e, "source_muxed_id"), () -> src.call().getMuxedId().toString()),
            new Check("operation", str(e, "operation"), () -> env.getV1().getTx().getOperations()[0].getBody().getExtendFootprintTTLOp() != null ? "extendFootprintTtl" : "other"));
      }
      case "tx":
        return txProfile(e, tx, env, (org.stellar.sdk.xdr.TransactionResult) dec.get("result"));
      case "ledger":
        return ledgerProfile(e, (org.stellar.sdk.xdr.LedgerCloseMeta) dec.get("ledger"));
      default:
        throw new IllegalArgumentException("no native check for pattern " + p);
    }
  }

  // Generic profiles for fixtures chosen by set cover (kit/capture/shapes.mjs).
  // Expected values come from Horizon; the SDK reads them from raw XDR.

  static String gAccount(String address) {
    return address.startsWith("M") ? new MuxedAccount(address).getAccountId() : address;
  }

  /** The transaction that carries the operations. */
  static org.stellar.sdk.xdr.Operation[] ops(TransactionEnvelope env) {
    return switch (env.getDiscriminant()) {
      case ENVELOPE_TYPE_TX_FEE_BUMP -> env.getFeeBump().getTx().getInnerTx().getV1().getTx().getOperations();
      case ENVELOPE_TYPE_TX_V0 -> env.getV0().getTx().getOperations();
      default -> env.getV1().getTx().getOperations();
    };
  }

  static org.stellar.sdk.xdr.Memo memo(TransactionEnvelope env) {
    return switch (env.getDiscriminant()) {
      case ENVELOPE_TYPE_TX_FEE_BUMP -> env.getFeeBump().getTx().getInnerTx().getV1().getTx().getMemo();
      case ENVELOPE_TYPE_TX_V0 -> env.getV0().getTx().getMemo();
      default -> env.getV1().getTx().getMemo();
    };
  }

  static List<Check> txProfile(JsonObject e, Callable<AbstractTransaction> tx, TransactionEnvelope env, org.stellar.sdk.xdr.TransactionResult res) {
    List<Check> out = new ArrayList<>(List.of(
        new Check("tx_hash", str(e, "tx_hash"), () -> tx.call().hashHex()),
        new Check("successful", str(e, "successful"), () -> String.valueOf(
            res.getResult().getDiscriminant().name().equals("txSUCCESS") || res.getResult().getDiscriminant().name().equals("txFEE_BUMP_INNER_SUCCESS"))),
        new Check("source_account", str(e, "source_account"), () -> gAccount(inner(tx.call()).getSourceAccount())),
        new Check("fee_charged", str(e, "fee_charged"), () -> res.getFeeCharged().getInt64().toString()),
        new Check("max_fee", str(e, "max_fee"), () -> switch (env.getDiscriminant()) {
          case ENVELOPE_TYPE_TX_FEE_BUMP -> env.getFeeBump().getTx().getFee().getInt64().toString();
          case ENVELOPE_TYPE_TX_V0 -> env.getV0().getTx().getFee().getUint32().getNumber().toString();
          default -> env.getV1().getTx().getFee().getUint32().getNumber().toString();
        }),
        new Check("operation_count", str(e, "operation_count"), () -> String.valueOf(ops(env).length)),
        new Check("operation_types", str(e, "operation_types"), () -> java.util.Arrays.stream(ops(env)).map(o -> o.getBody().getDiscriminant().name().toLowerCase()).collect(Collectors.joining(","))),
        new Check("memo_type", str(e, "memo_type"), () -> memo(env).getDiscriminant().name().toLowerCase().replaceFirst("^memo_", "")),
        new Check("signature_count", str(e, "signature_count"), () -> String.valueOf(switch (env.getDiscriminant()) {
          case ENVELOPE_TYPE_TX_FEE_BUMP -> env.getFeeBump().getSignatures().length;
          case ENVELOPE_TYPE_TX_V0 -> env.getV0().getSignatures().length;
          default -> env.getV1().getSignatures().length;
        }))));
    if (e.has("fee_account")) out.add(new Check("fee_account", str(e, "fee_account"), () -> gAccount(((FeeBumpTransaction) tx.call()).getFeeSource())));
    return out;
  }

  static List<Check> ledgerProfile(JsonObject e, org.stellar.sdk.xdr.LedgerCloseMeta lcm) {
    Callable<org.stellar.sdk.xdr.LedgerHeader> h = () -> switch (lcm.getDiscriminant()) {
      case 0 -> lcm.getV0().getLedgerHeader().getHeader();
      case 1 -> lcm.getV1().getLedgerHeader().getHeader();
      default -> lcm.getV2().getLedgerHeader().getHeader();
    };
    Callable<Integer> txs = () -> switch (lcm.getDiscriminant()) {
      case 0 -> lcm.getV0().getTxProcessing().length;
      case 1 -> lcm.getV1().getTxProcessing().length;
      default -> lcm.getV2().getTxProcessing().length;
    };
    return List.of(
        new Check("ledger_hash", str(e, "ledger_hash"), () -> hex(java.security.MessageDigest.getInstance("SHA-256").digest(h.call().toXdrByteArray()))),
        new Check("prev_hash", str(e, "prev_hash"), () -> hex(h.call().getPreviousLedgerHash().getHash())),
        new Check("sequence", str(e, "sequence"), () -> h.call().getLedgerSeq().getUint32().getNumber().toString()),
        new Check("protocol_version", str(e, "protocol_version"), () -> h.call().getLedgerVersion().getUint32().getNumber().toString()),
        new Check("base_fee", str(e, "base_fee"), () -> h.call().getBaseFee().getUint32().getNumber().toString()),
        new Check("base_reserve", str(e, "base_reserve"), () -> h.call().getBaseReserve().getUint32().getNumber().toString()),
        new Check("max_tx_set_size", str(e, "max_tx_set_size"), () -> h.call().getMaxTxSetSize().getUint32().getNumber().toString()),
        new Check("transaction_count", str(e, "transaction_count"), () -> String.valueOf(txs.call())),
        new Check("closed_at", str(e, "closed_at"), () -> java.time.Instant.ofEpochSecond(h.call().getScpValue().getCloseTime().getTimePoint().getUint64().getNumber().longValue()).toString()));
  }

  interface Thrower<T> {
    T get() throws Exception;
  }

  static <T> T unchecked(Thrower<T> f) {
    try {
      return f.get();
    } catch (Exception ex) {
      throw new RuntimeException(ex);
    }
  }

  static String hex(byte[] b) {
    StringBuilder s = new StringBuilder();
    for (byte x : b) s.append(String.format("%02x", x));
    return s.toString();
  }

  public static void main(String[] args) throws Exception {
    Path corpus = Path.of(args.length > 0 ? args[0] : "corpus").toAbsolutePath();
    List<Path> manifests;
    try (var s = Files.list(corpus.resolve("fixtures"))) {
      manifests = s.map(d -> d.resolve("manifest.json")).filter(Files::exists).sorted().toList();
    }
    List<Map<String, Object>> results = new ArrayList<>();
    for (Path mf : manifests) {
      JsonObject m = JsonParser.parseString(Files.readString(mf)).getAsJsonObject();
      Map<String, String> blobs = new TreeMap<>();
      JsonArray files = m.getAsJsonArray("files");
      for (JsonElement f : files) blobs.put(f.getAsJsonObject().get("name").getAsString(), Files.readString(mf.getParent().resolve(f.getAsJsonObject().get("path").getAsString())).trim());
      Map<String, String> chk = new LinkedHashMap<>();
      List<String> failed = new ArrayList<>(), detail = new ArrayList<>();
      boolean negative = files.size() > 0;
      for (JsonElement f : files) negative &= "decode_error".equals(str(f.getAsJsonObject(), "expect"));
      if (negative) {
        chk.put("decode", "pass");
        chk.put("reencode", "n/a");
        chk.put("native", "n/a");
        for (JsonElement f : files) {
          String name = f.getAsJsonObject().get("name").getAsString();
          try {
            decode(f.getAsJsonObject().get("xdr_type").getAsString(), blobs.get(name));
            chk.put("decode", "fail");
            failed.add("rejects:" + name);
            detail.add(name + ": decoded, but must be rejected");
          } catch (Throwable ex) {
            // refused, as it must be
          }
        }
      } else {
        chk.put("decode", "fail");
        chk.put("reencode", "fail");
        chk.put("native", "fail");
        Map<String, Object> dec = new TreeMap<>();
        try {
          for (JsonElement f : files) {
            String name = f.getAsJsonObject().get("name").getAsString();
            dec.put(name, decode(f.getAsJsonObject().get("xdr_type").getAsString(), blobs.get(name)));
          }
          chk.put("decode", "pass");
          List<String> bad = new ArrayList<>();
          for (var en : dec.entrySet()) if (!encode(en.getValue()).equals(blobs.get(en.getKey()))) bad.add(en.getKey());
          chk.put("reencode", bad.isEmpty() ? "pass" : "fail");
          if (!bad.isEmpty()) detail.add("re-encode differs: " + String.join(", ", bad));
          for (Check c : checks(m, blobs, dec)) {
            if (c.want() == null) continue; // this fixture doesn't carry the value
            String got;
            try {
              got = c.got().call();
            } catch (Throwable ex) {
              got = "threw: " + ex;
            }
            if (!c.want().equals(got)) {
              failed.add(c.name());
              detail.add(c.name() + ": expected " + c.want() + ", got " + (got.length() > 160 ? got.substring(0, 160) : got));
            }
          }
          chk.put("native", failed.isEmpty() ? "pass" : "fail");
        } catch (Throwable ex) {
          detail.add(String.valueOf(ex.getCause() != null ? ex.getCause() : ex));
        }
      }
      String id = m.get("id").getAsString();
      System.out.printf("%-44s %s %s%n", id, chk, String.join("; ", detail));
      Map<String, Object> r = new LinkedHashMap<>();
      r.put("fixture", id);
      r.put("checks", chk);
      r.put("failed", failed);
      r.put("detail", detail);
      results.add(r);
    }
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("sdk", "java");
    out.put("package", "network.lightsail:stellar-sdk");
    out.put("version", System.getProperty("istravex.sdkVersion", "unknown"));
    out.put("runtime", "java " + System.getProperty("java.version"));
    out.put("results", results);
    Gson gson = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();
    Files.writeString(corpus.resolve("results").resolve("java.json"), gson.toJson(out) + "\n");
  }
}
