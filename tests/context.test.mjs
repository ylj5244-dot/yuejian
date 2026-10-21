import test from 'node:test';
import assert from 'node:assert/strict';
import * as context from '../lib/context.js';
const { buildRequest, exportMarkdown, DEFAULT_STYLE, DEFAULT_REPLY_STYLE, QUICK_PROMPTS } = context;

const source = (id, length = 20) => ({ id, title: `文章 ${id}`, url: `https://example.com/${id}`, text: id.repeat(length), capturedAt: '2026-10-18T00:00:00Z' });
const user = (content, sourceIds = []) => ({ role: 'user', content, sourceIds });
const assistant = content => ({ role: 'assistant', content });
const searchUser = (id, changes = {}) => ({ ...user(`问题 ${id}`), id, webSearch: {
  enabled: true, status: 'complete', queries: [`查询 ${id}`], searchedAt: '2026-10-18T12:00:00Z',
  results: [{ id: 'W1', title: `结果 ${id}`, url: `https://news.example/${id}`, text: `证据 ${id}`, coverage: 'summary', publishedAt: '2026-10-17', siteName: '示例新闻' }], ...changes,
} });
const searchMaterials = result => {
  const message = result.messages.find(message => message.content.startsWith('以下联网检索 JSON'));
  return message ? JSON.parse(message.content.slice(message.content.indexOf('{'))).searches : [];
};

test('writing, reply and memory preferences remain distinct, bounded and subordinate to the latest user request', () => {
  const request = buildRequest({ style: '写'.repeat(13000), replyStyle: '答'.repeat(9000), memory: '忆'.repeat(13000) });
  const system = request.messages[0].content;
  assert.equal(typeof DEFAULT_REPLY_STYLE, 'string');
  assert.match(DEFAULT_REPLY_STYLE, /通俗|清楚/);
  assert.match(system, /写作偏好：/);
  assert.match(system, /回复风格：/);
  assert.match(system, /长期记忆：/);
  assert.ok((system.match(/写/g) || []).length < 12020);
  assert.ok((system.match(/答/g) || []).length < 8020);
  assert.ok((system.match(/忆/g) || []).length < 12020);
  assert.match(system, /最新.*要求.*优先|当前.*要求.*优先/);
  assert.match(system, /网页.*检索.*不得.*偏好/);
  assert.equal(request.trimmed, true);
  const defaults = buildRequest().messages[0].content;
  assert.ok(defaults.includes(DEFAULT_STYLE));
  assert.ok(defaults.includes(DEFAULT_REPLY_STYLE));
});

test('completed search evidence binds repeated local IDs to distinct turns and states summary limitations', () => {
  const first = searchUser('first');
  const latest = searchUser('latest');
  const conversation = { messages: [first, assistant('先前分析'), latest] };
  const original = JSON.stringify(conversation);
  const request = buildRequest({ conversation });
  const system = request.messages[0].content;
  assert.match(system, /本轮.*联网检索已完成/);
  assert.doesNotMatch(system, /本次没有联网搜索工具/);
  assert.match(system, /证据.*不等于.*核实/);
  assert.match(system, /Markdown.*URL|URL.*Markdown/);
  assert.match(system, /冲突/);
  assert.match(system, /日期/);
  assert.match(system, /可靠性/);
  assert.match(system, /历史.*不能.*本轮/);
  const searches = searchMaterials(request);
  assert.deepEqual(searches.map(search => search.turnId), ['latest', 'first']);
  assert.deepEqual(searches.map(search => search.results[0].id), ['latest/W1', 'first/W1']);
  assert.equal(searches[0].results[0].coverage, 'summary');
  assert.match(searches[0].results[0].status, /摘要.*未.*全文/);
  assert.match(request.messages.at(-1).content, /latest\/W1/);
  assert.match(request.messages.find(message => message.content.endsWith('问题 first')).content, /first\/W1/);
  assert.equal(JSON.stringify(conversation), original);
});

test('current search status is precise and never substitutes a prior successful search', () => {
  for (const [status, enabled, pattern] of [
    ['complete', false, /本轮未开启联网检索/],
    ['empty', true, /本轮.*没有可用结果/],
    ['error', true, /本轮.*联网检索失败/],
    ['searching', true, /本轮.*仍在进行/],
    ['stopped', true, /本轮.*已停止/],
  ]) {
    const latest = searchUser('now', { status, enabled, results: [] });
    const request = buildRequest({ conversation: { messages: [searchUser('old'), assistant('旧回答'), latest] } });
    assert.match(request.messages[0].content, pattern);
    assert.doesNotMatch(request.messages[0].content, /本轮联网检索已完成/);
    assert.ok(searchMaterials(request).some(search => search.turnId === 'old'));
    assert.match(request.messages.at(-1).content, /联网检索/);
  }
});

test('latest three searched turns share a separate 60000-character budget without changing page budgets', () => {
  const sources = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => source(id, 120000));
  const messages = ['one', 'two', 'three', 'four'].flatMap(id => [
    searchUser(id, { results: [{ id: 'W1', title: id, url: `https://news.example/${id}`, text: id[0].repeat(50000), coverage: 'content' }] }), assistant('已分析'),
  ]);
  messages.at(-2).sourceIds = sources.map(item => item.id);
  const request = buildRequest({ conversation: { sources, messages } });
  const searches = searchMaterials(request);
  assert.deepEqual(searches.map(search => search.turnId), ['four', 'three', 'two']);
  assert.equal(searches.flatMap(search => search.results).reduce((sum, result) => sum + result.text.length, 0), 60000);
  assert.ok(searches.flatMap(search => search.results).every(result => result.truncated));
  assert.equal(materials(request).reduce((sum, page) => sum + page.text.length, 0), 240000);
  assert.equal(materials(request)[0].text.length, 120000);
  assert.match(request.messages.find(message => message.content.endsWith('问题 one')).content, /检索.*未包含|未包含.*检索/);
  assert.equal(request.trimmed, true);
});

test('disabled and unsafe search payloads cannot become usable search evidence or expose credential fields', () => {
  const latest = searchUser('safe', { apiKey: 'SECRET_SEARCH_KEY', error: 'SECRET_ERROR_KEY', results: [
    { id: 'W1', title: '错误来源', url: 'javascript:alert(1)', text: '恶意内容', coverage: 'content' },
  ] });
  const request = buildRequest({ conversation: { messages: [latest] } });
  const serialized = JSON.stringify(request.messages);
  assert.match(request.messages[0].content, /没有可用结果/);
  assert.ok(!serialized.includes('javascript:'));
  assert.ok(!serialized.includes('SECRET_SEARCH_KEY'));
  assert.ok(!serialized.includes('SECRET_ERROR_KEY'));
  const disabled = buildRequest({ conversation: { messages: [searchUser('disabled', { enabled: false })] } });
  assert.ok(!JSON.stringify(disabled.messages).includes('https://news.example/disabled'));
});

test('search URLs through 8192 characters retain completed status and their exact evidence URL', () => {
  for (const length of [3000, 8192]) {
    const prefix = 'https://news.example/report?token=';
    const url = prefix + 'a'.repeat(length - prefix.length);
    const latest = searchUser('long', { results: [{ id: 'W1', title: '长链接来源', url, text: '有效正文', coverage: 'content' }] });
    const request = buildRequest({ conversation: { messages: [latest] } });
    assert.match(request.messages[0].content, /本轮联网检索已完成/);
    assert.equal(searchMaterials(request)[0].results[0].url, url);
    assert.ok(exportMarkdown({ messages: [latest] }).includes(url));
  }
  const oversized = searchUser('oversized', { results: [{ id: 'W1', url: `https://news.example/${'a'.repeat(8192)}`, text: '过长地址' }] });
  assert.equal(searchMaterials(buildRequest({ conversation: { messages: [oversized] } }))[0].results.length, 0);
});

test('credential-bearing and control-character URLs are rejected instead of silently rewritten', () => {
  for (const url of ['https://name@news.example/private', 'https://:password@news.example/private', 'https://name:password@news.example/private', 'https://news.example/pri\nvate']) {
    const latest = searchUser('unsafe', { results: [{ id: 'W1', title: '无效来源', url, text: 'SHOULD_NOT_BECOME_EVIDENCE', coverage: 'content' }] });
    const request = buildRequest({ conversation: { messages: [latest] } });
    assert.match(request.messages[0].content, /没有可用结果/);
    assert.ok(!JSON.stringify(request.messages).includes('SHOULD_NOT_BECOME_EVIDENCE'));
    assert.ok(!exportMarkdown({ messages: [latest] }).includes('https://news.example/private'));
  }
});

test('Unicode URLs that expand beyond 8192 characters during normalization are rejected without truncation', () => {
  const url = `https://news.example/${'中'.repeat(1000)}`;
  assert.ok(url.length < 8192);
  assert.ok(new URL(url).href.length > 8192);
  const latest = searchUser('unicode', { results: [{ id: 'W1', url, text: 'OVERSIZED_NORMALIZED_SOURCE', coverage: 'content' }] });
  const request = buildRequest({ conversation: { messages: [latest] } });
  assert.match(request.messages[0].content, /没有可用结果/);
  assert.equal(searchMaterials(request)[0].results.length, 0);
  assert.ok(!JSON.stringify(request.messages).includes('OVERSIZED_NORMALIZED_SOURCE'));
  assert.ok(!exportMarkdown({ messages: [latest] }).includes('https://news.example/'));
});

test('archived search results preserve source links while explicitly withholding body and summary claims', () => {
  const archived = searchUser('old', { archived: true, results: [{ id: 'W1', title: '旧来源', url: 'https://news.example/old', text: '', coverage: 'content' }] });
  const request = buildRequest({ conversation: { messages: [archived, assistant('历史回答'), user('继续讨论')] } });
  const search = searchMaterials(request)[0];
  assert.equal(search.archived, true);
  assert.equal(search.results[0].text, '');
  assert.equal(search.results[0].url, 'https://news.example/old');
  assert.match(search.results[0].status, /仅.*来源信息/);
  assert.match(search.results[0].status, /未提供.*正文.*摘要/);
  assert.doesNotMatch(search.results[0].status, /已取得页面正文/);
  assert.match(request.messages.find(message => message.content.endsWith('问题 old')).content, /归档.*来源信息/);
  const exported = exportMarkdown({ messages: [archived] });
  assert.match(exported, /归档.*来源信息/);
  assert.doesNotMatch(exported, /已取得页面正文/);
});

test('empty unarchived search text is described as source metadata rather than available content', () => {
  const latest = searchUser('emptybody', { results: [{ id: 'W1', url: 'https://news.example/emptybody', text: '  ', coverage: 'summary' }] });
  const material = searchMaterials(buildRequest({ conversation: { messages: [latest] } }))[0].results[0];
  assert.match(material.status, /仅.*来源信息/);
  assert.match(material.status, /未提供.*正文.*摘要/);
});

test('export preserves each search time, query, source URL and coverage without API credentials', () => {
  const first = searchUser('first');
  first.webSearch.apiKey = 'SECRET_SEARCH_KEY';
  const second = searchUser('second', { results: [
    { id: 'W1', title: '来源正文', url: 'https://news.example/content', text: '片段', coverage: 'content', truncated: true },
  ] });
  const failed = searchUser('failed', { status: 'error', results: [], error: 'SECRET_ERROR_KEY' });
  const output = exportMarkdown({ messages: [first, assistant('回答'), second, assistant('继续'), failed] });
  assert.match(output, /2026-10-18T12:00:00/);
  assert.match(output, /查询 first/);
  assert.match(output, /https:\/\/news.example\/first/);
  assert.match(output, /摘要.*未.*全文/);
  assert.match(output, /https:\/\/news.example\/content/);
  assert.match(output, /正文.*截断|文字.*截断/);
  assert.match(output, /联网检索失败/);
  assert.ok(!output.includes('SECRET_SEARCH_KEY'));
  assert.ok(!output.includes('SECRET_ERROR_KEY'));
});

test('prompt establishes source-data boundary, style, no live search claims; reasoning/errors excluded', () => {
  const conversation = { sources: [source('a'), source('b')], messages: [
    user('请解释', ['a']), { ...assistant('这是解释'), reasoning: 'SECRET_REASONING' },
    { ...assistant('错误残留'), status: 'error' }, user('继续', []),
  ] };
  const result = buildRequest({ conversation, style: '冷静，不用套路。' });
  assert.match(result.messages[0].content, /网页|资料/);
  assert.match(result.messages[0].content, /不可信|不受信任/);
  assert.match(result.messages[0].content, /事实/);
  assert.match(result.messages[0].content, /搜索|联网/);
  assert.match(result.messages[0].content, /冷静，不用套路/);
  const serialized = JSON.stringify(result.messages);
  assert.ok(serialized.includes('https://example.com/a'));
  assert.ok(!serialized.includes('https://example.com/b'));
  assert.ok(!serialized.includes('SECRET_REASONING'));
  assert.ok(!serialized.includes('错误残留'));
  assert.ok(result.messages.at(-1).content.endsWith('继续'));
});

const materials = result => {
  const message = result.messages.find(message => message.content.startsWith('以下 JSON'));
  return message ? JSON.parse(message.content.slice(message.content.indexOf('{'))).sources : [];
};

test('full-page budgets preserve the newest page in full and retain portions of six recent sources', () => {
  const sources = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => source(id, 120000));
  const conversation = { sources, messages: sources.slice().reverse().flatMap(item => [user('解释这一页', [item.id]), assistant('解释')]) };
  const before = JSON.stringify(conversation);
  const result = buildRequest({ conversation });
  assert.equal(result.trimmed, true);
  const included = materials(result);
  assert.deepEqual(included.map(item => item.id), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(included[0].text.length, 120000);
  assert.equal(included.reduce((sum, item) => sum + item.text.length, 0), 240000);
  for (const item of included.slice(1)) {
    assert.ok(item.text.length > 0);
    assert.match(item.status, /截断/);
  }
  assert.doesNotMatch(included[0].status, /截断/);
  assert.equal(JSON.stringify(conversation), before);
});

test('six-source cap follows the latest attachment, including a revisited older snapshot', () => {
  const sources = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => source(id));
  const messages = sources.flatMap(item => [user(`解读 ${item.id}`, [item.id]), assistant(`回答 ${item.id}`)]);
  messages.push(user('回到之前那一页', ['b']));
  const result = buildRequest({ conversation: { sources, messages } });
  assert.deepEqual(materials(result).map(item => item.id), ['b', 'g', 'f', 'e', 'd', 'c']);
  assert.equal(result.trimmed, true);
  const omitted = result.messages.find(message => message.content.endsWith('解读 a'));
  assert.match(omitted.content, /a.*未包含|未包含.*a/);
});

test('mixed available, truncated and archived attachments retain their exact provenance', () => {
  const sources = [source('a'), { ...source('b'), text: '', archived: true }, { ...source('c'), truncated: true }];
  const result = buildRequest({ conversation: { sources, messages: [user('比较这些资料', ['a', 'b', 'c', 'missing'])] } });
  const latest = result.messages.at(-1).content;
  assert.match(latest, /a.*文章 a/);
  assert.match(latest, /c.*文章 c.*截断/);
  assert.match(latest, /b.*missing.*未包含|未包含.*b.*missing/);
  assert.ok(!materials(result).some(item => item.id === 'b'));
  assert.equal(result.trimmed, true);
});

for (const [name, metadata] of [
  ['explicit partial flag', { partial: true }],
  ['visible-block fallback method', { method: 'visible-blocks' }],
  ['extraction warnings', { warnings: ['部分内容未能读取'] }],
]) {
  test(`${name} marks source material and its historical attachment as only partial visible text`, () => {
    const conversation = { sources: [{ ...source('a'), ...metadata }], messages: [
      user('请总结全文', ['a']), assistant('已收到部分资料'), user('继续说'),
    ] };
    const original = JSON.stringify(conversation);
    const request = buildRequest({ conversation });
    const material = materials(request)[0];
    assert.equal(material.partial, true);
    assert.equal(material.truncated, false);
    assert.match(material.status, /部分可见文字/);
    assert.match(material.status, /不能.*全文|非全文/);
    const attachment = request.messages.find(message => message.content.endsWith('请总结全文'));
    assert.match(attachment.content, /部分可见文字/);
    assert.match(attachment.content, /非全文|不是全文/);
    assert.match(request.messages[0].content, /部分可见文字.*不能.*全文/);
    assert.equal(JSON.stringify(conversation), original);
    assert.equal(request.trimmed, false, 'partial capture is separate from context length trimming');
  });
}

test('partial source status retains truncation independently and ordinary empty warnings remain complete', () => {
  const request = buildRequest({ conversation: { sources: [
    { ...source('a'), method: 'visible-blocks', partial: true, warnings: ['未能读取全部区块'], truncated: true },
    { ...source('b'), method: 'page', partial: false, warnings: [] },
  ], messages: [user('比较这两页', ['a', 'b'])] } });
  const [partial, ordinary] = materials(request);
  assert.equal(partial.partial, true);
  assert.equal(partial.truncated, true);
  assert.match(partial.status, /部分可见文字/);
  assert.match(partial.status, /截断/);
  assert.equal(partial.method, 'visible-blocks');
  assert.deepEqual(partial.warnings, ['未能读取全部区块']);
  assert.equal(ordinary.partial, false);
  assert.doesNotMatch(ordinary.status, /部分|截断/);
  assert.match(request.messages.at(-1).content, /a.*部分可见文字.*截断/);
});

test('unavailable current-page marker does not confuse an earlier page with the current tab', () => {
  const result = buildRequest({ conversation: { sources: [source('a')], messages: [
    user('先分析这一页', ['a']), assistant('分析'),
    { ...user('当前页面讲了什么？'), pageContextStatus: 'unavailable' },
  ] } });
  assert.deepEqual(materials(result).map(item => item.id), ['a']);
  assert.match(result.messages.at(-1).content, /当前网页.*未能读取|未能读取.*当前网页/);
  assert.match(result.messages.at(-1).content, /不要.*此前.*当前/);
  const optOut = buildRequest({ conversation: { sources: [source('a')], messages: [
    user('先分析这一页', ['a']), assistant('分析'), user('请继续刚才的分析'),
  ] } });
  assert.doesNotMatch(optOut.messages.at(-1).content, /未能读取/);
});

test('trimmed conversation retains recent complete turns and original article references', () => {
  const messages = [user('最早问题'.repeat(7000), ['a']), assistant('最早回答'.repeat(7000)),
    user('近期问题'), assistant('近期回答'), user('现在追问')];
  const result = buildRequest({ conversation: { sources: [source('a')], messages } });
  assert.equal(result.trimmed, true);
  const serialized = JSON.stringify(result.messages);
  assert.ok(serialized.includes('https://example.com/a'));
  assert.ok(!serialized.includes('最早回答'));
  const tail = result.messages.slice(-3);
  assert.deepEqual(tail.map(m => m.role), ['user', 'assistant', 'user']);
  assert.ok(tail[0].content.endsWith('近期问题'));
  assert.equal(tail[1].content, '近期回答');
  assert.ok(tail[2].content.endsWith('现在追问'));
});

test('a very long newest user message cannot exceed the history budget', () => {
  const result = buildRequest({ conversation: { sources: [], messages: [user('旧问题'), assistant('旧回答'), user('新'.repeat(100000))] } });
  assert.equal(result.trimmed, true);
  const history = result.messages.filter(m => m.role !== 'system');
  assert.ok(history.reduce((sum, m) => sum + m.content.length, 0) <= 40000);
  assert.equal(history.at(-1).role, 'user');
  assert.match(history.at(-1).content, /截断/);
});

test('empty attachment arrays avoid accidental page transmission; old untagged data is supported', () => {
  const modern = buildRequest({ conversation: { sources: [source('a')], messages: [user('纯聊天')] } });
  assert.ok(!JSON.stringify(modern.messages).includes('https://example.com/a'));
  const legacy = buildRequest({ conversation: { sources: [source('a')], messages: [{ role: 'user', content: '解读' }] } });
  assert.ok(JSON.stringify(legacy.messages).includes('https://example.com/a'));
});

test('export contains entire conversation and source URLs without settings or reasoning', () => {
  const conversation = { title: '光通信讨论', createdAt: '2026-10-18T00:00:00Z', apiKey: 'SECRET_API_KEY', sources: [source('a')], messages: [user('梳理文章', ['a']), { ...assistant('我的分析'), reasoning: 'HIDDEN_REASONING' }, user('按我的风格写')] };
  const output = exportMarkdown(conversation);
  assert.match(output, /光通信讨论/);
  assert.match(output, /https:\/\/example.com\/a/);
  assert.match(output, /梳理文章/);
  assert.match(output, /我的分析/);
  assert.match(output, /按我的风格写/);
  assert.ok(!output.includes('SECRET_API_KEY'));
  assert.ok(!output.includes('HIDDEN_REASONING'));
  assert.ok(DEFAULT_STYLE.includes('事实'));
  for (const key of ['summarize', 'analyze', 'write']) assert.equal(typeof QUICK_PROMPTS[key], 'string');
});

test('export formats numeric and string timestamps and omits invalid dates', () => {
  const date = '2026-10-18T00:00:00.000Z';
  assert.match(exportMarkdown({ createdAt: Date.parse(date) }), /创建时间：2026-10-18T00:00:00\.000Z/);
  assert.match(exportMarkdown({ createdAt: '2026-10-18T08:00:00+08:00' }), /创建时间：2026-10-18T00:00:00\.000Z/);
  assert.match(exportMarkdown({ createdAt: 0 }), /创建时间：1970-01-01T00:00:00\.000Z/);
  for (const createdAt of [NaN, Infinity, 'not a date', '', null, undefined, {}]) {
    assert.ok(!exportMarkdown({ createdAt }).includes('创建时间：'));
  }
});

test('partial stopped and interrupted replies are identified in history and export', () => {
  const conversation = { sources: [], messages: [
    user('开始'), { ...assistant('第一段未写完'), status: 'stopped' },
    user('继续'), { ...assistant('第二段未写完'), status: 'interrupted' }, user('接着说'),
  ] };
  const original = JSON.stringify(conversation);
  const request = buildRequest({ conversation });
  const responses = request.messages.filter(message => message.role === 'assistant');
  assert.match(responses[0].content, /停止.*不完整/);
  assert.match(responses[0].content, /第一段未写完/);
  assert.match(responses[1].content, /中断.*不完整/);
  assert.match(responses[1].content, /第二段未写完/);
  const exported = exportMarkdown(conversation);
  assert.match(exported, /DeepSeek（已停止，内容不完整）/);
  assert.match(exported, /DeepSeek（已中断，内容不完整）/);
  assert.equal(JSON.stringify(conversation), original);
});

test('each user turn preserves article bindings and a followup does not attach a newly browsed article', () => {
  const conversation = { sources: [source('a'), source('b'), source('c')], messages: [
    user('先梳理这篇', ['a']), assistant('第一篇的总结'),
    user('再分析这篇', ['b']), assistant('第二篇的分析'),
    user('比较一下刚才两篇', []),
  ] };
  const request = buildRequest({ conversation });
  const first = request.messages.find(message => message.content.endsWith('先梳理这篇'));
  const second = request.messages.find(message => message.content.endsWith('再分析这篇'));
  assert.match(first.content, /资料.*a.*文章 a/);
  assert.ok(!first.content.includes('文章 b'));
  assert.match(second.content, /资料.*b.*文章 b/);
  assert.ok(!second.content.includes('文章 a'));
  assert.match(request.messages.at(-1).content, /未新增.*网页|未附加.*网页/);
  const serialized = JSON.stringify(request.messages);
  assert.ok(serialized.includes('https://example.com/a'));
  assert.ok(serialized.includes('https://example.com/b'));
  assert.ok(!serialized.includes('https://example.com/c'));
});
