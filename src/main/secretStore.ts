/**
 * Encrypted secret store (main process only).
 *
 * Secrets are ENCRYPTED AT REST via Electron `safeStorage` in
 * `userData/integration-secrets.json` (mode 0600), a file separate from
 * config.json. Integrations keep their credentials here, and so do the config
 * secrets (Slack, Groq, webhook, per-trigger webhook secrets) — see
 * CONFIG_SECRET_KEYS in config.ts.
 *
 * SECURITY: nothing is written unless `safeStorage.isEncryptionAvailable()`
 * (fail closed — no plaintext fallback). Decrypted values stay in main.
 */
import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

function secretsPath(): string {
  return join(app.getPath('userData'), 'integration-secrets.json');
}

function readSecretBlob(): Record<string, string> {
  const p = secretsPath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeSecretBlob(blob: Record<string, string>): void {
  const p = secretsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(blob, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** Store a secret ENCRYPTED. Fail closed if OS encryption is unavailable (never
 *  writes plaintext). The plaintext is used only to encrypt and is not retained. */
export function setSecret(secretRef: string, plaintext: string): { ok: boolean; error?: string } {
  if (!secretRef) return { ok: false, error: 'secretRef required' };
  if (typeof plaintext !== 'string' || plaintext === '') return { ok: false, error: 'secret required' };
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS secret encryption is unavailable; refusing to store a secret in plaintext' };
    }
    const cipher = safeStorage.encryptString(plaintext).toString('base64');
    const blob = readSecretBlob();
    blob[secretRef] = cipher;
    writeSecretBlob(blob);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Decrypt a secret. MAIN-INTERNAL ONLY — never expose this over IPC. Returns
 *  undefined if absent or undecryptable (the broker maps that to 503 no_secret). */
export function getSecret(secretRef: string | undefined): string | undefined {
  if (!secretRef) return undefined;
  const cipher = readSecretBlob()[secretRef];
  if (!cipher) return undefined;
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
  } catch {
    return undefined;
  }
}

/** Whether a secret is stored for this ref (no decryption). */
export function hasSecret(secretRef: string | undefined): boolean {
  if (!secretRef) return false;
  return !!readSecretBlob()[secretRef];
}

/** Refs of every stored secret starting with `prefix` (no decryption). */
export function listSecretRefs(prefix: string): string[] {
  return Object.keys(readSecretBlob()).filter((ref) => ref.startsWith(prefix));
}

/** Delete a stored secret. Idempotent. */
export function deleteSecret(secretRef: string | undefined): void {
  if (!secretRef) return;
  const blob = readSecretBlob();
  if (secretRef in blob) {
    delete blob[secretRef];
    if (Object.keys(blob).length === 0) {
      try { rmSync(secretsPath(), { force: true }); } catch { /* best-effort */ }
    } else {
      writeSecretBlob(blob);
    }
  }
}

/** Whether OS encryption is usable right now (so setSecret can succeed). */
export function secretStoreAvailable(): boolean {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}
