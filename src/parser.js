/**
 * Convert the HTML Microsoft Graph returns for a OneNote page into compact Markdown.
 *
 * OneNote emits deeply nested `div`/`span` soup with `data-*` attributes. This
 * module is a small, dependency-free tokenizer plus a block writer: it keeps the
 * document structure a reader cares about (headings, paragraphs, lists, tables,
 * emphasis, links, code) and drops everything else. Media is never fetched, so
 * an image contributes only its alt text.
 */

const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'body', 'html', 'li', 'tr', 'table', 'ul', 'ol', 'pre', 'blockquote']);
const SKIP_TAGS = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'noscript']);
const INLINE_MARKS = {
  strong: ['**', '**'],
  b: ['**', '**'],
  em: ['_', '_'],
  i: ['_', '_'],
  del: ['~~', '~~'],
  s: ['~~', '~~'],
  strike: ['~~', '~~'],
  code: ['`', '`'],
  u: ['', ''],
  sub: ['', ''],
  sup: ['', ''],
  span: ['', ''],
  font: ['', ''],
  small: ['', ''],
  mark: ['', ''],
};

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•',
  times: '×', divide: '÷', deg: '°', plusmn: '±', frac12: '½',
};

/** Decode the character references that actually appear in OneNote content. */
export function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
      return '';
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

const TAG_PATTERN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const ATTR_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function parseAttributes(raw) {
  const attrs = {};
  if (!raw) return attrs;
  ATTR_PATTERN.lastIndex = 0;
  let match;
  while ((match = ATTR_PATTERN.exec(raw)) !== null) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[match[1].toLowerCase()] = decodeEntities(value);
  }
  return attrs;
}

/** Collapse runs of whitespace the way a rendered paragraph would. */
function collapse(text) {
  return text.replace(/[\t\r\n ]+/g, ' ').trim();
}

/**
 * Render one page's HTML as Markdown.
 * @param {string} html - the page content from Graph.
 * @param {number} maxChars - a hard ceiling on the produced text.
 * @returns {string} Markdown text, ending with a truncation note when clipped.
 */
export function parseOneNoteHtml(html, maxChars = 60000) {
  return renderPage(html, maxChars).content;
}

/**
 * Render one page and report whether the ceiling clipped it.
 * @param {string} html - the page content from Graph.
 * @param {number} maxChars - a hard ceiling on the produced text.
 * @returns {{ content: string, truncated: boolean }} Markdown plus the clip flag.
 */
export function renderPage(html, maxChars = 60000) {
  if (typeof html !== 'string' || html.length === 0) return { content: '', truncated: false };

  const lines = [];
  let used = 0;
  let truncated = false;
  let buffer = '';
  /** The list marker for the item being collected, kept out of the collapsed text. */
  let pendingPrefix = '';
  let headingLevel = 0;
  let preDepth = 0;
  let preBuffer = '';
  let skipDepth = 0;
  let table = null;
  const frames = [];
  const lists = [];

  const emit = (line) => {
    if (truncated) return;
    const text = line.replace(/[ \t]+$/u, '');
    if (text.length === 0) {
      if (lines.length === 0 || lines[lines.length - 1] === '') return;
      lines.push('');
      used += 1;
      return;
    }
    if (used + text.length > maxChars) {
      const room = maxChars - used;
      if (room > 80) lines.push(text.slice(0, room));
      truncated = true;
      return;
    }
    lines.push(text);
    used += text.length + 1;
  };

  const flush = () => {
    const text = collapse(buffer);
    buffer = '';
    if (text.length === 0) return;
    // The list marker is kept out of `buffer` so collapsing text cannot eat its indent.
    const prefix = pendingPrefix;
    pendingPrefix = '';
    if (headingLevel > 0) emit(`${'#'.repeat(headingLevel)} ${text}`);
    else emit(prefix + text);
  };

  const listPrefix = () => {
    const depth = Math.max(0, lists.length - 1);
    const indent = '  '.repeat(depth);
    const current = lists[lists.length - 1];
    if (current === undefined) return '';
    if (current.ordered) {
      current.index += 1;
      return `${indent}${current.index}. `;
    }
    return `${indent}- `;
  };

  const renderTable = () => {
    if (table === null || table.rows.length === 0) {
      table = null;
      return;
    }
    const rows = table.rows;
    const width = Math.max(...rows.map((row) => row.length));
    const padded = rows.map((row) => [...row, ...Array(width - row.length).fill('')]);
    const header = padded[0];
    const body = padded.slice(1);
    emit(`| ${header.join(' | ')} |`);
    emit(`| ${header.map(() => '---').join(' | ')} |`);
    for (const row of body) emit(`| ${row.join(' | ')} |`);
    emit('');
    table = null;
  };

  const closeFrame = (name) => {
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      if (frames[index].name !== name) continue;
      const frame = frames.splice(index, 1)[0];
      const inner = buffer.slice(frame.start);
      buffer = buffer.slice(0, frame.start) + frame.wrap(inner);
      return;
    }
  };

  const openInline = (name, attrs) => {
    if (name === 'a') {
      const href = attrs.href ?? '';
      const start = buffer.length;
      frames.push({
        name,
        start,
        wrap: (inner) => {
          const text = collapse(inner);
          if (text.length === 0) return '';
          if (href.length === 0 || href.startsWith('javascript:')) return text;
          return `[${text}](${href})`;
        },
      });
      return;
    }
    const mark = INLINE_MARKS[name];
    if (mark === undefined) return;
    if (mark[0].length === 0) {
      frames.push({ name, start: buffer.length, wrap: (inner) => inner });
      return;
    }
    const start = buffer.length;
    frames.push({ name, start, wrap: (inner) => (collapse(inner).length === 0 ? inner : `${mark[0]}${inner}${mark[1]}`) });
  };

  const handleOpen = (name, attrs) => {
    if (SKIP_TAGS.has(name)) {
      skipDepth += 1;
      return;
    }
    if (skipDepth > 0) return;

    if (name === 'pre') {
      flush();
      preDepth += 1;
      preBuffer = '';
      return;
    }
    if (preDepth > 0) return;

    if (table !== null) {
      if (name === 'tr') table.row = [];
      else if (name === 'td' || name === 'th') table.cell = '';
      else if (name === 'br' && table.cell !== null) table.cell += ' ';
      return;
    }

    if (name === 'table') {
      flush();
      table = { rows: [], row: null, cell: null };
      return;
    }

    if (name === 'br') {
      flush();
      return;
    }
    if (name === 'hr') {
      flush();
      emit('---');
      emit('');
      return;
    }
    if (name === 'img') {
      const alt = collapse(attrs.alt ?? attrs.title ?? '');
      if (alt.length > 0) buffer += `🖼️ ${alt} `;
      return;
    }
    if (/^h[1-6]$/u.test(name)) {
      flush();
      headingLevel = Number(name.slice(1));
      return;
    }
    if (name === 'ul' || name === 'ol') {
      flush();
      lists.push({ ordered: name === 'ol', index: 0 });
      return;
    }
    if (name === 'li') {
      flush();
      pendingPrefix = listPrefix();
      return;
    }
    if (BLOCK_TAGS.has(name)) {
      flush();
      return;
    }
    openInline(name, attrs);
  };

  const handleClose = (name) => {
    if (SKIP_TAGS.has(name)) {
      if (skipDepth > 0) skipDepth -= 1;
      return;
    }
    if (skipDepth > 0) return;

    if (name === 'pre') {
      if (preDepth > 0) preDepth -= 1;
      if (preDepth === 0) {
        const body = preBuffer.replace(/\r\n?/gu, '\n').replace(/^\n+|\n+$/gu, '');
        preBuffer = '';
        if (body.length > 0) {
          emit('```');
          for (const line of body.split('\n').slice(0, 60)) emit(line);
          emit('```');
          emit('');
        }
      }
      return;
    }
    if (preDepth > 0) return;

    if (table !== null) {
      if (name === 'td' || name === 'th') {
        if (table.row !== null) table.row.push(collapse(table.cell ?? ''));
        table.cell = null;
      } else if (name === 'tr') {
        if (table.row !== null && table.row.length > 0) table.rows.push(table.row);
        table.row = null;
      } else if (name === 'table') {
        renderTable();
      }
      return;
    }

    if (name === 'ul' || name === 'ol') {
      flush();
      lists.pop();
      emit('');
      return;
    }
    if (name === 'li') {
      flush();
      return;
    }
    if (/^h[1-6]$/u.test(name)) {
      flush();
      headingLevel = 0;
      emit('');
      return;
    }
    if (name === 'p' || name === 'div' || name === 'blockquote' || BLOCK_TAGS.has(name)) {
      flush();
      return;
    }
    closeFrame(name);
  };

  TAG_PATTERN.lastIndex = 0;
  let cursor = 0;
  let match;
  while ((match = TAG_PATTERN.exec(html)) !== null) {
    const text = html.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    if (text.length > 0) {
      const decoded = decodeEntities(text);
      if (preDepth > 0) preBuffer += decoded;
      else if (skipDepth === 0) {
        if (table !== null && table.cell !== null) table.cell += decoded;
        else buffer += decoded;
      }
    }
    if (match[2] === undefined) continue; // comment, doctype, or CDATA
    const name = match[2].toLowerCase();
    if (match[1] === '/') handleClose(name);
    else handleOpen(name, parseAttributes(match[3]));
  }
  if (cursor < html.length) buffer += decodeEntities(html.slice(cursor));

  flush();
  if (table !== null) renderTable();

  const content = lines
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  return { content, truncated };
}

/**
 * Reduce HTML to one whitespace-collapsed string, for keyword scanning.
 * @param {string} html - page HTML.
 * @param {number} maxChars - ceiling on the returned text.
 * @returns {string} plain text.
 */
export function htmlToPlainText(html, maxChars = 20000) {
  if (typeof html !== 'string' || html.length === 0) return '';
  let skipDepth = 0;
  let out = '';
  TAG_PATTERN.lastIndex = 0;
  let cursor = 0;
  let match;
  while ((match = TAG_PATTERN.exec(html)) !== null && out.length < maxChars) {
    const text = html.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    if (text.length > 0 && skipDepth === 0) out += decodeEntities(text);
    if (match[2] === undefined) continue;
    const name = match[2].toLowerCase();
    if (SKIP_TAGS.has(name)) {
      if (match[1] === '/') skipDepth = Math.max(0, skipDepth - 1);
      else skipDepth += 1;
    } else if (skipDepth === 0) {
      out += ' ';
    }
  }
  if (cursor < html.length && skipDepth === 0) out += decodeEntities(html.slice(cursor));
  return collapse(out).slice(0, maxChars);
}
