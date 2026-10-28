/**
 * Local state for the OneNote plugin: tokens, notebook consent, and one pending
 * device-code attempt.
 *
 * Everything lives under `$DSH_HOME/onenote`, outside the workspace, so it
 * survives restarts and is never picked up as project files. Tokens are the only
 * secret written here, so the token and sign-in files are created 0600 and each
 * write goes through a temp file plus rename — an interrupted write can never
 * leave a half-written token or allow-list behind.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The Azure public-client app registration this bundle is built for. */
export const DEFAULT_CLIENT_ID = 'a2e9773e-e783-4e5c-83ff-8c627eec0e6e';

/** Delegated scopes: read notes, keep a refresh token, and name the account. */
export const SCOPES = ['offline_access', 'Notes.Read', 'User.Read'];

/** Resolve the plugin's data directory, following the runtime's DSH home. */
export function dataDir() {
  const home = process.env.DSH_HOME?.trim();
  return join(home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh'), 'onenote');
}

function filePath(name) {
  return join(dataDir(), name);
}

function readJson(name) {
  try {
    const parsed = JSON.parse(readFileSync(filePath(name), 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(name, value, mode = 0o600) {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const target = filePath(name);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  try {
    chmodSync(temp, mode);
  } catch {
    /* a filesystem without POSIX modes still keeps the file inside the user's home */
  }
  renameSync(temp, target);
}

function removeFile(name) {
  try {
    rmSync(filePath(name), { force: true });
  } catch {
    /* an absent file is already in the desired state */
  }
}

/** Read stored tokens, treating a malformed or absent file as signed out. */
export function readTokens() {
  const raw = readJson('tokens.json');
  if (raw === undefined) return undefined;
  if (typeof raw.accessToken !== 'string' || raw.accessToken.length === 0) return undefined;
  return {
    accessToken: raw.accessToken,
    refreshToken: typeof raw.refreshToken === 'string' && raw.refreshToken.length > 0 ? raw.refreshToken : undefined,
    // An unreadable expiry counts as expired, so the next call refreshes instead of failing.
    expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : 0,
    scope: typeof raw.scope === 'string' ? raw.scope : SCOPES.join(' '),
    account: normalizeAccount(raw.account),
  };
}

/** Persist tokens after a sign-in or refresh. */
export function writeTokens(tokens) {
  writeJson('tokens.json', tokens);
}

/** Drop the stored tokens. */
export function clearTokens() {
  removeFile('tokens.json');
}

function normalizeAccount(account) {
  if (account === null || typeof account !== 'object' || Array.isArray(account)) return undefined;
  const displayName = typeof account.displayName === 'string' && account.displayName.length > 0 ? account.displayName : undefined;
  const userPrincipalName = typeof account.userPrincipalName === 'string' && account.userPrincipalName.length > 0 ? account.userPrincipalName : undefined;
  const mail = typeof account.mail === 'string' && account.mail.length > 0 ? account.mail : undefined;
  if (displayName === undefined && userPrincipalName === undefined && mail === undefined) return undefined;
  return { displayName, userPrincipalName, mail };
}

/**
 * The notebook allow-list: the only notebooks the reading tools will touch.
 * Entries keep the display name so the model can show a name without another
 * request, while the id stays the authority for every permission check.
 */
export function readAllowedNotebooks() {
  const raw = readJson('settings.json');
  const list = raw?.allowedNotebooks;
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id });
  }
  return result;
}

/** Replace the allow-list. */
export function writeAllowedNotebooks(notebooks) {
  writeJson('settings.json', {
    allowedNotebooks: notebooks.map((notebook) => ({ id: notebook.id, name: notebook.name })),
    updatedAt: new Date().toISOString(),
  });
}

/** Read the in-flight device-code attempt, if it has not expired. */
export function readPendingSignIn() {
  const raw = readJson('signin.json');
  if (raw === undefined) return undefined;
  if (typeof raw.deviceCode !== 'string' || raw.deviceCode.length === 0) return undefined;
  if (typeof raw.expiresAt !== 'number' || raw.expiresAt <= Date.now()) return undefined;
  return {
    deviceCode: raw.deviceCode,
    userCode: typeof raw.userCode === 'string' ? raw.userCode : '',
    verificationUri: typeof raw.verificationUri === 'string' ? raw.verificationUri : 'https://microsoft.com/devicelogin',
    message: typeof raw.message === 'string' ? raw.message : undefined,
    intervalMs: typeof raw.intervalMs === 'number' && raw.intervalMs >= 1000 ? raw.intervalMs : 5000,
    expiresAt: raw.expiresAt,
    clientId: typeof raw.clientId === 'string' ? raw.clientId : undefined,
    tenant: typeof raw.tenant === 'string' ? raw.tenant : undefined,
  };
}

/** Remember the pending device-code attempt so a later call can finish it. */
export function writePendingSignIn(pending) {
  writeJson('signin.json', pending);
}

/** Forget the pending attempt. */
export function clearPendingSignIn() {
  removeFile('signin.json');
}
