import test from 'node:test';
import assert from 'node:assert/strict';
import { searchWeb } from '../lib/search.js';

const DEFAULTS = { apiKey: 'unit-test-secret-key', model: 'deepseek-flash', prompt: '核实这篇文章的最新数据', contextTitle: '光通信行业', previousQuestion: '公司产能发生什么变化？' };
const planner = queries => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ queries }) } }] }));
const searchResponse = results => new Response(JSON.stringify({ results }));
const result = (url, overrides = {}) => ({ title: '公司公告', url, content: '官方披露的正文', summary: '摘要', snippet: '短摘', date: '2026-10-17T08:00:00Z', site_name: 'Example', ...overrides });

test('plans and searches official APIs sequentially with private minimal planner input', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const notices = [];
  let pending = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(pending, false, 'requests must not overlap');
    pending = true;
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    await Promise.resolve();
    pending = false;
    if (url.endsWith('/chat/completions')) return planner(['光通信 产能 官方公告', '光通信 2026 最新进展']);
    return searchResponse([result(`https://example.com/${calls.length}`)]);
  };
  try {
    const value = await searchWeb({ ...DEFAULTS, style: 'SECRET_STYLE', pageText: 'SECRET_PAGE_TEXT', onStatus: value => notices.push(value) });
    assert.equal(value.status, 'complete');
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
    assert.equal(calls[0].body.stream, false);
    assert.deepEqual(calls[0].body.thinking, { type: 'disabled' });
    assert.equal(calls[0].body.max_tokens, 384);
    assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
    const plannerInput = JSON.stringify(calls[0].body.messages);
    for (const secret of ['unit-test-secret-key', 'SECRET_STYLE', 'SECRET_PAGE_TEXT']) assert.ok(!plannerInput.includes(secret));
    assert.ok(plannerInput.includes(DEFAULTS.prompt));
    assert.ok(plannerInput.includes(DEFAULTS.contextTitle));
    assert.match(plannerInput, /\d{4}-\d{2}-\d{2}/);
    for (const call of calls) {
      assert.equal(call.options.headers.Authorization, `Bearer ${DEFAULTS.apiKey}`);
      assert.equal(call.options.credentials, 'omit');
      assert.equal(call.options.cache, 'no-store');
      assert.equal(call.options.redirect, 'error');
    }
    for (const call of calls.slice(1)) {
      assert.equal(call.url, 'https://api.deepseek.com/v1/tools/search');
      assert.equal(call.body.count, 5);
      assert.equal(call.body.need_content, true);
      assert.ok([...call.body.ori_question].length <= 128);
    }
    assert.deepEqual(value.queries, ['光通信 产能 官方公告', '光通信 2026 最新进展']);
    assert.equal(value.results[0].id, 'W1');
    assert.equal(value.results[0].coverage, 'content');
    assert.ok(Number.isFinite(Date.parse(value.searchedAt)));
    assert.ok(notices.every(value => typeof value === 'string'));
  } finally { globalThis.fetch = originalFetch; }
});

test('planner and search inputs enforce Unicode query limits and at most two unique queries', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    if (url.endsWith('/chat/completions')) return planner(['😀'.repeat(200), '😀'.repeat(200), '第二条', '第三条', 5, '']);
    return searchResponse([]);
  };
  try {
    const value = await searchWeb({ ...DEFAULTS, prompt: '问'.repeat(5000), contextTitle: '题'.repeat(1000), previousQuestion: '前'.repeat(1000) });
    const input = JSON.parse(calls[0].messages.at(-1).content);
    assert.ok(input.prompt.length <= 3000);
    assert.ok(input.contextTitle.length <= 300);
    assert.ok(input.previousQuestion.length <= 500);
    assert.equal(value.queries.length, 2);
    assert.equal([...value.queries[0]].length, 128);
    assert.equal(value.queries[1], '第二条');
    assert.equal(value.status, 'empty');
    for (const body of calls.slice(1)) {
      assert.ok([...body.query].length <= 128);
      assert.ok([...body.ori_question].length <= 128);
      assert.ok(!body.query.includes('\uFFFD'));
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('planner receives bounded beginning-middle-end evidence, while search receives only short queries', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const contextText = '头'.repeat(5000) + '中'.repeat(5000) + '尾'.repeat(5000);
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    return url.endsWith('/chat/completions') ? planner(['光通信 公司公告 2026']) : searchResponse([]);
  };
  try {
    await searchWeb({ ...DEFAULTS, contextText });
    const input = JSON.parse(calls[0].body.messages.at(-1).content);
    assert.equal(input.pageExcerpt.length, 6000);
    assert.equal(input.pageExcerpt.slice(0, 3000), '头'.repeat(3000));
    assert.equal(input.pageExcerpt.slice(3000, 4500), '中'.repeat(1500));
    assert.equal(input.pageExcerpt.slice(4500), '尾'.repeat(1500));
    assert.match(calls[0].body.messages[0].content, /不可信|不受信任/);
    assert.match(calls[0].body.messages[0].content, /事实|论点/);
    assert.ok(!JSON.stringify(calls[1].body).includes('头'.repeat(20)));
    assert.ok(!JSON.stringify(calls[1].body).includes('中'.repeat(20)));
    assert.ok(!JSON.stringify(calls[1].body).includes('尾'.repeat(20)));
    assert.deepEqual(Object.keys(calls[1].body).sort(), ['count', 'need_content', 'ori_question', 'query']);
    assert.ok([...calls[1].body.query].length <= 128);
    calls.length = 0;
    await searchWeb({ ...DEFAULTS, contextText: '短文原样提供。' });
    assert.equal(JSON.parse(calls[0].body.messages.at(-1).content).pageExcerpt, '短文原样提供。');
  } finally { globalThis.fetch = originalFetch; }
});

test('planner failure or malformed JSON transparently falls back to one local query', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const mode of ['network', 'http', 'json', 'queries']) {
      const notices = [];
      let searchQuery;
      globalThis.fetch = async (url, options) => {
        if (url.endsWith('/chat/completions')) {
          if (mode === 'network') throw new Error('SECRET upstream failure');
          if (mode === 'http') return new Response('SECRET upstream failure', { status: 503 });
          if (mode === 'json') return new Response('{broken');
          return planner([]);
        }
        searchQuery = JSON.parse(options.body).query;
        return searchResponse([]);
      };
      const value = await searchWeb({ ...DEFAULTS, onStatus: value => notices.push(value) });
      assert.equal(value.status, 'empty');
      assert.deepEqual(value.queries, [searchQuery]);
      assert.ok(searchQuery.includes('光通信'));
      assert.ok([...searchQuery].length <= 128);
      assert.ok(notices.some(value => /规划.*未|本地|直接.*关键词/.test(value)));
      assert.ok(!notices.join('').includes('SECRET'));
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('search failure never reports earlier partial search results as success', async () => {
  const originalFetch = globalThis.fetch;
  let searches = 0;
  globalThis.fetch = async url => {
    if (url.endsWith('/chat/completions')) return planner(['first', 'second']);
    if (++searches === 1) return searchResponse([result('https://example.com/first')]);
    return new Response('unit-test-secret-key', { status: 402 });
  };
  try {
    await assert.rejects(searchWeb(DEFAULTS), error => /余额/.test(error.message) && !error.message.includes(DEFAULTS.apiKey));
    assert.equal(searches, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('malformed search shape is failure rather than a fabricated empty search', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => url.endsWith('/chat/completions') ? planner(['query']) : new Response(JSON.stringify({ error: 'SECRET' }));
  try { await assert.rejects(searchWeb(DEFAULTS), /格式|结果/); }
  finally { globalThis.fetch = originalFetch; }
});

test('normalizes duplicate URLs, drops unsafe links, distinguishes content and summary', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => url.endsWith('/chat/completions') ? planner(['query']) : searchResponse([
    result('HTTPS://EXAMPLE.COM:443/a#one'),
    result('https://example.com/a#two'),
    result('javascript:alert(1)'), result('data:text/html,abc'), result('https://user:pass@example.com/private'),
    result('file:///etc/passwd'), result('not a url'),
    result('https://example.com/summary', { content: '', summary: '仅有摘要', date: null }),
    result('https://example.com/snippet', { content: ' ', summary: '', snippet: '仅有短摘要' }),
    result('https://example.com/empty', { content: '', summary: '', snippet: '' }),
  ]);
  try {
    const value = await searchWeb(DEFAULTS);
    assert.equal(value.results.length, 3);
    assert.equal(value.results[0].url, 'https://example.com/a');
    assert.deepEqual(value.results.map(item => item.id), ['W1', 'W2', 'W3']);
    assert.equal(value.results[1].coverage, 'summary');
    assert.equal(value.results[1].text, '仅有摘要');
    assert.equal(value.results[1].publishedAt, null);
    assert.equal(value.results[2].text, '仅有短摘要');
    assert.ok(!JSON.stringify(value).includes(DEFAULTS.apiKey));
  } finally { globalThis.fetch = originalFetch; }
});

test('drops URLs that exceed the limit after Unicode URL normalization', async () => {
  const originalFetch = globalThis.fetch;
  const expandingURL = `https://example.com/${'汉'.repeat(1000)}`;
  assert.ok(expandingURL.length < 8192);
  assert.ok(new URL(expandingURL).href.length > 8192);
  globalThis.fetch = async url => url.endsWith('/chat/completions') ? planner(['query']) : searchResponse([
    result(expandingURL), result('https://example.com/正常'),
  ]);
  try {
    const value = await searchWeb(DEFAULTS);
    assert.equal(value.results.length, 1);
    assert.equal(value.results[0].url, new URL('https://example.com/正常').href);
  } finally { globalThis.fetch = originalFetch; }
});

test('bounds result count and text budgets, preserves truncation flags', async () => {
  const originalFetch = globalThis.fetch;
  let index = 0;
  globalThis.fetch = async url => url.endsWith('/chat/completions') ? planner(['one', 'two']) : searchResponse(Array.from({ length: 5 }, () => result(`https://example.com/${++index}`, { content: '正'.repeat(15000) })));
  try {
    const value = await searchWeb(DEFAULTS);
    assert.equal(value.results.length, 8);
    assert.ok(value.results.every(item => item.text.length <= 8000 && item.text.length > 0 && item.truncated));
    assert.ok(value.results.reduce((sum, item) => sum + item.text.length, 0) <= 40000);
  } finally { globalThis.fetch = originalFetch; }
});

test('abort propagates during planner body parsing without invoking fallback search', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  let cancelled = false;
  globalThis.fetch = async () => {
    calls++;
    return new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode('{"choices":')); setTimeout(() => controller.abort(), 5); },
      cancel() { cancelled = true; },
    }));
  };
  try {
    await assert.rejects(searchWeb({ ...DEFAULTS, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('search timeout covers pending body parsing and cancels the reader', async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async url => url.endsWith('/chat/completions') ? planner(['query']) : new Response(new ReadableStream({
    start(stream) { stream.enqueue(new TextEncoder().encode('{"results":')); },
    cancel() { cancelled = true; },
  }));
  try {
    await assert.rejects(searchWeb({ ...DEFAULTS, timeoutMs: 15 }), /超时/);
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('planner timeout falls back; pre-aborted and missing-key calls never network', async () => {
  const originalFetch = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async url => {
    count++;
    if (url.endsWith('/chat/completions')) return new Promise(() => {});
    return searchResponse([]);
  };
  try {
    assert.equal((await searchWeb({ ...DEFAULTS, timeoutMs: 10 })).status, 'empty');
    assert.equal(count, 2);
    await assert.rejects(searchWeb({ ...DEFAULTS, signal: AbortSignal.abort() }), { name: 'AbortError' });
    await assert.rejects(searchWeb({ ...DEFAULTS, apiKey: '' }), /Key|密钥/);
    assert.equal(count, 2);
  } finally { globalThis.fetch = originalFetch; }
});
