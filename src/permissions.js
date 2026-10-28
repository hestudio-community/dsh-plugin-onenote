/**
 * Notebook consent: the allow-list and the guard every reading tool runs first.
 *
 * This module is the privacy boundary. Nothing that reads note content may call
 * Microsoft Graph before {@link assertNotebookAllowed} has confirmed the owning
 * notebook was explicitly chosen by the user, so a prompt-injected page id can
 * never reach a notebook that was not consented to.
 */
import { readAllowedNotebooks, writeAllowedNotebooks } from './state.js';

/** Error code used when a notebook was not consented to. */
export const NOT_ALLOWED = 'NOTEBOOK_NOT_ALLOWED';

/** A denial the tools surface verbatim, with the recovery step included. */
export class NotebookNotAllowedError extends Error {
  constructor(notebookNameOrId) {
    super(
      `Notebook "${notebookNameOrId}" is not in the allowed list, so its content is not readable. ` +
        'The user chooses readable notebooks in Settings → Plugins → OneNote; ask them to add it there if they want it read.',
    );
    this.name = 'NotebookNotAllowedError';
    this.code = NOT_ALLOWED;
  }
}

/** The current allow-list, read fresh so an edit through another path takes effect. */
export function allowedNotebooks() {
  return readAllowedNotebooks();
}

/** Whether the allow-list is still empty, i.e. the user has not chosen yet. */
export function hasConsent() {
  return readAllowedNotebooks().length > 0;
}

/**
 * Normalize one id for comparison. Graph ids are case-insensitive GUIDs, and a
 * notebook id may arrive percent-encoded inside a page or section URL.
 */
function normalizeId(value) {
  if (typeof value !== 'string') return '';
  let id = value.trim();
  if (id.length === 0) return '';
  try {
    if (id.includes('%')) id = decodeURIComponent(id);
  } catch {
    /* a malformed escape stays as written and simply fails the comparison */
  }
  return id.toLowerCase();
}

/** Whether a notebook id is allowed. */
export function isNotebookAllowed(notebookId) {
  const wanted = normalizeId(notebookId);
  if (wanted.length === 0) return false;
  return allowedNotebooks().some((entry) => normalizeId(entry.id) === wanted);
}

/**
 * Throw unless the notebook is allowed.
 * @param {string} notebookId - the owning notebook id.
 * @param {string} [label] - a name to use in the denial message.
 * @returns {{ id: string, name: string }} the matching allow-list entry.
 */
export function assertNotebookAllowed(notebookId, label) {
  const wanted = normalizeId(notebookId);
  const match = allowedNotebooks().find((entry) => normalizeId(entry.id) === wanted);
  if (match === undefined) throw new NotebookNotAllowedError(label ?? notebookId);
  return match;
}

/**
 * Resolve the notebook that owns a section, then assert consent.
 * Graph does not return a section's notebook on every payload, so callers pass
 * the notebook id they already know when they have it.
 * @param {string} notebookId - the owning notebook id.
 * @param {string} [label] - a name for the denial message.
 */
export function assertNotebookAllowedForSection(notebookId, label) {
  return assertNotebookAllowed(notebookId, label);
}

/**
 * Replace the allow-list with the chosen notebooks.
 * @param {readonly { id: string, name?: string }[]} notebooks - chosen notebooks.
 * @returns {{ id: string, name: string }[]} the stored entries.
 */
export function setAllowedNotebooks(notebooks) {
  const seen = new Set();
  const stored = [];
  for (const notebook of notebooks ?? []) {
    if (notebook === null || typeof notebook !== 'object') continue;
    const id = typeof notebook.id === 'string' ? notebook.id.trim() : '';
    const key = normalizeId(id);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    const name = typeof notebook.name === 'string' && notebook.name.trim().length > 0 ? notebook.name.trim() : id;
    stored.push({ id, name });
  }
  writeAllowedNotebooks(stored);
  return stored;
}

/** Forget every consent, so nothing is readable until the user chooses again. */
export function clearAllowedNotebooks() {
  writeAllowedNotebooks([]);
  return [];
}
