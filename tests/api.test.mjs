import test from 'node:test';
import assert from 'node:assert/strict';
import { streamChat } from '../lib/api.js';

const encoder = new TextEncoder();
const defaults = { apiKey: 'test-only-key', model: 'deepseek-flash', thinking: false, messages: [{ role: 'user', content: '你好' }] };
function responseFrom(text, byteStep = 7) {
  const bytes = encoder.encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += byteStep) controller.enqueue(bytes.slice(i, i + byteStep));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}
const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;

test('SSE handles every UTF-8 byte split, keep-alive, reasoning and final usage', async () => {
  const originalFetch = globalThis.fetch;
  const deltas = [];
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return responseFrom(': keep-alive\r\n\r\n' +
      event({ choices: [{ delta: { reasoning_content: '思考中' }, finish_reason: null }] }) +
      event({ choices: [{ delta: { content: '你好，世界。' }, finish_reason: null }] }) +
      event({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 20 } }) +
      'data: [DONE]\r\n\r\n', 1);
  };
  try {
    const result = await streamChat({ ...defaults, thinking: true, onDelta: delta => deltas.push(delta) });
    assert.equal(result.content, '你好，世界。');
    assert.equal(result.reasoning, '思考中');
    assert.deepEqual(result.usage, { total_tokens: 20 });
    assert.equal(result.finishReason, 'stop');
    assert.equal(deltas.map(d => d.content).join(''), result.content);
    assert.equal(deltas.map(d => d.reasoning).join(''), result.reasoning);
    assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(request.options.headers.Authorization, 'Bearer test-only-key');
    assert.equal(request.body.max_tokens, 16384);
    assert.deepEqual(request.body.thinking, { type: 'enabled' });
    assert.equal(request.body.reasoning_effort, 'high');
    assert.equal(request.body.stream, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('normal mode has explicit disabled thinking and appropriate output cap', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.max_tokens, 8192);
    assert.equal(body.reasoning_effort, undefined);
    return responseFrom(event({ choices: [{ delta: { content: '完成' }, finish_reason: 'stop' }] }));
  };
  try { assert.equal((await streamChat(defaults)).content, '完成'); }
  finally { globalThis.fetch = originalFetch; }
});

test('HTTP auth and balance failures provide Chinese actionable errors without key leakage', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [status, expected] of [[401, /密钥|Key/], [402, /余额/], [429, /频繁|限流|上限/], [503, /繁忙/]]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'test-only-key upstream detail' } }), { status });
      await assert.rejects(streamChat(defaults), error => expected.test(error.message) && !error.message.includes('test-only-key'));
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('abrupt EOF throws after forwarding partial content; unfinished JSON is not success', async () => {
  const originalFetch = globalThis.fetch;
  let partial = '';
  globalThis.fetch = async () => responseFrom(event({ choices: [{ delta: { content: '已有片段' } }] }) + 'data: {"choices":');
  try {
    await assert.rejects(streamChat({ ...defaults, onDelta: d => { partial += d.content; } }), /中断|完整|结束/);
    assert.equal(partial, '已有片段');
  } finally { globalThis.fetch = originalFetch; }
});

test('malformed SSE event throws rather than silently losing generated text', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => responseFrom('data: not-json\n\ndata: [DONE]\n\n');
  try { await assert.rejects(streamChat(defaults), /格式|解析/); }
  finally { globalThis.fetch = originalFetch; }
});

test('cancellation aborts an active reader and preserves already emitted text', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let partial = '';
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(streamController) { streamController.enqueue(encoder.encode(event({ choices: [{ delta: { content: '部分' } }] }) + event({ choices: [{ delta: { content: '取消后不应出现' } }] }))); },
    cancel() { cancelled = true; },
  }));
  try {
    await assert.rejects(streamChat({ ...defaults, signal: controller.signal, onDelta: d => { partial += d.content; controller.abort(); } }), { name: 'AbortError' });
    assert.equal(partial, '部分');
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('server stream read failure is an error after already emitted partial output', async () => {
  const originalFetch = globalThis.fetch;
  let reads = 0;
  let partial = '';
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(encoder.encode(event({ choices: [{ delta: { content: '已收到' } }] })));
      else controller.error(new Error('mock disconnected'));
    },
  }));
  try {
    await assert.rejects(streamChat({ ...defaults, onDelta: d => { partial += d.content; } }), /中断/);
    assert.equal(partial, '已收到');
  } finally { globalThis.fetch = originalFetch; }
});

test('DONE ends a response even without finish_reason or a trailing newline', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => responseFrom(event({ choices: [{ delta: { content: '完成' } }] }) + 'data: [DONE]', 2);
  try { assert.equal((await streamChat(defaults)).content, '完成'); }
  finally { globalThis.fetch = originalFetch; }
});

test('blank keys and missing messages fail before networking', async () => {
  await assert.rejects(streamChat({ ...defaults, apiKey: '  ' }), /密钥|Key/);
  await assert.rejects(streamChat({ ...defaults, messages: [] }), /消息|内容/);
});
