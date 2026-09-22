import { Effect } from "effect";

/**
 * Token primitives for auth: opaque bearer tokens (random, hashed at rest).
 * Pure WebCrypto, Effect at the definition site — callers never wrap.
 */

const CLI_TOKEN_PREFIX = "tmx_";

/** 32 random bytes, base64url — the raw session token. */
function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));

  return toBase64Url(bytes);
}

/** Raw CLI token, recognizable by prefix so CliAuth can reject early. */
function generateCliToken(): string {
  return `${CLI_TOKEN_PREFIX}${generateToken()}`;
}

/** Hex sha-256; session rows store this, never the raw token. */
function sha256Hex(value: string): Effect.Effect<string> {
  return Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));

    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  });
}

/** RFC 7636 S256 code challenge: base64url(sha-256(verifier)). */
function pkceChallenge(verifier: string): Effect.Effect<string> {
  return Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));

    return toBase64Url(new Uint8Array(digest));
  });
}

/** cli_tokens.tokenHash format: a labeled sha-256 of the raw `tmx_` token. */
function hashCliToken(token: string): Effect.Effect<string> {
  return sha256Hex(token).pipe(Effect.map((hex) => `sha256:${hex}`));
}

/** Unambiguous alphabet (no 0/O/1/I/L) for human-typed login codes. */
const LOGIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/** Readable device-flow code like "K3QF-W8MT". */
function generateLoginCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((byte) => LOGIN_CODE_ALPHABET[byte % LOGIN_CODE_ALPHABET.length]);

  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** Tolerates lowercase and missing/extra dashes from hand-typed codes. */
function normalizeLoginCode(input: string): string {
  const stripped = input.trim().toUpperCase().replaceAll("-", "");

  return `${stripped.slice(0, 4)}-${stripped.slice(4)}`;
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export {
  CLI_TOKEN_PREFIX,
  generateCliToken,
  generateLoginCode,
  generateToken,
  hashCliToken,
  normalizeLoginCode,
  pkceChallenge,
  sha256Hex,
};
