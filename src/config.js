/**
 * Plugin configuration resolution.
 *
 * The bundle's patch supplies `clientId` and `tenant`; a user patch layer may
 * restate them. Invalid values never take the whole plugin down: each falls
 * back to the documented default and a single warning names the offending
 * field, so the tools stay usable and the fix stays discoverable.
 */
import { DEFAULT_CLIENT_ID } from './state.js';

/** Azure's multi-tenant + personal-account endpoint. */
const DEFAULT_TENANT = 'common';
const TENANT_PATTERN = /^[A-Za-z0-9.-]+$/;

/**
 * @param {unknown} raw - the row's `config` value.
 * @param {{ warn?: (message: string) => void }} [sink] - warning receiver.
 * @returns {{ clientId: string, tenant: string, maxPagesPerList: number, maxPageChars: number }}
 */
export function resolveConfig(raw, sink = {}) {
  const warn = typeof sink.warn === 'function' ? sink.warn : () => {};
  const config = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  let clientId = DEFAULT_CLIENT_ID;
  if (config.clientId !== undefined) {
    if (typeof config.clientId === 'string' && /^[0-9a-fA-F-]{36}$/.test(config.clientId.trim())) {
      clientId = config.clientId.trim();
    } else {
      warn('onenote: config.clientId must be an Azure application (client) ID; using the built-in default.');
    }
  }

  let tenant = DEFAULT_TENANT;
  if (config.tenant !== undefined) {
    if (typeof config.tenant === 'string' && TENANT_PATTERN.test(config.tenant.trim())) {
      tenant = config.tenant.trim();
    } else {
      warn('onenote: config.tenant must be a tenant id or domain name (for example "common" or "contoso.onmicrosoft.com"); using "common".');
    }
  }

  return {
    clientId,
    tenant,
    maxPagesPerList: clampInt(config.maxPagesPerList, 25, 200, 100),
    maxPageChars: clampInt(config.maxPageChars, 4000, 200000, 60000),
  };
}

function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
