import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { streamChat } from '../lib/api.js';
import { buildRequest, DEFAULT_STYLE, QUICK_PROMPTS, exportMarkdown } from '../lib/context.js';
import { extractPage } from '../lib/extract.js';
import { extractVisibleBlocks } from '../lib/fallback.js';
import { renderMarkdown } from '../lib/markdown.js';
import { DEFAULT_SETTINGS, DEFAULT_QUICK_PROMPTS, normalizeSettings, validatePreferences } from '../lib/preferences.js';
import { searchWeb } from '../lib/search.js';

// Run the actual controller without its automatic startup. Hooks exist only in this VM.
const source = (await readFile(new URL('../panel.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '')
  .replace(/\ninitialize\(\)\.catch\([^\n]+\);\s*$/, '');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {};
    this.value = ''; this.textContent = ''; this.innerHTML = ''; this.checked = false;
    this.hidden = false; this.disabled = false; this.open = false;
    this.scrollHeight = 500; this.scrollTop = 0; this.clientHeight = 500;
    const classes = new Set();
    this.classList = { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } };
  }
  append(...children) { for (const child of children) { if (typeof child !== 'string') { child.remove(); child.parent = this; } this.children.push(child); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  replaceChildren(...children) { for (const child of [...this.children]) if (typeof child !== 'string') child.remove(); this.children = []; this.append(...children); }
  replaceWith(next) { const parent = this.parent; if (!parent) return; parent.children[parent.children.indexOf(this)] = next; next.parent = parent; this.parent = null; }
  querySelector(selector) {
    const id = /^\[data-id="([^"]+)"\]$/.exec(selector)?.[1];
    for (const child of this.children) {
      if (typeof child === 'string') continue;
      if (id ? child.dataset.id === id : child.tagName === selector) return child;
      const found = child.querySelector(selector); if (found) return found;
    }
    return null;
  }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  click() { return Promise.all((this.listeners.click || []).map(listener => listener({ target: this }))); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
}

async function panel({ apiKey = 'test-only-key', onDelta, executeScript, temporaryAccess = true, allowPermission = true, autoRead = false, webSearchEnabled = false, stored, searchImpl } = {}) {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const elements = new Map();
  const html = await readFile(new URL('../panel.html', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  let pollCallback;
  const doc = { hidden: false, getElementById: id => ids.has(id) ? element(id) : null, createElement: tag => new Element(tag), querySelectorAll: () => [] };
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let tab = { id: 1, windowId: 10, active: true, url: 'https://example.com/one' };
  let captured = { title: '文章一', url: tab.url, text: '第一篇文章的独特正文。', method: 'article' };
  const saved = stored ? structuredClone(stored) : { settings: { apiKey, autoRead, webSearchEnabled } };
  const grants = new Set();
  const permissionCalls = [];
  const clipboardWrites = [];
  const listenerEvent = () => {
    const listeners = [];
    return { addListener(listener) { listeners.push(listener); }, emit(...args) { return Promise.all(listeners.map(listener => listener(...args))); } };
  };
  const onUpdated = listenerEvent(), onMessage = listenerEvent();
  const context = vm.createContext({
    document: doc,
    window: { addEventListener() {} },
    navigator: {
      locks: { request: async (name, _options, callback) => callback({ name }) },
      clipboard: { async writeText(value) { clipboardWrites.push(value); } },
    },
    chrome: {
      storage: { local: {
        async setAccessLevel() {}, async get() { return structuredClone(saved); },
        async set(value) { Object.assign(saved, structuredClone(value)); },
      } },
      tabs: { async query() {
        const visible = { ...tab };
        if (!temporaryAccess && !manifest.permissions.includes('tabs') && !grants.has(`${new URL(tab.url).origin}/*`)) delete visible.url;
        return [visible];
      }, onActivated: listenerEvent(), onUpdated },
      permissions: {
        async contains({ origins }) { return origins.every(origin => grants.has(origin)); },
        async request(request) {
          permissionCalls.push(structuredClone(request));
          if (allowPermission) for (const origin of request.origins) grants.add(origin);
          return allowPermission;
        },
      },
      runtime: { id: 'test-extension', onMessage },
      windows: { async getCurrent() { return { id: 10 }; } },
      scripting: { executeScript: executeScript || (async () => {
        if (!temporaryAccess && !manifest.host_permissions.includes('https://*/*') && !grants.has(`${new URL(tab.url).origin}/*`)) throw new Error('Cannot access contents of the page. Extension manifest must request permission to access this host.');
        return [{ result: { ...captured } }];
      }) },
    },
    crypto: { randomUUID }, URL, Blob, AbortController, DOMException, setTimeout, clearTimeout,
    setInterval(callback) { pollCallback = callback; return 1; }, clearInterval() { pollCallback = null; },
    buildRequest, DEFAULT_STYLE, QUICK_PROMPTS, exportMarkdown, extractPage, extractVisibleBlocks, renderMarkdown,
    DEFAULT_SETTINGS, DEFAULT_QUICK_PROMPTS, normalizeSettings, validatePreferences,
    searchWeb: searchImpl || searchWeb,
    streamChat: options => streamChat({ ...options, onDelta(delta) { options.onDelta(delta); onDelta?.(delta); } }),
  });
  vm.runInContext(`${source}\n;globalThis.hooks = {
    initialize, submit, readCurrent, onPageChanged, saveSettings,
    setContext(enabled) { settings.usePageContext = enabled; },
    state: () => ({ conversation: current(), page, busy, settings })
  };`, context, { filename: 'panel.js' });
  await context.hooks.initialize();
  return {
    ...context.hooks, element, saved, permissionCalls, clipboardWrites,
    async poll() { return pollCallback?.(); },
    setHidden(value) { doc.hidden = value; },
    async completed() { return onUpdated.emit(tab.id, { status: 'complete' }, { ...tab, status: 'complete' }); },
    async toolbar() { return onMessage.emit({ type: 'yuejian:read-current-tab', tabId: tab.id, windowId: tab.windowId }, { id: 'test-extension' }); },
    setPage(next) { captured = next; tab = { ...tab, id: next.tabId || tab.id, url: next.url }; },
    async send(text) { element('prompt').value = text; await context.hooks.submit(); },
  };
}

test('all-site host permission reads any ordinary page without an activeTab grant or per-site prompt', async () => {
  const app = await panel({ temporaryAccess: false });
  await app.readCurrent();
  assert.equal(app.state().page.title, '文章一');
  app.setPage({ tabId: 2, title: '另一站点', url: 'https://second.example/story', text: '第二个站点的完整文字' });
  await app.onPageChanged(); await app.readCurrent();
  assert.equal(app.state().page.title, '另一站点');
  assert.equal(app.permissionCalls.length, 0);
});

test('metadata refresh on load completion must not cancel an explicit read', async () => {
  const started = deferred(), extraction = deferred();
  const app = await panel({ executeScript: async () => { started.resolve(); return extraction.promise; } });
  const reading = app.readCurrent();
  await started.promise;
  await app.completed();
  extraction.resolve([{ result: { title: '加载中的文章', url: 'https://example.com/one', text: '不能丢弃的正文。' } }]);
  await reading;
  assert.equal(app.state().page?.text, '不能丢弃的正文。');
  await app.completed();
  assert.match(app.element('pageStatus').textContent, /字符/);
});

test('load completion does not replace an in-flight read when auto-read is enabled', async () => {
  const started = deferred(), extraction = deferred();
  let calls = 0;
  const initial = { title: '加载前', url: 'https://example.com/one', text: '原有文字' };
  const app = await panel({ autoRead: true, executeScript: async () => {
    if (++calls === 2) { started.resolve(); return extraction.promise; }
    return [{ result: initial }];
  } });
  const reading = app.readCurrent(); await started.promise;
  await app.completed(); await new Promise(resolve => setImmediate(resolve));
  extraction.resolve([{ result: { ...initial, title: '读取中的文章', text: '这次读取的正文' } }]);
  await reading;
  assert.equal(calls, 2, 'load completion does not launch a competing read');
  assert.equal(app.state().page?.text, '这次读取的正文');
});

test('toolbar refresh respects auto-read off consistently for an existing panel', async () => {
  let reads = 0;
  const app = await panel({ executeScript: async () => { reads++; return []; } });
  await app.toolbar();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0, 'opening should refresh website identity without bypassing auto-read off');
  assert.match(app.element('pageStatus').textContent, /自动读取已关闭/);
});

const event = value => `data: ${JSON.stringify(value)}\n\n`;
const delta = (content, reasoning = '') => event({ choices: [{ delta: { content, reasoning_content: reasoning } }] });
const finished = text => delta(text) + event({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
const response = text => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
const requestText = request => request.messages.map(message => message.content).join('\n');

test('follow-ups reuse the original article exactly once, even after reading it again', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    requests.push(JSON.parse(options.body)); return response(finished('已完成的分析。'));
  });
  const app = await panel();
  await app.readCurrent();
  await app.send('概括这篇文章');
  const firstSourceId = app.state().conversation.sources[0].id;
  await app.readCurrent(); // A fresh capture has a new ID but identical URL and text.
  await app.send('进一步解释其中的原因');
  const conversation = app.state().conversation;
  assert.equal(conversation.sources.length, 1);
  assert.equal(conversation.sources[0].tabId, undefined);
  assert.equal(conversation.messages[2].sourceIds[0], firstSourceId);
  assert.equal(requestText(requests[1]).split('第一篇文章的独特正文。').length - 1, 1);
  const turns = requests[1].messages.slice(-3);
  assert.deepEqual(turns.map(message => message.role), ['user', 'assistant', 'user']);
  assert.equal(turns[1].content, '已完成的分析。');
  for (const [index, prompt] of [[0, '概括这篇文章'], [2, '进一步解释其中的原因']]) {
    assert.ok(turns[index].content.endsWith(prompt), 'the user’s original prompt remains intact');
    assert.ok(turns[index].content.slice(0, -prompt.length).includes(firstSourceId), 'each turn stays bound to its attached source');
  }
  assert.equal(app.saved.conversations[0].messages.length, 4);
});

test('turning off page context excludes a new article while keeping the conversation’s prior article', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => { requests.push(JSON.parse(options.body)); return response(finished('答复')); });
  const app = await panel();
  await app.readCurrent(); await app.send('先谈第一篇');
  app.setPage({ tabId: 2, title: '不要附带这篇', url: 'https://example.com/two', text: '第二篇未授权附带的独特正文。' });
  await app.onPageChanged(); await app.readCurrent();
  app.setContext(false);
  await app.send('继续谈刚才那篇');
  assert.equal(app.state().conversation.sources.length, 1);
  assert.equal(app.state().conversation.messages[2].sourceIds.length, 0);
  assert.match(requestText(requests[1]), /第一篇文章的独特正文/);
  assert.doesNotMatch(requestText(requests[1]), /第二篇未授权|不要附带这篇/);
});

test('missing API key opens settings without sending, clearing the draft, or adding messages', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return response(finished('不应发送')); });
  const app = await panel({ apiKey: '  ' });
  await app.send('保留这个草稿');
  assert.equal(requests, 0);
  assert.equal(app.state().conversation.messages.length, 0);
  assert.equal(app.element('prompt').value, '保留这个草稿');
  assert.equal(app.element('settingsDialog').open, true);
  assert.match(app.element('notice').textContent, /API Key/);
});

test('Stop aborts the live stream and persists received answer and reasoning', async t => {
  const received = deferred();
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(delta('已经收到的半段回答', '已收到的思考'))); },
    cancel() { cancelled = true; },
  })));
  const app = await panel({ onDelta: received.resolve });
  const sending = app.send('请分析');
  await received.promise;
  assert.equal(app.state().busy, true);
  app.element('stopBtn').click();
  await sending;
  const answer = app.state().conversation.messages.at(-1);
  assert.equal(answer.status, 'stopped');
  assert.equal(answer.content, '已经收到的半段回答');
  assert.equal(answer.reasoning, '已收到的思考');
  assert.equal(app.saved.conversations[0].messages.at(-1).content, answer.content);
  assert.equal(app.saved.conversations[0].messages.at(-1).status, 'stopped');
  assert.equal(cancelled, true);
  assert.equal(app.state().busy, false);
  assert.equal(app.element('sendBtn').hidden, false);
  assert.equal(app.element('stopBtn').hidden, true);
});

test('a stream error preserves partial content, reports the error, and unlocks the composer', async t => {
  t.mock.method(globalThis, 'fetch', async () => response(delta('错误之前的内容', '错误之前的思考') + 'data: invalid-json\n\n'));
  const app = await panel();
  await app.send('请分析');
  const answer = app.state().conversation.messages.at(-1);
  assert.equal(answer.status, 'error');
  assert.equal(answer.content, '错误之前的内容');
  assert.equal(answer.reasoning, '错误之前的思考');
  assert.match(answer.error, /格式|解析/);
  assert.equal(app.saved.conversations[0].messages.at(-1).content, answer.content);
  assert.equal(app.element('notice').textContent, answer.error);
  assert.equal(app.state().busy, false);
  assert.equal(app.element('newChatBtn').disabled, false);
});

test('a delayed read from the old tab cannot overwrite or send the new tab’s article', async t => {
  const oldRead = deferred(); const oldStarted = deferred(); const requests = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => { requests.push(JSON.parse(options.body)); return response(finished('答复')); });
  const app = await panel({ executeScript: async ({ target }) => {
    if (target.tabId === 1) { oldStarted.resolve(); return oldRead.promise; }
    return [{ result: { title: '当前文章', url: 'https://example.com/current', text: '当前标签页的正文' } }];
  } });
  const readingOld = app.readCurrent(); await oldStarted.promise;
  app.setPage({ tabId: 2, url: 'https://example.com/current' });
  await app.onPageChanged(); await app.readCurrent();
  oldRead.resolve([{ result: { title: '旧文章', url: 'https://example.com/one', text: '过期标签页的正文' } }]);
  await readingOld;
  assert.equal(app.state().page.title, '当前文章');
  assert.match(app.element('pageStatus').textContent, /当前文章/);
  await app.send('解读当前文章');
  assert.match(requestText(requests[0]), /当前标签页的正文/);
  assert.doesNotMatch(requestText(requests[0]), /过期标签页的正文/);
  assert.equal(app.state().conversation.sources.length, 1);
});


test('sending captures the current page afresh and preserves distinct snapshots at the same URL', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => { requests.push(JSON.parse(options.body)); return response(finished('回答')); });
  const app = await panel();
  await app.send('这一页讲什么？');
  assert.match(requestText(requests[0]), /第一篇文章的独特正文/);
  app.setPage({ title: '动态页面', url: 'https://example.com/one', text: '刚刚加载出来的新评论' });
  await app.send('新内容呢？');
  assert.equal(app.state().conversation.sources.length, 2);
  assert.equal(app.state().conversation.sources[0].text, '第一篇文章的独特正文。');
  const latest = app.state().conversation.messages[2].sourceIds[0];
  assert.equal(app.state().conversation.sources.find(s => s.id === latest).text, '刚刚加载出来的新评论');
  assert.match(requestText(requests[1]), /刚刚加载出来的新评论/);
});

test('background refresh reads loaded updates locally and pauses while the panel is hidden', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return response(finished('回答')); });
  const app = await panel({ autoRead: true });
  app.setPage({ title: '新内容', url: 'https://example.com/one', text: '页面自动更新的文字' });
  await app.poll();
  assert.equal(app.state().page.text, '页面自动更新的文字');
  app.setHidden(true);
  app.setPage({ title: '隐藏后', url: 'https://example.com/one', text: '不应轮询读取' });
  await app.poll();
  assert.equal(app.state().page.text, '页面自动更新的文字');
  assert.equal(requests, 0);
});

test('double submission during page extraction makes only one chat request', async t => {
  const started = deferred(), extraction = deferred(); let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return response(finished('回答')); });
  const app = await panel({ executeScript: async () => { started.resolve(); return extraction.promise; } });
  const sending = app.send('一次提问'); await started.promise;
  await app.send('不能重复发送');
  extraction.resolve([{ result: { title: '网页', url: 'https://example.com/one', text: '完整页面文字' } }]);
  await sending;
  assert.equal(requests, 1);
  assert.equal(app.state().conversation.messages.length, 2);
});

test('a failed fresh read never attaches a stale current page', async t => {
  let fails = false; const requests = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => { requests.push(JSON.parse(options.body)); return response(finished('回答')); });
  const app = await panel({ executeScript: async () => {
    if (fails) throw new Error('Cannot access contents of the page');
    return [{ result: { title: '旧页面', url: 'https://example.com/one', text: '历史页面原文' } }];
  } });
  await app.send('第一问'); fails = true;
  await app.send('现在的页面呢？');
  const latest = app.state().conversation.messages[2];
  assert.equal(latest.sourceIds.length, 0);
  assert.equal(latest.pageContextStatus, 'unavailable');
  assert.equal(app.state().page, null);
});

test('more than four pages remain in one conversation with bounded immutable source bodies', async t => {
  t.mock.method(globalThis, 'fetch', async () => response(finished('回答')));
  const app = await panel();
  for (let i = 0; i < 8; i++) {
    app.setPage({ title: `页面${i}`, url: `https://example.com/page-${i}`, text: `不同正文${i}` });
    await app.send(`谈谈页面${i}`);
  }
  assert.equal(app.state().conversation.messages.length, 16);
  assert.equal(app.state().conversation.sources.length, 8);
  assert.equal(app.state().conversation.sources.filter(s => s.text).length, 6);
  assert.equal(app.state().conversation.sources[0].archived, true);
  assert.equal(app.state().conversation.sources.at(-1).text, '不同正文7');
});

test('retry cannot start a second stream while a new message is capturing its page', async t => {
  let requests = 0, reads = 0;
  const started = deferred(), extraction = deferred();
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return response(requests === 1 ? 'data: invalid-json\n\n' : finished('回答'));
  });
  const app = await panel({ executeScript: async () => {
    if (++reads > 1) { started.resolve(); return extraction.promise; }
    return [{ result: { title: '网页', url: 'https://example.com/one', text: '网页文字' } }];
  } });
  await app.send('先提问');
  const findRetry = node => {
    if (node.textContent === '重新生成') return node;
    for (const child of node.children || []) { if (typeof child === 'string') continue; const found = findRetry(child); if (found) return found; }
  };
  const retry = findRetry(app.element('messages'));
  assert.ok(retry);
  assert.equal(retry.disabled, false);
  const sending = app.send('接着问'); await started.promise;
  await retry.click();
  assert.equal(requests, 1, 'no retry network request during extraction');
  extraction.resolve([{ result: { title: '网页', url: 'https://example.com/one', text: '新的页面文字' } }]);
  await sending;
  assert.equal(requests, 2);
  assert.equal(app.state().conversation.messages.length, 4);
});

test('a missing injection result automatically uses the independent visible reader', async () => {
  const calls = [];
  const app = await panel({ executeScript: async options => {
    calls.push(options);
    if (options.func.name === 'extractPage') return [{ frameId: 0 }];
    return [{ result: { ok: true, title: '兼容页面', url: 'https://example.com/one', text: '备用方式读到的可见文字', method: 'visible-blocks', partial: true } }];
  } });
  await app.readCurrent();
  assert.equal(app.state().page?.text, '备用方式读到的可见文字');
  assert.equal(app.state().page?.partial, true);
  assert.deepEqual(calls.map(call => call.func.name), ['extractPage', 'extractVisibleBlocks']);
  assert.equal(calls[0].args[0].captureErrors, true);
  assert.match(app.element('pageStatus').textContent, /兼容读取.*部分/);
});

test('a structured extractor exception falls back and the sent source remains partial', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => { requests.push(JSON.parse(options.body)); return response(finished('答复')); });
  const app = await panel({ executeScript: async ({ func }) => [{ result: func.name === 'extractPage'
    ? { ok: false, error: { code: 'EXTRACTION_FAILED', message: 'Range failed' } }
    : { ok: true, title: '部分页面', url: 'https://example.com/one', text: '可见正文', method: 'visible-blocks', partial: true } }] });
  await app.send('请整理这篇文章');
  assert.equal(app.state().conversation.sources[0]?.partial, true);
  assert.match(requestText(requests[0]), /可见正文/);
});

test('identical text keeps distinct immutable sources when capture coverage changes', async t => {
  const requests = [];
  let coverage = 'full';
  const captured = { title: '同一篇文章', url: 'https://example.com/one', text: '相同的正文片段', method: 'page' };
  t.mock.method(globalThis, 'fetch', async (_, options) => { requests.push(JSON.parse(options.body)); return response(finished('答复')); });
  const app = await panel({ executeScript: async ({ func }) => {
    if (coverage === 'partial') return func.name === 'extractPage' ? [{}]
      : [{ result: { ...captured, method: 'visible-blocks', partial: true } }];
    return [{ result: { ...captured, truncated: coverage === 'truncated' } }];
  } });
  await app.send('首次读取');
  const first = JSON.stringify(app.state().conversation.sources[0]);
  coverage = 'partial'; await app.send('再次读取');
  const conversation = app.state().conversation;
  const partialId = conversation.messages[2].sourceIds[0];
  assert.notEqual(partialId, conversation.messages[0].sourceIds[0]);
  assert.equal(conversation.sources.find(source => source.id === partialId).partial, true);
  const materialsMessage = requests[1].messages[1].content;
  const materials = JSON.parse(materialsMessage.slice(materialsMessage.indexOf('{'))).sources;
  assert.equal(materials.find(source => source.id === partialId).partial, true);
  assert.match(requests[1].messages.at(-1).content, /仅部分可见文字/);
  coverage = 'truncated'; await app.send('读取截断版本');
  const truncatedId = conversation.messages[4].sourceIds[0];
  assert.equal(conversation.sources.length, 3);
  assert.equal(conversation.sources.find(source => source.id === truncatedId).truncated, true);
  assert.equal(JSON.stringify(conversation.sources[0]), first, 'the original complete snapshot is unchanged');
});

test('load completion during send-time fallback preserves the article in the chat request', async t => {
  const started = deferred(), fallback = deferred(), requests = [];
  let calls = 0;
  const captured = { title: '当前文章', url: 'https://example.com/one', text: '发送时必须附带的正文', method: 'page' };
  t.mock.method(globalThis, 'fetch', async (_, options) => { requests.push(JSON.parse(options.body)); return response(finished('答复')); });
  const app = await panel({ autoRead: true, executeScript: async ({ func }) => {
    calls++;
    if (calls === 2) return [{}];
    if (func.name === 'extractVisibleBlocks') { started.resolve(); return fallback.promise; }
    return [{ result: captured }];
  } });
  const sending = app.send('请解释当前文章'); await started.promise;
  await app.completed(); await new Promise(resolve => setImmediate(resolve));
  fallback.resolve([{ result: { ...captured, method: 'visible-blocks', partial: true } }]);
  await sending;
  assert.equal(calls, 3, 'only startup, send-time primary, and send-time fallback reads run');
  assert.equal(app.state().conversation.messages[0].sourceIds.length, 1);
  assert.equal(app.state().conversation.messages[0].pageContextStatus, undefined);
  assert.match(requestText(requests[0]), /发送时必须附带的正文/);
});

test('access restrictions and Chrome permission failures never trigger a second reader', async () => {
  for (const permissionFailure of [false, true]) {
    let calls = 0;
    const app = await panel({ executeScript: async () => {
      calls++;
      if (permissionFailure) throw new Error('Cannot access contents of the page: permission required');
      return [{ result: { ok: false, error: { code: 'ACCESS_RESTRICTED', message: '页面显示订阅访问限制。' } } }];
    } });
    await app.readCurrent();
    assert.equal(calls, 1);
    assert.equal(app.state().page, null);
    assert.match(app.element('pageStatus').textContent, permissionFailure ? /网站访问权限/ : /订阅访问限制/);
  }
});

test('two failed readers expose diagnostic codes without copying page text or keys', async () => {
  let calls = 0;
  const app = await panel({ apiKey: 'SECRET_API_KEY', executeScript: async () => {
    calls++;
    return [{ result: { ok: false, error: { code: calls === 1 ? 'EXTRACTION_FAILED' : 'NO_VISIBLE_TEXT', type: calls === 1 ? 'IndexSizeError' : 'SECRET_ERROR_TYPE', message: 'DO_NOT_COPY_PAGE_CONTENT' }, diagnostics: { readyState: 'complete', bodyPresent: true, frameCount: 3, text: 'SECRET_PAGE_BODY' } } }];
  } });
  app.setPage({ url: 'https://example.com/private/SECRET_PATH?token=SECRET_URL_TOKEN' });
  await app.readCurrent();
  await app.element('settingsBtn').click();
  const report = app.element('readDiagnostics').textContent;
  assert.match(report, /EXTRACTION_FAILED/);
  assert.match(report, /NO_VISIBLE_TEXT/);
  assert.match(report, /IndexSizeError/);
  assert.doesNotMatch(report, /SECRET_API_KEY|SECRET_PAGE_BODY|DO_NOT_COPY_PAGE_CONTENT|SECRET_PATH|SECRET_URL_TOKEN|SECRET_ERROR_TYPE/);
  await app.element('copyDiagnosticsBtn').click();
  assert.equal(app.clipboardWrites.length, 1);
  assert.equal(app.clipboardWrites[0], report, 'the actual copy action uses only the sanitized diagnostic report');
  assert.match(app.element('pageStatus').textContent, /读取诊断/);
  assert.equal(calls, 2);
});

test('a late fallback result cannot attach text from a previous tab', async () => {
  const started = deferred(), fallback = deferred();
  const app = await panel({ executeScript: async ({ func }) => {
    if (func.name === 'extractPage') return [{}];
    started.resolve(); return fallback.promise;
  } });
  const reading = app.readCurrent();
  // Do not await an event the broken controller never emits.
  await Promise.race([started.promise, reading]);
  app.setPage({ tabId: 2, url: 'https://example.com/two', text: '第二页' });
  await app.onPageChanged();
  fallback.resolve([{ result: { title: '旧页', url: 'https://example.com/one', text: '迟到的旧页文字', method: 'visible-blocks', partial: true } }]);
  await reading;
  assert.equal(app.state().page, null);
  assert.equal(app.element('pageStatus').textContent.includes('旧页'), false);
});

test('enabled web search runs before the answer and preserves source evidence for reload', async t => {
  const stages = [], requests = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => { stages.push('answer'); requests.push(JSON.parse(options.body)); return response(finished('有来源的答复')); });
  const app = await panel({ webSearchEnabled: true, searchImpl: async options => {
    stages.push('search'); assert.equal(options.prompt, '核实这个消息');
    return { status: 'complete', queries: ['官方最新公告'], searchedAt: '2026-10-18T03:00:00Z', results: [{ id: 'W1', title: '正式公告', url: 'https://example.org/report', text: '联网核实独有证据', coverage: 'content' }] };
  } });
  await app.send('核实这个消息');
  assert.deepEqual(stages, ['search', 'answer']);
  assert.match(requestText(requests[0]), /联网核实独有证据/);
  assert.equal(app.saved.conversations[0].messages[0].webSearch.status, 'complete');
  const resumed = await panel({ stored: app.saved });
  assert.equal(resumed.state().conversation.messages[0].webSearch.results[0].url, 'https://example.org/report');
});

test('real planner, search, context and streamed answer share only the current DeepSeek key', async t => {
  const requests = [];
  const apiKey = 'CURRENT_DEEPSEEK_SECRET', legacyKey = 'UNUSED_LEGACY_SEARCH_SECRET';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, options, body });
    if (url === 'https://api.deepseek.com/chat/completions' && body.stream === false) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ queries: ['官方最新公告'] }) } }] }));
    }
    if (url === 'https://api.deepseek.com/v1/tools/search') {
      return new Response(JSON.stringify({ results: [
        { title: '正式公告', url: 'https://official.example/report#section', content: '真实搜索链路的独有证据', date: '2026-10-18T01:00:00Z' },
        { title: '危险链接', url: 'javascript:alert(1)', content: '不得使用的证据' },
        { title: '带凭据的链接', url: 'https://user:password@official.example/private', content: '不得保留凭据' },
      ] }));
    }
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(body.stream, true);
    return response(finished('已按[正式公告](https://official.example/report)核实。'));
  });
  const app = await panel({ stored: { settings: { apiKey, searchApiKey: legacyKey, autoRead: false, webSearchEnabled: true, memory: '保存的回答要求', style: '保存的写作要求' } } });
  await app.send('请联网核实这篇文章');
  assert.deepEqual(requests.map(request => [request.url, request.body.stream]), [
    ['https://api.deepseek.com/chat/completions', false],
    ['https://api.deepseek.com/v1/tools/search', undefined],
    ['https://api.deepseek.com/chat/completions', true],
  ]);
  for (const request of requests) {
    assert.equal(request.options.headers.Authorization, `Bearer ${apiKey}`);
    assert.doesNotMatch(request.options.body, /CURRENT_DEEPSEEK_SECRET|UNUSED_LEGACY_SEARCH_SECRET/);
    assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.redirect, 'error');
  }
  assert.match(JSON.stringify(requests[0].body.messages), /文章一/);
  assert.match(JSON.stringify(requests[0].body.messages), /第一篇文章的独特正文/);
  assert.doesNotMatch(JSON.stringify(requests[0].body.messages), /保存的回答要求|保存的写作要求/);
  assert.equal(requests[1].body.query, '官方最新公告');
  assert.doesNotMatch(JSON.stringify(requests[1].body), /第一篇文章的独特正文|保存的回答要求|保存的写作要求/);
  const answer = requestText(requests[2].body);
  for (const text of ['第一篇文章的独特正文', '真实搜索链路的独有证据', 'https://official.example/report', '保存的回答要求']) assert.ok(answer.includes(text));
  assert.doesNotMatch(answer, /危险链接|javascript:|不得保留凭据|user:password/);
  const user = app.state().conversation.messages[0];
  assert.ok(answer.includes(`${user.id}/W1`), 'the actual evidence is bound to this user turn');
  assert.equal(user.webSearch.status, 'complete');
  assert.equal(user.webSearch.results.length, 1);
  assert.equal(user.webSearch.results[0].url, 'https://official.example/report');
  assert.equal(app.saved.conversations[0].messages.at(-1).status, 'complete');
});

test('search failure stops generation and turning search off permits an ordinary retry', async t => {
  let answers = 0, searches = 0;
  t.mock.method(globalThis, 'fetch', async () => { answers++; return response(finished('普通回答')); });
  const app = await panel({ webSearchEnabled: true, searchImpl: async () => { searches++; throw new Error('联网搜索服务暂时不可用'); } });
  await app.send('请核实');
  const userId = app.state().conversation.messages[0].id;
  assert.equal(answers, 0);
  assert.equal(app.state().conversation.messages.at(-1).status, 'error');
  assert.match(app.element('notice').textContent, /联网搜索/);
  assert.equal(app.state().conversation.messages[0].webSearch.status, 'error');
  app.element('webSearch').checked = false;
  for (const handler of app.element('webSearch').listeners.change) await handler();
  const buttons = node => node.children.flatMap(child => typeof child === 'string' ? [] : child.tagName === 'button' ? [child] : buttons(child));
  const retry = buttons(app.element('messages')).find(button => button.textContent === '重新生成');
  assert.ok(retry, 'the failed answer exposes the actual retry action');
  await retry.click();
  assert.equal(answers, 1);
  assert.equal(searches, 1);
  assert.equal(app.state().conversation.messages.length, 2);
  assert.equal(app.state().conversation.messages[0].id, userId);
  assert.equal(app.state().conversation.messages[0].webSearch.enabled, false);
  assert.equal(app.saved.conversations[0].messages.at(-1).status, 'complete');
});

test('Stop during web search aborts search and sends no answer request', async t => {
  const started = deferred(); let answers = 0;
  t.mock.method(globalThis, 'fetch', async () => { answers++; return response(finished('不应发生')); });
  const app = await panel({ webSearchEnabled: true, searchImpl: ({signal}) => new Promise((resolve, reject) => {
    started.resolve(); signal.addEventListener('abort', () => reject(new DOMException('停止', 'AbortError')), {once:true});
  }) });
  const work = app.send('找最新信息');
  await Promise.race([started.promise, work]);
  await app.element('stopBtn').click(); await work;
  assert.equal(answers, 0);
  assert.equal(app.state().conversation.messages.at(-1).status, 'stopped');
  assert.equal(app.state().conversation.messages[0].webSearch.status, 'stopped');
  assert.equal(app.state().busy, false);
  assert.equal(app.element('webSearch').disabled, false);
  assert.equal(app.element('stopBtn').hidden, true);
  assert.equal(app.saved.conversations[0].messages[0].webSearch.status, 'stopped');
});

test('saved writing, reply and memory preferences survive restart and apply to a new conversation', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => { requests.push(JSON.parse(options.body)); return response(finished('遵循偏好')); });
  const app = await panel(); await app.element('settingsBtn').click();
  app.element('stylePrompt').value = '写作要从真实新闻切入';
  app.element('replyStylePrompt').value = '回复要先说结论再解释';
  app.element('memoryPrompt').value = '英文缩写首次出现翻译成中文';
  await app.saveSettings({preventDefault(){}});
  const resumed = await panel({stored:app.saved});
  await resumed.element('newChatBtn').click();
  await resumed.send('分析一下');
  for (const preference of ['写作要从真实新闻切入','回复要先说结论再解释','英文缩写首次出现翻译成中文']) assert.match(requests[0].messages[0].content, new RegExp(preference));
});

test('custom quick prompts persist, fill the draft without sending, reorder and can all be removed', async t => {
  let answers = 0;
  t.mock.method(globalThis, 'fetch', async () => { answers++; return response(finished('不应发生')); });
  const stored = {settings:{apiKey:'test-only-key',autoRead:false,webSearchEnabled:false,quickPrompts:[{id:'custom',label:'写观察',prompt:'按观察体写一篇完整评论'},{id:'second',label:'查证',prompt:'核实这篇的关键事实'}]}};
  const app = await panel({stored});
  await app.element('welcomeQuickPrompts').children[0].click();
  assert.equal(app.element('prompt').value, '按观察体写一篇完整评论'); assert.equal(answers, 0);
  await app.element('settingsBtn').click();
  // Controller exposes accessible labels through normal button text.
  const buttons = row => row.children.flatMap(child => child.children || []).filter(child => child.tagName === 'button');
  await buttons(app.element('quickPromptEditor').children[1]).find(button => button.textContent === '上移').click();
  await app.saveSettings({preventDefault(){}});
  assert.equal(app.saved.settings.quickPrompts[0].id, 'second');
  const resumed = await panel({stored:app.saved});
  assert.equal(resumed.element('followupQuickPrompts').children[0].textContent, '查证');
  await resumed.element('settingsBtn').click();
  while(resumed.element('quickPromptEditor').children.length) {
    const row = resumed.element('quickPromptEditor').children[0];
    await buttons(row).find(button => button.textContent === '删除').click();
  }
  await resumed.saveSettings({preventDefault(){}});
  const empty = await panel({stored:resumed.saved});
  assert.equal(empty.element('welcomeQuickPrompts').children.length,0);
});

test('editing and adding a quick prompt saves its label and full text across restart', async t => {
  let answers = 0;
  t.mock.method(globalThis, 'fetch', async () => { answers++; return response(finished('不应发送')); });
  const app = await panel(); await app.element('settingsBtn').click();
  const first = app.element('quickPromptEditor').children[0];
  first.querySelector('input').value = '我的归纳';
  first.querySelector('textarea').value = '先说明文章事实，再列出仍待验证的问题。';
  await app.element('addQuickPromptBtn').click();
  const added = app.element('quickPromptEditor').children.at(-1);
  added.querySelector('input').value = '自定义观察';
  added.querySelector('textarea').value = '从真实事件切入。\n把事实与个人判断分开，不虚构经历。';
  await app.saveSettings({ preventDefault() {} });
  assert.equal(app.saved.settings.quickPrompts.length, DEFAULT_QUICK_PROMPTS.length + 1);
  assert.equal(app.saved.settings.quickPrompts[0].label, '我的归纳');
  assert.equal(app.saved.settings.quickPrompts[0].prompt, '先说明文章事实，再列出仍待验证的问题。');
  const addedPrompt = app.saved.settings.quickPrompts.at(-1);
  assert.equal(addedPrompt.label, '自定义观察');
  assert.equal(addedPrompt.prompt, '从真实事件切入。\n把事实与个人判断分开，不虚构经历。');
  assert.ok(addedPrompt.id);
  const resumed = await panel({ stored: app.saved });
  assert.equal(resumed.element('followupQuickPrompts').children.at(-1).textContent, addedPrompt.label);
  await resumed.element('followupQuickPrompts').children.at(-1).click();
  assert.equal(resumed.element('prompt').value, addedPrompt.prompt);
  assert.equal(answers, 0);
  await resumed.element('settingsBtn').click();
  const restored = resumed.element('quickPromptEditor').children.at(-1);
  assert.equal(restored.querySelector('input').value, addedPrompt.label);
  assert.equal(restored.querySelector('textarea').value, addedPrompt.prompt);
});
