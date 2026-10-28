/**
 * `dsh-plugin-onenote` — read the Microsoft OneNote notebooks a user allows.
 *
 * The row takes `clientId` and `tenant`; tokens and consent live under
 * `$DSH_HOME/onenote`. Two surfaces share one service:
 *
 *   - agent tools (`src/tools.js`) — read-only, gated by the allow-list;
 *   - settings card (`client.js` + `src/routes.js`) — the only place a user can
 *     sign in or change which notebooks are readable.
 *
 * Unloading the row unregisters the tools, the prompt section, and the routes
 * through effect-owned disposers.
 */
import { resolveConfig } from './src/config.js';
import { registerTools } from './src/tools.js';
import { createOneNoteService } from './src/service.js';
import { installRoutes } from './src/routes.js';

export const name = 'onenote';

/** Tools are required; everything else is optional in a bare composition. */
export const inject = ['tools'];

const PROMPT_SECTION = 'tool:onenote';
/** Sits beside the other external-content tools, after the MCP servers block. */
const PROMPT_ORDER = 3150;

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig, {
    warn: (message) => ctx.logger?.warn?.(message),
  });

  const service = createOneNoteService(config);

  const disposers = registerTools(ctx, service);
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose();
  });

  installRoutes(ctx, service);

  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt !== undefined) {
    const section = systemPrompt.section({
      name: PROMPT_SECTION,
      order: PROMPT_ORDER,
      text: () => renderSection(service),
    });
    ctx.effect(() => () => section());
  }
}

/**
 * One short paragraph, regenerated per assembly so it reflects the live
 * sign-in and consent state. An unconfigured plugin says what the user must do
 * rather than advertising a capability the model cannot use yet.
 */
function renderSection(service) {
  const status = service.status();
  if (!status.signedIn) {
    return [
      'OneNote is available but not connected. When the user asks about their notes,',
      'tell them to open Settings → Plugins → OneNote and sign in; do not attempt to sign in for them.',
    ].join(' ');
  }

  const names = status.allowedNotebooks.map((entry) => entry.name);
  const scope = names.length === 0
    ? 'No notebook is allowed yet, so nothing is readable; the user chooses notebooks in Settings → Plugins → OneNote.'
    : `Readable notebooks: ${names.join(', ')}. Every other notebook is unreadable by design.`;

  const who = status.account?.displayName === undefined ? '' : ` Signed in as ${status.account.displayName}.`;
  return [
    `Microsoft OneNote is connected.${who} ${scope}`,
    'Use `onenote_search` or `onenote_list_pages` to find a page, then `onenote_read_page` to read it.',
    'These tools only ever see the allowed notebooks; never claim access to a notebook outside that list, and never suggest that you can widen it yourself.',
  ].join(' ');
}
