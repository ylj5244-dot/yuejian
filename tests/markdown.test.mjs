import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../lib/markdown.js';

test('renders headings, paragraphs and inline emphasis as readable HTML', () => {
  const html = renderMarkdown('# 标题\n\n一段 **重要** 与 *强调* 和 `a < b`。');
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<p>一段 <strong>重要<\/strong> 与 <em>强调<\/em> 和 <code>a &lt; b<\/code>。<\/p>/);
});

test('renders ordered and unordered lists, quotes and fenced code', () => {
  const html = renderMarkdown('- 第一\n- 第二\n\n1. 一\n2. 二\n\n> 引用\n\n```html\n<script>alert(1)</script>\n```');
  assert.match(html, /<ul><li>第一<\/li><li>第二<\/li><\/ul>/);
  assert.match(html, /<ol><li>一<\/li><li>二<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>引用<\/p><\/blockquote>/);
  assert.match(html, /<pre><code[^>]*>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code><\/pre>/);
});

test('renders a Markdown table with inline formatting', () => {
  const html = renderMarkdown('| 指标 | 结果 |\n| --- | ---: |\n| 增长 | **12%** |');
  assert.match(html, /<table>/);
  assert.match(html, /<th>指标<\/th>/);
  assert.match(html, /<td><strong>12%<\/strong><\/td>/);
});

test('escapes raw HTML including event handlers', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n<img src=x onerror="alert(2)">\n<iframe srcdoc="evil"></iframe>');
  assert.doesNotMatch(html, /<(?:script|img|iframe)(?:\s|>)/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img /);
});

test('never creates active javascript, data, protocol-relative or file links', () => {
  const html = renderMarkdown('[a](javascript:alert(1)) [b](data:text/html,evil) [c](JaVaScRiPt:evil) [d](file:///secret) [e](//evil.test) [f](jav&#x61;script:evil)');
  assert.doesNotMatch(html, /<a\b/i);
});

test('external HTTP links have escaped attributes and safe new-tab attributes', () => {
  const html = renderMarkdown('[文档](https://example.com/a?one=1&two=2)');
  assert.match(html, /href="https:\/\/example\.com\/a\?one=1&amp;two=2"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, />文档<\/a>/);
});

test('remote images are replaced with readable labels without network-loaded elements', () => {
  const html = renderMarkdown('![跟踪像素](https://tracker.example/pixel)');
  assert.doesNotMatch(html, /<(?:img|picture|source|svg|video|audio)\b/i);
  assert.match(html, /跟踪像素/);
});

test('Markdown inside code remains literal and malformed input stays safe', () => {
  const html = renderMarkdown('`[evil](https://example.com) **bold**`\n\n```\n<img src=x>\n**plain**');
  assert.doesNotMatch(html, /<a\b|<strong>|<img\b/);
  assert.match(html, /\[evil\]\(https:\/\/example.com\) \*\*bold\*\*/);
  assert.match(html, /&lt;img src=x&gt;/);
});

test('hostile link labels and quoted destinations cannot break attributes', () => {
  const html = renderMarkdown('[<img src=x onerror=evil>](https://example.com/\"onmouseover=\"evil)');
  assert.doesNotMatch(html, /<img\b|\sonmouseover="/i);
  assert.match(html, /&lt;img/);
});

test('accepts empty or nonstring output without throwing', () => {
  assert.equal(renderMarkdown(null), '');
  assert.equal(renderMarkdown(''), '');
  assert.match(renderMarkdown(123), /123/);
});
