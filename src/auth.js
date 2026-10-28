/**
 * Microsoft identity: OAuth 2.0 device-code sign-in plus refresh-token reuse.
 *
 * Device code is the only flow that needs no listener, no browser automation,
 * and no client secret, so it works the same on macOS, Windows, and a remote
 * shell. One pending attempt is kept on disk so the settings card can continue
 * the SAME code across reloads instead of invalidating what the user is typing.
 */
import { SCOPES, clearPendingSignIn, clearTokens, readPendingSignIn, readTokens, writePendingSignIn, writeTokens } from './state.js';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const DEVICE_CODE_PATH = '/oauth2/v2.0/devicecode';
const TOKEN_PATH = '/oauth2/v2.0/token';

/** Treat a token as expired this early so a request never races the deadline. */
const EXPIRY_SKEW_MS = 60_000;
/** How long one interactive sign-in call waits before reporting `pending`. */
const POLL_BUDGET_MS = 30_000;
const HTTP_TIMEOUT_MS = 20_000;

/** A failure whose message is safe and useful to show the model. */
export class OneNoteAuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'OneNoteAuthError';
    this.code = code;
  }
}

function authorityUrl(tenant, path) {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}${path}`;
}

function describeHttpFailure(status, payload) {
  const error = typeof payload?.error === 'string' ? payload.error : '';
  const description = typeof payload?.error_description === 'string' ? payload.error_description : '';
  const detail = description.length > 0 ? description.split('\n')[0] : `HTTP ${status}`;
  return { error, detail };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Start a device-code attempt for this client.
 * @param {{ clientId: string, tenant: string }} config - resolved plugin config.
 * @returns {Promise<object>} the pending attempt to persist.
 */
export async function startDeviceCode(config) {
  const body = new URLSearchParams({ client_id: config.clientId, scope: SCOPES.join(' ') });
  let response;
  try {
    response = await fetch(authorityUrl(config.tenant, DEVICE_CODE_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OneNoteAuthError(`Could not reach Microsoft sign-in (${error instanceof Error ? error.message : String(error)}). Check the network and try again.`, 'NETWORK');
  }
  const payload = await readJson(response);
  if (!response.ok) {
    const { error: code, detail } = describeHttpFailure(response.status, payload);
    const hint = code === 'invalid_client'
      ? ' The Azure app registration does not match this client ID, or public client flows are disabled for it.'
      : code === 'unauthorized_client'
        ? ' Enable "Allow public client flows" for the app registration.'
        : '';
    throw new OneNoteAuthError(`Microsoft refused the device-code request: ${detail}.${hint}`, code || 'DEVICE_CODE_FAILED');
  }
  const deviceCode = typeof payload?.device_code === 'string' ? payload.device_code : '';
  const userCode = typeof payload?.user_code === 'string' ? payload.user_code : '';
  if (deviceCode.length === 0 || userCode.length === 0) throw new OneNoteAuthError('Microsoft returned an incomplete device-code response. Try again.', 'DEVICE_CODE_INCOMPLETE');
  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 900;
  const interval = typeof payload.interval === 'number' ? payload.interval : 5;
  return {
    deviceCode,
    userCode,
    verificationUri: typeof payload.verification_uri === 'string' ? payload.verification_uri : 'https://microsoft.com/devicelogin',
    message: typeof payload.message === 'string' ? payload.message : undefined,
    intervalMs: Math.max(1000, interval * 1000),
    expiresAt: Date.now() + expiresIn * 1000,
    clientId: config.clientId,
    tenant: config.tenant,
  };
}

/**
 * Poll one attempt until it resolves or the per-call budget runs out.
 *
 * `authorization_pending` and `slow_down` are expected while the user types;
 * every other error ends the attempt so the next call can start a fresh code.
 * @param {object} pending - attempt from {@link startDeviceCode}.
 * @param {number} [budgetMs] - how long this call may wait.
 * @returns {Promise<{ status: 'signed-in', tokens: object } | { status: 'pending', pending: object }>}
 */
export async function pollDeviceCode(pending, budgetMs = POLL_BUDGET_MS) {
  const deadline = Math.min(Date.now() + budgetMs, pending.expiresAt);
  let intervalMs = pending.intervalMs;
  let attempt = { ...pending };

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { status: 'pending', pending: attempt };
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
    if (Date.now() >= pending.expiresAt) {
      clearPendingSignIn();
      throw new OneNoteAuthError('The sign-in code expired before it was used. Start sign-in again for a fresh code.', 'DEVICE_CODE_EXPIRED');
    }
    const outcome = await pollDeviceCodeOnce(attempt);
    if (outcome.status === 'signed-in') return outcome;
    if (outcome.status === 'pending') continue;
    // `slow_down` widens the interval for both this loop and later calls.
    attempt = outcome.pending;
    intervalMs = attempt.intervalMs;
  }
}

/**
 * Ask Microsoft once whether the pending attempt has been approved.
 *
 * A settings card polls this on a timer, so one call must never block: it
 * performs exactly one token request and reports what it found.
 * @param {object} pending - attempt from {@link startDeviceCode}.
 * @returns {Promise<{ status: 'signed-in', tokens: object } | { status: 'pending', pending: object }>}
 */
export async function pollDeviceCodeOnce(pending) {
  if (Date.now() >= pending.expiresAt) {
    clearPendingSignIn();
    throw new OneNoteAuthError('The sign-in code expired before it was used. Start sign-in again for a fresh code.', 'DEVICE_CODE_EXPIRED');
  }

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: pending.deviceCode,
    client_id: pending.clientId ?? '',
  });
  let response;
  try {
    response = await fetch(authorityUrl(pending.tenant ?? 'common', TOKEN_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OneNoteAuthError(`Could not reach Microsoft sign-in (${error instanceof Error ? error.message : String(error)}). Try again.`, 'NETWORK');
  }
  const payload = await readJson(response);
  if (response.ok && typeof payload?.access_token === 'string') {
    const tokens = toStoredTokens(payload, pending);
    writeTokens(tokens);
    clearPendingSignIn();
    return { status: 'signed-in', tokens };
  }

  const { error: code, detail } = describeHttpFailure(response.status, payload);
  if (code === 'authorization_pending') return { status: 'pending', pending };
  if (code === 'slow_down') {
    const widened = { ...pending, intervalMs: pending.intervalMs + 5000 };
    writePendingSignIn(widened);
    return { status: 'pending', pending: widened };
  }
  clearPendingSignIn();
  if (code === 'authorization_declined') throw new OneNoteAuthError('Sign-in was declined in the browser. Start sign-in again if this was a mistake.', code);
  if (code === 'expired_token') throw new OneNoteAuthError('The sign-in code expired. Start sign-in again for a fresh code.', code);
  if (code === 'bad_verification_code') throw new OneNoteAuthError('The stored sign-in attempt is no longer valid. Start sign-in again.', code);
  throw new OneNoteAuthError(`Sign-in failed: ${detail}.`, code || 'SIGN_IN_FAILED');
}

function toStoredTokens(payload, pending) {
  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 3600;
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined,
    expiresAt: Date.now() + expiresIn * 1000,
    scope: typeof payload.scope === 'string' ? payload.scope : SCOPES.join(' '),
    account: undefined,
    clientId: pending.clientId,
    tenant: pending.tenant,
  };
}

/**
 * Exchange a stored refresh token for a new access token.
 * @param {object} tokens - stored tokens.
 * @param {{ clientId: string, tenant: string }} config - resolved plugin config.
 * @returns {Promise<object>} the refreshed token set.
 */
async function refreshTokens(tokens, config) {
  if (tokens.refreshToken === undefined) {
    clearTokens();
    throw new OneNoteAuthError('The OneNote session expired and cannot be renewed. Open Settings → Plugins → OneNote and sign in again.', 'SIGN_IN_REQUIRED');
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: config.clientId,
    scope: SCOPES.join(' '),
  });
  let response;
  try {
    response = await fetch(authorityUrl(config.tenant, TOKEN_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OneNoteAuthError(`Could not reach Microsoft sign-in (${error instanceof Error ? error.message : String(error)}). Try again.`, 'NETWORK');
  }
  const payload = await readJson(response);
  if (!response.ok || typeof payload?.access_token !== 'string') {
    const { error: code, detail } = describeHttpFailure(response.status, payload);
    clearTokens();
    const hint = code === 'invalid_grant' ? ' The stored sign-in is no longer valid (it may have been revoked or expired); sign in again from Settings → Plugins → OneNote.' : '';
    throw new OneNoteAuthError(`Could not renew the OneNote session: ${detail}.${hint}`, code || 'REFRESH_FAILED');
  }
  const refreshed = {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : tokens.refreshToken,
    expiresAt: Date.now() + (typeof payload.expires_in === 'number' ? payload.expires_in : 3600) * 1000,
    scope: typeof payload.scope === 'string' ? payload.scope : tokens.scope,
    account: tokens.account,
    clientId: config.clientId,
    tenant: config.tenant,
  };
  writeTokens(refreshed);
  return refreshed;
}

/**
 * Return a usable access token, refreshing or failing with a clear next step.
 * @param {{ clientId: string, tenant: string }} config - resolved plugin config.
 * @returns {Promise<string>} the access token.
 */
export async function requireAccessToken(config) {
  const tokens = readTokens();
  if (tokens === undefined) throw new OneNoteAuthError('Not signed in to OneNote yet. Open Settings → Plugins → OneNote and sign in.', 'SIGN_IN_REQUIRED');
  if (tokens.expiresAt - EXPIRY_SKEW_MS > Date.now()) return tokens.accessToken;
  const refreshed = await refreshTokens(tokens, config);
  return refreshed.accessToken;
}

/** Describe the signed-in session without exposing the token. */
export function signInSummary() {
  const tokens = readTokens();
  if (tokens === undefined) return { signedIn: false };
  // A lapsed access token is not a signed-out session while a refresh token can
  // still renew it: reporting `signedIn: false` there hid the notebook list in
  // the card and made `onenote_status` claim the plugin was not connected.
  const usable = tokens.expiresAt > Date.now() || tokens.refreshToken !== undefined;
  return {
    signedIn: usable,
    renewsAutomatically: tokens.refreshToken !== undefined,
    expiresAt: new Date(tokens.expiresAt).toISOString(),
    account: tokens.account,
  };
}

/** Record who is signed in, so later calls can name the account. */
export function rememberAccount(account) {
  const tokens = readTokens();
  if (tokens === undefined) return;
  writeTokens({ ...tokens, account });
}

/** Load a persisted device-code attempt, if one is still waiting. */
export function pendingSignIn() {
  return readPendingSignIn();
}

/** Persist a started device-code attempt. */
export function rememberPendingSignIn(pending) {
  writePendingSignIn(pending);
}

/** Forget the stored session. */
export function signOut() {
  clearTokens();
  clearPendingSignIn();
}

/** Graph origin used by the client; exported for tests and diagnostics. */
export const GRAPH_BASE = GRAPH_ORIGIN;
