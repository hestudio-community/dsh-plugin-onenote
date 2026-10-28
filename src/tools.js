/**
 * The model-facing tools. Every one of them is a thin shell over `service.js`,
 * so the consent check and the Graph call live in exactly one place.
 *
 * Sign-in and consent changes are deliberately absent: those belong to the
 * user, in Settings → Plugins → OneNote. A tool can therefore never widen its
 * own read scope, which is what makes the allow-list a real boundary rather
 * than a suggestion.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { describeFailure } from './service.js';

const textResult = (text) => [{ type: 'text', text }];

function clampInt(value, fallback, min = 1, max = 200) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Copy only the defined fields of a source record, so no key holds `undefined`. */
function compact(source) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const PAGE_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    lastModified: { type: 'string' },
    sectionName: { type: 'string' },
    notebookName: { type: 'string' },
    webUrl: { type: 'string' },
  },
};

/**
 * Register the OneNote tools on the plugin context.
 * @param {object} ctx - the Cordis plugin context.
 * @param {object} service - the shared OneNote service from `service.js`.
 * @returns {Array<() => void>} disposers for the registrations.
 */
export function registerTools(ctx, service) {
  const disposers = [];
  const register = (definition) => {
    disposers.push(ctx.tools.register(definition));
  };

  register(defineTool({
    name: 'onenote_status',
    description:
      'Report whether Microsoft OneNote is connected, which account is signed in, and which notebooks this agent may read. Signing in and choosing notebooks happen in Settings → Plugins → OneNote, so this tool never changes them.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          signedIn: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          account: { type: 'string' },
          expiresAt: { type: 'string' },
          allowedNotebooks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => textResult(value.message),
    },
    async execute() {
      try {
        const status = service.status();
        if (!status.signedIn) {
          return {
            signedIn: false,
            message: 'OneNote is not connected. Ask the user to open Settings → Plugins → OneNote and sign in.',
          };
        }
        const who = status.account?.displayName;
        const names = status.allowedNotebooks.map((entry) => entry.name);
        const scope = names.length === 0
          ? 'No notebook is allowed yet, so nothing is readable: the user must choose notebooks in Settings → Plugins → OneNote.'
          : `Readable notebooks: ${names.join(', ')}. Every other notebook is unreadable by design.`;
        return compact({
          signedIn: true,
          message: `Signed in${who === undefined ? '' : ` as ${who}`}. ${scope}`,
          account: who,
          expiresAt: status.expiresAt,
          allowedNotebooks: names.length === 0 ? undefined : status.allowedNotebooks,
        });
      } catch (error) {
        throw new Error(describeFailure(error));
      }
    },
  }));

  register(defineTool({
    name: 'onenote_list_pages',
    description:
      'Browse the allowed OneNote notebooks. With no arguments it returns each allowed notebook with its sections. With notebook_id it returns that notebook\'s sections and recent pages. With section_id it returns that section\'s pages. Only notebooks the user allowed are readable.',
    parameters: {
      notebook_id: {
        type: 'string',
        description: 'A notebook id from onenote_status; omit to list the allowed notebooks.',
      },
      section_id: {
        type: 'string',
        description: 'A section id from a previous call; returns that section\'s pages.',
      },
      limit: {
        type: 'number',
        description: 'Maximum pages to return (1-200, default 50).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', required: true },
          notebooks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                sections: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      name: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
          pages: { type: 'array', items: PAGE_ITEM },
        },
      },
      render: (_args, value) => {
        const lines = [value.message];
        for (const notebook of value.notebooks ?? []) {
          lines.push(`Notebook: ${notebook.name} — id ${notebook.id}`);
          for (const section of notebook.sections ?? []) lines.push(`  - section ${section.name} — id ${section.id}`);
        }
        for (const page of value.pages ?? []) {
          const where = [page.notebookName, page.sectionName].filter((part) => typeof part === 'string').join(' / ');
          lines.push(`- ${page.title}${where.length > 0 ? ` (${where})` : ''} — id ${page.id}${page.lastModified === undefined ? '' : ` — modified ${page.lastModified}`}`);
        }
        return textResult(lines.join('\n'));
      },
    },
    async execute(args, exec) {
      try {
        return await service.listPages({
          notebookId: typeof args.notebook_id === 'string' ? args.notebook_id : undefined,
          sectionId: typeof args.section_id === 'string' ? args.section_id : undefined,
          limit: clampInt(args.limit, 50, 1, 200),
        }, exec.signal);
      } catch (error) {
        throw new Error(describeFailure(error));
      }
    },
  }));

  register(defineTool({
    name: 'onenote_search',
    description:
      'Search the allowed OneNote notebooks. Matches page titles first, then the opening text of the most recently modified pages, and returns page ids to read with onenote_read_page. Only notebooks the user allowed are searched.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Text to look for; matching is case-insensitive.',
      },
      limit: {
        type: 'number',
        description: 'Maximum matches to return (1-50, default 10).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', required: true },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                notebookName: { type: 'string' },
                sectionName: { type: 'string' },
                lastModified: { type: 'string' },
                matchedIn: { type: 'string', required: true, enum: ['title', 'body'] },
                snippet: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [value.message];
        for (const hit of value.results ?? []) {
          const where = [hit.notebookName, hit.sectionName].filter((part) => typeof part === 'string').join(' / ');
          lines.push(`- ${hit.title}${where.length > 0 ? ` (${where})` : ''} — id ${hit.id} — matched in ${hit.matchedIn}${hit.snippet === undefined ? '' : `: ${hit.snippet}`}`);
        }
        return textResult(lines.join('\n'));
      },
    },
    async execute(args, exec) {
      try {
        return await service.search({
          query: typeof args.query === 'string' ? args.query : '',
          limit: clampInt(args.limit, 10, 1, 50),
        }, exec.signal);
      } catch (error) {
        throw new Error(describeFailure(error));
      }
    },
  }));

  register(defineTool({
    name: 'onenote_read_page',
    description:
      'Read one OneNote page as Markdown, including its headings, lists, tables, links, and code blocks. Refuses any page whose notebook the user did not allow. Use onenote_list_pages or onenote_search to obtain a page id.',
    parameters: {
      page_id: {
        type: 'string',
        required: true,
        description: 'A page id from onenote_list_pages or onenote_search.',
      },
      max_chars: {
        type: 'number',
        description: 'Maximum characters of Markdown to return (2000-200000); larger pages are truncated with a notice.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          notebookName: { type: 'string' },
          sectionName: { type: 'string' },
          lastModified: { type: 'string' },
          webUrl: { type: 'string' },
          truncated: { type: 'boolean', required: true },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const where = [value.notebookName, value.sectionName].filter((part) => typeof part === 'string').join(' / ');
        const header = `# ${value.title}${where.length > 0 ? `\n_${where}_` : ''}${value.lastModified === undefined ? '' : `\n_last modified ${value.lastModified}_`}`;
        const notice = value.truncated ? '\n\n[page truncated; call onenote_read_page with a larger max_chars for the rest]' : '';
        return textResult(`${header}\n\n${value.content}${notice}`);
      },
    },
    async execute(args, exec) {
      try {
        return await service.readPage({
          pageId: typeof args.page_id === 'string' ? args.page_id : '',
          maxChars: clampInt(args.max_chars, 60000, 2000, 200000),
        }, exec.signal);
      } catch (error) {
        throw new Error(describeFailure(error));
      }
    },
  }));

  return disposers;
}
