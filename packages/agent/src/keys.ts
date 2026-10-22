// The agent key: an ed25519 key pair made on this machine, kept in ~/.nearswaps-agent/<account>.json (mode 600),
// added to the owner's account by the owner (nearswaps.com/agents) as a function-call key for nekoorders.near,
// methods trade, withdraw and recover_trade. The kit refuses to run with any other key: a full-access key in that file is an
// error, not a feature. Keys use near-api-js's text form ("ed25519:" + base58), so near-cli reads the same file.
import { createPrivateKey, generateKeyPairSync, sign as edSign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { b58decode, b58encode } from "./codec.js";
import { ACCOUNT_RE, IMPLICIT_RE, KEY_METHODS, ORDERS } from "./constants.js";

export interface AgentKey {
  accountId: string;
  /** "ed25519:<base58 of 32 bytes>" */
  publicKey: string;
  /** "ed25519:<base58 of 64 bytes: seed then public key>" */
  secretKey: string;
}

export const isAccountId = (a: string): boolean => ACCOUNT_RE.test(a) || IMPLICIT_RE.test(a);
export const keyDir = (home?: string): string => join(home || homedir(), ".nearswaps-agent");
export const keyPath = (accountId: string, home?: string): string => {
  if (!isAccountId(accountId)) throw new Error(`"${accountId}" is not a NEAR account id`);
  return join(keyDir(home), accountId + ".json");
};

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const fromB64url = (s: string) => Uint8Array.from(Buffer.from(s, "base64url"));

/** A new key pair (KeyPair.fromRandom("ed25519") in near-api-js terms). */
export function newKeyPair(accountId: string): AgentKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
  const seed = fromB64url(jwk.d), pub = fromB64url(jwk.x);
  const secret = new Uint8Array(64); secret.set(seed, 0); secret.set(pub, 32);
  return { accountId, publicKey: "ed25519:" + b58encode(pub), secretKey: "ed25519:" + b58encode(secret) };
}

/** The 32 raw bytes of an "ed25519:..." public key. */
export function publicKeyBytes(pk: string): Uint8Array {
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(String(pk || ""));
  if (!m) throw new Error("not an ed25519 public key");
  const b = b58decode(m[1]);
  if (b.length !== 32) throw new Error("not an ed25519 public key");
  return b;
}

function secretParts(sk: string): { seed: Uint8Array; pub: Uint8Array } {
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]{60,100})$/.exec(String(sk || ""));
  if (!m) throw new Error("the key file's private_key is not an ed25519 secret key");
  const b = b58decode(m[1]);
  if (b.length !== 64) throw new Error("the key file's private_key is not an ed25519 secret key");
  return { seed: b.slice(0, 32), pub: b.slice(32) };
}

/** Sign bytes (a transaction hash) with the agent key. */
export function signBytes(key: AgentKey, message: Uint8Array): Uint8Array {
  const { seed, pub } = secretParts(key.secretKey);
  const k = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: b64url(seed), x: b64url(pub) }, format: "jwk" });
  return Uint8Array.from(edSign(null, Buffer.from(message), k));
}

/** The key file's pair is one pair: the public key is the one the secret derives. */
function checkPair(key: AgentKey): void {
  const { seed, pub } = secretParts(key.secretKey);
  const k = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: b64url(seed), x: b64url(pub) }, format: "jwk" });
  const derived = fromB64url((k.export({ format: "jwk" }) as { x: string }).x);
  if (b58encode(derived) !== b58encode(publicKeyBytes(key.publicKey)) || b58encode(derived) !== b58encode(pub)) {
    throw new Error("the key file's public_key does not belong to its private_key");
  }
}

/** Write a new key file. Never overwrites one: an existing key may be the one on the owner's account. */
export function saveKey(key: AgentKey, home?: string): string {
  const dir = keyDir(home), path = keyPath(key.accountId, home);
  if (existsSync(path)) throw new Error(`a key for ${key.accountId} already exists at ${path}; remove its key on nearswaps.com/agents and delete the file first if you mean to replace it`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = { account_id: key.accountId, public_key: key.publicKey, private_key: key.secretKey, receiver_id: ORDERS, methods: [...KEY_METHODS], created_at: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  try { chmodSync(path, 0o600); } catch (e) { /* Windows keeps its own file permissions */ }
  return path;
}

export function loadKey(accountId: string, home?: string): AgentKey {
  const path = keyPath(accountId, home);
  if (!existsSync(path)) throw new Error(`no agent key for ${accountId}: run "nearswaps-agent key new ${accountId}" first`);
  let j: { account_id?: string; public_key?: string; private_key?: string };
  try { j = JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new Error(`the key file ${path} is not valid JSON`); }
  if (j.account_id !== accountId) throw new Error(`the key file ${path} is for ${j.account_id}, not ${accountId}`);
  const key = { accountId, publicKey: String(j.public_key || ""), secretKey: String(j.private_key || "") };
  publicKeyBytes(key.publicKey);
  checkPair(key);
  return key;
}

/** What view_access_key answers (the permission part). */
export type AccessKeyView = {
  nonce?: number | string;
  permission?: "FullAccess" | { FunctionCall?: { receiver_id?: string; method_names?: string[]; allowance?: string | null } };
};

export interface KeyCheck { ok: boolean; reason: string }

const WANT = "trade, withdraw and recover_trade";

/** On only when the permission is exactly the agent key's: nekoorders.near, trade, withdraw AND recover_trade, nothing
 * else (the shape of oneclick.js loadKey's test, with recover_trade added; the Terminal's own two-method 1-click key is
 * therefore never taken for an agent key). */
export function checkPermission(ak: AccessKeyView | null | undefined): KeyCheck {
  if (!ak || !ak.permission) return { ok: false, reason: "the key is not on the account" };
  if (ak.permission === "FullAccess") return { ok: false, reason: "this is a full-access key; the kit only runs with a function-call key for nekoorders.near (trade, withdraw, recover_trade)" };
  const fc = typeof ak.permission === "object" ? ak.permission.FunctionCall : undefined;
  if (!fc) return { ok: false, reason: "the key's permission can't be read" };
  if (fc.receiver_id !== ORDERS) return { ok: false, reason: `the key is for ${fc.receiver_id}, not ${ORDERS}` };
  const ms = Array.isArray(fc.method_names) ? fc.method_names : [];
  const exact = ms.length === KEY_METHODS.length && new Set(ms).size === ms.length && KEY_METHODS.every((m) => ms.includes(m));
  if (!exact) return { ok: false, reason: ms.length ? `the key names ${ms.join(", ")}; it must name exactly ${WANT}` : `the key may call every method of the contract; it must name exactly ${WANT}` };
  return { ok: true, reason: "function-call key for nekoorders.near: " + KEY_METHODS.join(", ") };
}

/** The keys on an account that have the agent key's permission (view_access_key_list). */
export function agentKeysOf(list: { keys?: { public_key: string; access_key: AccessKeyView }[] } | null): string[] {
  return ((list && list.keys) || []).filter((k) => checkPermission(k.access_key).ok).map((k) => k.public_key);
}
