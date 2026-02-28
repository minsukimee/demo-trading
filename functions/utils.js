// functions/utils.js

export const KV_NAME = "BITGET_DEMO_KV";
export const PASSWORD_ITERATIONS = 100000;

export function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashPassword(password, salt, iterations = PASSWORD_ITERATIONS) {
  const encoder = new TextEncoder();
  const saltBuf = encoder.encode(salt);
  const passwordBuf = encoder.encode(password);
  const safeIterations = Math.max(1, Math.min(100000, Number(iterations) || PASSWORD_ITERATIONS));

  const key = await crypto.subtle.importKey(
    "raw",
    passwordBuf,
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBuf,
      iterations: safeIterations,
      hash: "SHA-256",
    },
    key,
    256
  );

  return Array.from(new Uint8Array(derivedBits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateToken() {
  return randomHex(32) + randomHex(32);
}

export function getKV(context) {
  return context.env[KV_NAME];
}

export async function getUser(kv, username) {
  const data = await kv.get(`user:${username}`);
  return data ? JSON.parse(data) : null;
}

export async function saveUser(kv, username, userData) {
  await kv.put(`user:${username}`, JSON.stringify(userData));
}

export async function getUsernameByToken(kv, token) {
  return await kv.get(`session:${token}`);
}

export async function createSession(kv, username) {
  const token = generateToken();
  await kv.put(`session:${token}`, username, { expirationTtl: 86400 * 30 }); // 30 days
  return token;
}

export async function deleteSession(kv, token) {
  await kv.delete(`session:${token}`);
}

export const defaultState = {
  nextId: 1,
  equityStart: 1000,
  realizedPnl: 0,
  positions: [],
  closed: [],
};
