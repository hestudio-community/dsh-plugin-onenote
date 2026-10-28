import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOneNoteHtml, htmlToPlainText, renderPage, decodeEntities } from '../src/parser.js';

test('decodes the character references OneNote emits', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &nbsp;d'), 'a & b <c>  d');
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB');
  assert.equal(decodeEntities('&unknown;'), '&unknown;');
});

test('renders headings, paragraphs, and emphasis', () => {
  const md = parseOneNoteHtml('<h1>Title</h1><p>Hello <strong>bold</strong> and <em>it</em>.</p>');
  assert.match(md, /^# Title$/m);
  assert.match(md, /Hello \*\*bold\*\* and _it_\./);
});

test('renders nested bullet lists with indentation', () => {
  const md = parseOneNoteHtml('<ul><li>one</li><li>two<ul><li>two-a</li></ul></li></ul>');
  assert.match(md, /^- one$/m);
  assert.match(md, /^- two$/m);
  assert.match(md, /^ {2}- two-a$/m);
});

test('renders ordered lists with increments', () => {
  const md = parseOneNoteHtml('<ol><li>first</li><li>second</li></ol>');
  assert.match(md, /^1\. first$/m);
  assert.match(md, /^2\. second$/m);
});

test('renders a table as a Markdown table', () => {
  const md = parseOneNoteHtml('<table><tr><th>Name</th><th>Qty</th></tr><tr><td>Bolts</td><td>12</td></tr></table>');
  assert.match(md, /^\| Name \| Qty \|$/m);
  assert.match(md, /^\| --- \| --- \|$/m);
  assert.match(md, /^\| Bolts \| 12 \|$/m);
});

test('renders fenced code and inline code', () => {
  const md = parseOneNoteHtml('<pre>line1\nline2</pre><p>call <code>f()</code></p>');
  assert.match(md, /```\nline1\nline2\n```/);
  assert.match(md, /`f\(\)`/);
});

test('keeps link text and href', () => {
  const md = parseOneNoteHtml('<p><a href="https://example.com">docs</a></p>');
  assert.match(md, /\[docs\]\(https:\/\/example\.com\)/);
});

test('drops javascript: links to plain text', () => {
  const md = parseOneNoteHtml('<p><a href="javascript:alert(1)">click</a></p>');
  assert.match(md, /click/);
  assert.doesNotMatch(md, /javascript:/);
});

test('never emits a script body', () => {
  const md = parseOneNoteHtml('<p>keep</p><script>alert("x")</script>');
  assert.match(md, /keep/);
  assert.doesNotMatch(md, /alert/);
});

test('shows only the alt text of an image', () => {
  const md = parseOneNoteHtml('<p><img src="x.png" alt="diagram" /></p>');
  assert.match(md, /🖼️ diagram/);
  assert.doesNotMatch(md, /x\.png/);
});

test('reports truncation through renderPage', () => {
  const html = '<h1>Title</h1>' + '<p>' + 'word '.repeat(400) + '</p>';
  const short = renderPage(html, 100);
  assert.equal(short.truncated, true);
  assert.ok(short.content.length <= 100);
  const whole = renderPage(html, 100000);
  assert.equal(whole.truncated, false);
});

test('returns empty output for empty or non-string input', () => {
  assert.equal(parseOneNoteHtml(''), '');
  assert.equal(parseOneNoteHtml(undefined), '');
  assert.equal(parseOneNoteHtml(null), '');
});

test('plain text strips markup and collapses whitespace', () => {
  const text = htmlToPlainText('<h1>Title</h1><p>a\n  b</p>');
  assert.equal(text, 'Title a b');
  assert.equal(htmlToPlainText(''), '');
});

test('survives unclosed tags', () => {
  const md = parseOneNoteHtml('<p>one<p>two');
  assert.match(md, /one/);
  assert.match(md, /two/);
});

test('keeps the body of a page whose head contains void elements', () => {
  // Regression: OneNote wraps every page in a <head> holding a self-closing
  // <meta>. Counting that open tag raised the skip depth without a matching
  // close, so every real page rendered as an empty string.
  const html = [
    '<html lang="zh-CN"><head><title>VPN</title>',
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />',
    '<meta name="created" content="2026-10-28T14:02:00.0000000" />',
    '</head><body><p>概念：虚拟私有网络</p><p>第二段</p></body></html>',
  ].join('');
  const md = parseOneNoteHtml(html);
  assert.match(md, /概念：虚拟私有网络/);
  assert.match(md, /第二段/);
  assert.doesNotMatch(md, /Content-Type/);
});

test('plain text keeps the body when the head has void elements', () => {
  const html = '<html><head><meta charset="utf-8" /></head><body><p>hello</p></body></html>';
  assert.equal(htmlToPlainText(html), 'hello');
});

test('a void element outside a skipped scope does not swallow later text', () => {
  const md = parseOneNoteHtml('<p>a</p><link rel="x" href="y"><p>b</p>');
  assert.match(md, /a/);
  assert.match(md, /b/);
});
