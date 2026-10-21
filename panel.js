import { streamChat } from './lib/api.js';
import { buildRequest, DEFAULT_STYLE, exportMarkdown } from './lib/context.js';
import { DEFAULT_SETTINGS, DEFAULT_QUICK_PROMPTS, normalizeSettings, validatePreferences } from './lib/preferences.js';
import { searchWeb } from './lib/search.js';
import { extractPage } from './lib/extract.js';
import { extractVisibleBlocks } from './lib/fallback.js';
import { renderMarkdown } from './lib/markdown.js';

const $ = (id) => document.getElementById(id);
const defaults = DEFAULT_SETTINGS;
let settings = { ...defaults };
let conversations = [];
let activeId = '';
let page = null;
let tabInfo = null;
let windowId;
let readVersion = 0;
let targetVersion = 0;
let reading = false;
let busy = false;
let sending = false;
let contextMode = 'auto';
let pollTimer;
let controller = null;
let persistTimer;
let saveQueue = Promise.resolve();
let lastReadReport = null;
let quickPromptRows = [];
const readFailureMessages = {
  ACCESS_RESTRICTED: '页面显示订阅访问限制，请先在网站上正常登录或开通阅读权限。',
  UNSUPPORTED_PAGE: '此页面不能读取，可粘贴文字后继续聊。',
  WAIT_FOR_CONTENT: '网页还没有加载正文，加载后会自动重读。',
  NO_VISIBLE_TEXT: '两种读取方式都没有找到可见文字。打开设置中的“读取诊断”可查看具体结果。',
  EXTRACTION_FAILED: '网页读取脚本执行异常。打开设置中的“读取诊断”可查看具体结果。',
  NO_RESULT: 'Chrome 没有返回网页读取结果。打开设置中的“读取诊断”可查看具体结果。',
  PERMISSION_DENIED: '网站访问权限未开启。请在 Chrome 的阅见扩展详情中，将网站访问权限设为“在所有网站上”。',
  INJECTION_FAILED: 'Chrome 未能执行网页读取。打开设置中的“读取诊断”可查看具体结果。',
};
const uid = () => crypto.randomUUID();
const current = () => conversations.find((c) => c.id === activeId);
const notice = (message = '', error = false) => {
  $('notice').textContent = message;
  $('notice').hidden = !message;
  $('notice').classList.toggle('error', error);
};
function persist() {
  const snapshot = JSON.parse(JSON.stringify({ conversations, activeId }));
  saveQueue = saveQueue.catch(() => {}).then(() => chrome.storage.local.set(snapshot));
  saveQueue.catch(() => notice('本机存储空间不足或保存失败。请导出重要对话后，删除不需要的历史。', true));
  return saveQueue;
}
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persist(); }, 750);
}
function newConversation() {
  if (busy || sending) return;
  if (conversations.length >= 40) {
    notice('已经有 40 个对话。请先导出或删除一个历史对话，再新建。', true);
    renderHistory(); $('historyDialog').showModal(); return;
  }
  const item = { id: uid(), title: '新的对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [], sources: [] };
  conversations.unshift(item); activeId = item.id;
  $('prompt').value = ''; renderConversation(); persist();
}
function renderPageStatus(message, state = 'ready') {
  if (!message && page) {
    const label = page.method === 'paste' ? '已使用粘贴内容' : page.method === 'visible-blocks' ? '兼容读取' : '已读取';
    message = `${label}：${page.title} · ${page.text.length.toLocaleString()} 字符${page.partial ? ' · 部分内容' : ''}${page.truncated ? ' · 内容过长，已截断' : ''}`;
  }
  $('pageStatus').textContent = message || '尚未读取当前页';
  $('pageStatus').title = message || '';
  $('pageContext').dataset.state = state;
}
async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, windowId });
  return tabs[0];
}
function siteTarget(tab) {
  if (!tab?.id || !tab.url) return null;
  try {
    const url = new URL(tab.url);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.hostname === 'chromewebstore.google.com' || (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'))) return null;
    return { tabId: tab.id, url: url.href };
  } catch { return null; }
}
async function refreshSiteTarget() {
  const version = readVersion;
  const metadataVersion = ++targetVersion;
  try {
    const tab = await activeTab();
    if (version !== readVersion || metadataVersion !== targetVersion) return;
    tabInfo = tab;
    if (!page && !reading) renderPageStatus(siteTarget(tab) ? '自动读取已关闭；发送时会读取当前页。' : '此页面不能读取，可粘贴文字后继续聊。', 'disabled');
  } catch {
    if (version === readVersion && metadataVersion === targetVersion && !reading) renderPageStatus('未找到当前网页，请打开普通网页。', 'error');
  }
}
async function readCurrent({ silent = false } = {}) {
  const version = ++readVersion;
  const report = { version: chrome.runtime.getManifest?.().version || '1.2.0', at: new Date().toISOString(), site: '', attempts: [] };
  const saveReport = () => { if (version === readVersion) { lastReadReport = report; $('readDiagnostics').textContent = JSON.stringify(report, null, 2); } };
  const record = (method, value, code) => {
    const detail = value?.diagnostics;
    const attempt = { method, code, characters: typeof value?.text === 'string' ? value.text.length : 0 };
    if (['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
      'SecurityError', 'NotAllowedError', 'NotFoundError', 'InvalidStateError', 'IndexSizeError', 'InvalidAccessError',
      'NotSupportedError', 'AbortError', 'UnknownError'].includes(value?.error?.type)) attempt.errorType = value.error.type;
    if (['loading', 'interactive', 'complete'].includes(detail?.readyState)) attempt.readyState = detail.readyState;
    if (typeof detail?.bodyPresent === 'boolean') attempt.bodyPresent = detail.bodyPresent;
    for (const key of ['frameCount', 'skippedSubtrees']) if (Number.isInteger(detail?.[key]) && detail[key] >= 0) attempt[key] = detail[key];
    report.attempts.push(attempt); saveReport();
  };
  const resultCode = (value) => {
    if (value?.ok !== false && typeof value?.text === 'string' && value.text.trim()) return 'OK';
    return Object.hasOwn(readFailureMessages, value?.error?.code) ? value.error.code : value ? 'EXTRACTION_FAILED' : 'NO_RESULT';
  };
  const fail = code => { const error = new Error(readFailureMessages[code]); error.code = code; throw error; };
  reading = true;
  if (!silent) { page = null; renderPageStatus('正在读取当前网页…', 'loading'); }
  try {
    const tab = await activeTab();
    if (version !== readVersion) return null;
    tabInfo = tab;
    if (!siteTarget(tab)) { record('target', null, 'UNSUPPORTED_PAGE'); fail('UNSUPPORTED_PAGE'); }
    report.site = new URL(tab.url).hostname;
    const isCurrent = async () => {
      if (version !== readVersion) return false;
      const stillActive = await activeTab();
      if (version !== readVersion) return false;
      if (stillActive?.id === tab.id && stillActive?.url === tab.url) return true;
      page = null; renderPageStatus('网页已切换，正在等待新页面。', 'loading'); return false;
    };
    const runReader = async (func, method) => {
      try {
        const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args: [{ maxChars: 120000, captureErrors: true }] });
        const value = results?.[0]?.result;
        const code = resultCode(value); record(method, value, code);
        return { value, code };
      } catch (error) {
        const code = /Cannot access|permission|host permission|Extension manifest/i.test(error.message) ? 'PERMISSION_DENIED' : 'INJECTION_FAILED';
        record(method, null, code); fail(code);
      }
    };
    let outcome = await runReader(extractPage, 'page');
    if (!(await isCurrent())) return null;
    // Only content-extraction failures use the independent reader. Browser
    // permissions and website access restrictions are not fallback conditions.
    if (['NO_RESULT', 'NO_VISIBLE_TEXT', 'EXTRACTION_FAILED'].includes(outcome.code)) {
      outcome = await runReader(extractVisibleBlocks, 'visible-blocks');
      if (!(await isCurrent())) return null;
    }
    if (outcome.code !== 'OK') fail(outcome.code);
    const captured = outcome.value;
    page = { ...captured, partial: Boolean(captured.partial || captured.method === 'visible-blocks' || captured.warnings?.length), id: uid(), tabId: tab.id };
    renderPageStatus();
    return page;
  } catch (error) {
    if (version !== readVersion) return null;
    page = null;
    if (!error.code) record('controller', null, 'INJECTION_FAILED');
    renderPageStatus(error.code ? error.message : readFailureMessages.INJECTION_FAILED, 'error');
    return null;
  } finally {
    if (version === readVersion) reading = false;
  }
}
function invalidatePage() {
  ++readVersion; ++targetVersion; reading = false; page = null; tabInfo = null; contextMode = 'auto';
  renderPageStatus(settings.autoRead ? '正在切换网页…' : '自动读取已关闭；发送时会读取当前页。', settings.autoRead ? 'loading' : 'disabled');
}
async function onPageChanged() {
  invalidatePage();
  if (settings.autoRead && !document.hidden) await readCurrent();
  else await refreshSiteTarget();
}
async function pollCurrentPage() {
  if (!settings.autoRead || document.hidden || reading || busy || sending || contextMode === 'paste') return;
  await readCurrent({ silent: true });
}
function archiveOldSources(conversation) {
  const recent = new Set();
  for (const message of [...conversation.messages].reverse()) {
    for (const id of message.sourceIds || []) if (recent.size < 6) recent.add(id);
  }
  for (const source of conversation.sources) {
    if (source.text && !recent.has(source.id)) { source.text = ''; source.archived = true; }
  }
  let searches = 0;
  for (const message of [...conversation.messages].reverse()) {
    if (!message.webSearch?.results?.length) continue;
    if (++searches > 3) {
      for (const result of message.webSearch.results) result.text = '';
      message.webSearch.archived = true;
    }
  }
}
function safeSourceLink(source) {
  const label = document.createElement('span');
  label.textContent = source.title;
  try {
    const url = new URL(source.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return label;
    const a = document.createElement('a'); a.textContent = source.title; a.href = url.href; a.target = '_blank'; a.rel = 'noreferrer noopener'; return a;
  } catch { return label; }
}
function messageNode(message, conversation) {
  const article = document.createElement('article');
  article.className = `message ${message.role}`; article.dataset.id = message.id;
  const meta = document.createElement('div'); meta.className = 'message-meta';
  meta.textContent = message.role === 'user' ? '你' : '阅见 · DeepSeek'; article.append(meta);
  if (message.reasoning) {
    const detail = document.createElement('details'); detail.className = 'reasoning';
    const summary = document.createElement('summary'); summary.textContent = message.status === 'streaming' ? '正在思考…' : '思考过程';
    const thought = document.createElement('div'); thought.textContent = message.reasoning; detail.append(summary, thought); article.append(detail);
  }
  const body = document.createElement('div'); body.className = 'message-body';
  if (message.role === 'assistant') body.innerHTML = renderMarkdown(message.content || (message.status === 'streaming' ? message.progress || '正在等待 DeepSeek…' : '未收到回复。'));
  else body.textContent = message.content;
  article.append(body);
  if (message.sourceIds?.length) {
    const refs = document.createElement('div'); refs.className = 'message-sources'; refs.append('附带：');
    for (const id of message.sourceIds) { const source = conversation.sources.find((s) => s.id === id); if (source) refs.append(safeSourceLink(source), ' '); }
    article.append(refs);
  }
  if (message.webSearch?.enabled) {
    const search = message.webSearch;
    const details = document.createElement('details'); details.className = 'search-sources';
    const summary = document.createElement('summary');
    const labels = { searching: '正在联网搜索…', empty: '联网搜索完成 · 暂无可用结果', error: '联网搜索未完成', stopped: '联网搜索已停止' };
    summary.textContent = search.status === 'complete' ? `联网来源 · ${search.results?.length || 0} 条${search.archived ? ' · 旧正文已释放' : ''}` : labels[search.status] || '联网搜索记录';
    details.append(summary);
    const query = document.createElement('p');
    query.textContent = [search.searchedAt ? `检索时间：${search.searchedAt}` : '', search.queries?.length ? `检索词：${search.queries.join('；')}` : ''].filter(Boolean).join('\n');
    details.append(query);
    const list = document.createElement('ol'); list.className = 'search-source-list';
    for (const source of search.results || []) {
      const item = document.createElement('li'); item.append(safeSourceLink(source));
      const scope = document.createElement('small');
      scope.textContent = ` ${source.coverage === 'content' ? '含正文材料' : '仅摘要'}${source.truncated ? ' · 已截断' : ''}${source.publishedAt ? ` · ${source.publishedAt}` : ''}`;
      item.append(scope); list.append(item);
    }
    details.append(list); article.append(details);
  }
  if (message.status && !['complete', 'streaming'].includes(message.status)) {
    const state = document.createElement('div'); state.className = 'message-state';
    state.textContent = message.error || ({ stopped: '已停止，保留已收到的内容。', interrupted: '上次生成未完成，已保留收到的内容。' }[message.status] || '生成未完成。'); article.append(state);
  }
  if (message.role === 'assistant' && message.status !== 'streaming') {
    const actions = document.createElement('div'); actions.className = 'message-actions';
    const copy = document.createElement('button'); copy.textContent = '复制'; copy.type = 'button'; copy.disabled = !message.content;
    copy.addEventListener('click', () => navigator.clipboard.writeText(message.content).then(() => notice('已复制回复。')).catch(() => notice('复制失败，请选中文字后复制。', true)));
    actions.append(copy);
    if (message === conversation.messages.at(-1) && message.status !== 'complete') {
      const retry = document.createElement('button'); retry.textContent = '重新生成'; retry.type = 'button'; retry.disabled = busy || sending;
      retry.addEventListener('click', () => { if (busy || sending) return; conversation.messages.pop(); return runRequest(conversation); }); actions.append(retry);
    }
    article.append(actions);
  }
  return article;
}
function renderConversation() {
  const conversation = current();
  $('conversationTitle').textContent = conversation?.title || '新的对话';
  const list = $('messages'); const welcome = $('welcome');
  welcome.remove(); list.replaceChildren(); list.append(welcome);
  welcome.hidden = !!conversation?.messages.length;
  for (const message of conversation?.messages || []) list.append(messageNode(message, conversation));
  list.scrollTop = list.scrollHeight;
  $('exportBtn').disabled = !conversation?.messages.length || busy;
}
function updateStreamingMessage(message, conversation) {
  const list = $('messages');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
  const prior = list.querySelector(`[data-id="${message.id}"]`);
  const reasoningOpen = prior?.querySelector('details')?.open;
  const next = messageNode(message, conversation);
  if (reasoningOpen && next.querySelector('details')) next.querySelector('details').open = true;
  prior?.replaceWith(next);
  if (nearBottom) list.scrollTop = list.scrollHeight;
}
function setBusy(value) {
  busy = value;
  $('sendBtn').hidden = value; $('stopBtn').hidden = !value;
  for (const id of ['newChatBtn', 'historyBtn', 'settingsBtn', 'exportBtn']) $(id).disabled = value;
  $('thinking').disabled = value; $('webSearch').disabled = value;
}
async function runRequest(conversation) {
  if (busy) return;
  const userMessage = [...conversation.messages].reverse().find(message => message.role === 'user');
  if (!userMessage) return;
  const preferences = { ...settings };
  setBusy(true); notice(); controller = new AbortController();
  const assistant = { id: uid(), role: 'assistant', content: '', reasoning: '', status: 'streaming' };
  userMessage.webSearch = { enabled: preferences.webSearchEnabled, status: preferences.webSearchEnabled ? 'searching' : 'disabled', queries: [], results: [] };
  assistant.progress = preferences.webSearchEnabled ? '正在整理检索词…' : '正在等待 DeepSeek…';
  conversation.messages.push(assistant); renderConversation();
  let lastPaint = 0;
  try {
    await persist();
    if (preferences.webSearchEnabled) {
      const attached = (userMessage.sourceIds || []).map(id => conversation.sources.find(source => source.id === id)).filter(Boolean);
      const priorQuestion = conversation.messages.slice(0, conversation.messages.indexOf(userMessage)).reverse().find(message => message.role === 'user');
      const search = await searchWeb({
        apiKey: preferences.apiKey, model: preferences.model, prompt: userMessage.content,
        contextTitle: attached[0]?.title || '', contextText: attached[0]?.text || '', previousQuestion: priorQuestion?.content || '', signal: controller.signal,
        onStatus(message) { assistant.progress = message; updateStreamingMessage(assistant, conversation); },
      });
      if (controller.signal.aborted) throw new DOMException('已停止联网搜索。', 'AbortError');
      userMessage.webSearch = { ...search, enabled: true };
      archiveOldSources(conversation);
      assistant.progress = search.status === 'empty' ? '未找到可用搜索结果，正在说明资料范围…' : '正在依据搜索来源整理回答…';
      renderConversation(); await persist();
    }
    const request = buildRequest({ conversation, style: preferences.style, replyStyle: preferences.replyStyle, memory: preferences.memory });
    if (request.trimmed) notice('内容较长，本次请求已缩短较早的对话或来源；聊天记录仍保存在本机，较早的网页和搜索正文可能已释放。');
    const result = await streamChat({
      apiKey: preferences.apiKey, model: preferences.model, thinking: $('thinking').checked,
      messages: request.messages, signal: controller.signal,
      onDelta(delta) {
        assistant.content += delta.content || ''; assistant.reasoning += delta.reasoning || '';
        if (Date.now() - lastPaint > 100) { updateStreamingMessage(assistant, conversation); lastPaint = Date.now(); }
        schedulePersist();
      }
    });
    assistant.content = result.content; assistant.reasoning = result.reasoning || '';
    assistant.status = result.finishReason === 'length' ? 'interrupted' : 'complete';
    if (result.finishReason === 'length') assistant.error = '已达到本次输出上限。可以发送“请从刚才结尾继续”。';
    if (!assistant.content) { assistant.status = 'interrupted'; assistant.error = '没有收到正文，可以关闭深度思考后重试。'; }
  } catch (error) {
    assistant.status = controller.signal.aborted ? 'stopped' : 'error';
    if (userMessage.webSearch.status === 'searching') {
      userMessage.webSearch.status = assistant.status === 'stopped' ? 'stopped' : 'error';
      assistant.error = assistant.status === 'stopped' ? '联网搜索已停止，未发起回答请求。' : `${error.message || '联网搜索失败。'} 本次未生成回答；可重试，或关闭“联网核实”后继续提问。`;
    }
    if (assistant.status === 'error') { assistant.error ||= error.message || '请求失败，请稍后重试。'; notice(assistant.error, true); }
  } finally {
    clearTimeout(persistTimer); persistTimer = null;
    conversation.updatedAt = Date.now(); setBusy(false); controller = null; renderConversation();
    await persist().catch(() => {});
  }
}
async function submit(event) {
  event?.preventDefault();
  if (busy || sending) return;
  const content = $('prompt').value.trim();
  if (!content) { $('prompt').focus(); return; }
  if (content.length > 30000) { notice('这条消息超过 30,000 字符，请缩短后发送；长文可放入粘贴框。', true); return; }
  if (!settings.apiKey.trim()) { openSettings(); notice('请先填写你自己的 DeepSeek API Key。'); return; }
  if (!current()) newConversation();
  const conversation = current(); if (!conversation) return;
  sending = true;
  renderConversation();
  for (const id of ['sendBtn', 'newChatBtn', 'historyBtn', 'settingsBtn', 'refreshPageBtn', 'pasteBtn', 'webSearch']) $(id).disabled = true;
  try {
    // Re-read at send time so dynamic content never silently uses an old snapshot.
    const captured = settings.usePageContext ? (contextMode === 'paste' ? page : await readCurrent({ silent: true })) : null;
    const sourceIds = [];
    if (captured) {
      // Equal text can come from captures with different coverage. Preserve
      // those distinctions without changing the earlier source snapshot.
      let source = conversation.sources.find((s) => s.url === captured.url && s.text === captured.text
        && s.method === captured.method && Boolean(s.partial) === Boolean(captured.partial)
        && Boolean(s.truncated) === Boolean(captured.truncated));
      if (!source) {
        source = { ...captured }; delete source.tabId; conversation.sources.push(source);
      }
      sourceIds.push(source.id);
    }
    const message = { id: uid(), role: 'user', content, sourceIds, status: 'complete' };
    if (settings.usePageContext && !captured) message.pageContextStatus = 'unavailable';
    conversation.messages.push(message);
    archiveOldSources(conversation);
    if (conversation.messages.length === 1) conversation.title = (captured?.title || content).slice(0, 42);
    if ($('prompt').value.trim() === content) $('prompt').value = '';
    await runRequest(conversation);
  } finally {
    sending = false;
    renderConversation();
    for (const id of ['sendBtn', 'newChatBtn', 'historyBtn', 'settingsBtn', 'refreshPageBtn', 'pasteBtn', 'webSearch']) $(id).disabled = false;
  }
}
function renderHistory() {
  const list = $('historyList'); list.replaceChildren();
  for (const conversation of [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const row = document.createElement('div'); row.className = 'history-row';
    const open = document.createElement('button'); open.type = 'button'; open.className = 'history-open';
    const title = document.createElement('strong'); title.textContent = conversation.title;
    const meta = document.createElement('small'); meta.textContent = `${new Date(conversation.updatedAt).toLocaleDateString('zh-CN')} · ${conversation.messages.length} 条消息`;
    open.append(title, meta);
    open.addEventListener('click', () => { activeId = conversation.id; renderConversation(); persist(); $('historyDialog').close(); });
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删除'; remove.className = 'history-delete';
    remove.addEventListener('click', () => {
      if (!confirm(`删除“${conversation.title}”及其本机记录？`)) return;
      conversations = conversations.filter((c) => c.id !== conversation.id);
      if (activeId === conversation.id) { activeId = conversations[0]?.id || ''; if (!activeId) newConversation(); else renderConversation(); }
      persist(); renderHistory();
    }); row.append(open, remove); list.append(row);
  }
}
function renderQuickPrompts() {
  const welcome = $('welcomeQuickPrompts'); const followup = $('followupQuickPrompts');
  welcome.replaceChildren(); followup.replaceChildren();
  for (const [index, item] of settings.quickPrompts.entries()) {
    const fill = () => { $('prompt').value = item.prompt; $('prompt').focus(); };
    const button = document.createElement('button'); button.type = 'button'; button.title = item.prompt;
    const number = document.createElement('span'); number.className = 'prompt-number'; number.textContent = String(index + 1).padStart(2, '0');
    const label = document.createElement('span'); label.textContent = item.label;
    button.append(number, label); button.addEventListener('click', fill); welcome.append(button);
    const compact = document.createElement('button'); compact.type = 'button'; compact.title = item.prompt; compact.textContent = item.label;
    compact.addEventListener('click', fill); followup.append(compact);
  }
  welcome.hidden = settings.quickPrompts.length === 0;
}
function collectQuickPrompts() {
  return quickPromptRows.map(row => ({ id: row.id, label: row.label.value.trim(), prompt: row.prompt.value.trim() }));
}
function renderQuickEditor(items) {
  const editor = $('quickPromptEditor'); editor.replaceChildren(); quickPromptRows = [];
  for (const [index, item] of items.entries()) {
    const row = document.createElement('section'); row.className = 'quick-editor-row';
    const fields = document.createElement('div'); fields.className = 'quick-editor-fields';
    const labelWrap = document.createElement('label'); labelWrap.textContent = `第 ${index + 1} 条 · 按钮名称`;
    const label = document.createElement('input'); label.type = 'text'; label.maxLength = 24; label.value = item.label; label.placeholder = '例如：写成观察';
    labelWrap.append(label);
    const promptWrap = document.createElement('label'); promptWrap.textContent = '完整提问';
    const prompt = document.createElement('textarea'); prompt.rows = 3; prompt.maxLength = 4000; prompt.value = item.prompt; prompt.placeholder = '点击按钮时填入的完整要求…';
    promptWrap.append(prompt); fields.append(labelWrap, promptWrap);
    const actions = document.createElement('div'); actions.className = 'quick-editor-actions';
    for (const [text, move] of [['上移', -1], ['下移', 1], ['删除', 0]]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
      button.disabled = move === -1 && index === 0 || move === 1 && index === items.length - 1;
      button.addEventListener('click', () => {
        const draft = collectQuickPrompts();
        if (move) [draft[index], draft[index + move]] = [draft[index + move], draft[index]];
        else draft.splice(index, 1);
        renderQuickEditor(draft);
      }); actions.append(button);
    }
    row.append(fields, actions); editor.append(row);
    quickPromptRows.push({ id: item.id, label, prompt });
  }
  $('addQuickPromptBtn').disabled = items.length >= 8;
}
function updateComposerNote() {
  const pageHint = settings.usePageContext ? '结合当前网页' : '不附带当前网页';
  $('composerNote').textContent = settings.webSearchEnabled
    ? `${pageHint} · 发送时联网检索，搜索与对话按 DeepSeek API 规则计费`
    : `${pageHint} · 联网搜索已关闭`;
}
async function saveToggle(key, id) {
  const before = settings[key]; settings[key] = $(id).checked;
  try { await chrome.storage.local.set({ settings }); }
  catch { settings[key] = before; $(id).checked = before; notice('设置保存失败，请重试。', true); }
  updateComposerNote();
}
function openSettings() {
  $('settingsError').hidden = true;
  $('apiKey').type = 'password'; $('toggleKeyBtn').textContent = '显示';
  $('apiKey').value = settings.apiKey;
  const standard = ['deepseek-flash', 'deepseek-v4-pro'].includes(settings.model);
  $('modelSelect').value = standard ? settings.model : 'custom'; $('customModel').value = standard ? '' : settings.model;
  $('customModel').hidden = standard; $('stylePrompt').value = settings.style; $('autoRead').checked = settings.autoRead; $('usePageContext').checked = settings.usePageContext;
  $('replyStylePrompt').value = settings.replyStyle; $('memoryPrompt').value = settings.memory;
  renderQuickEditor(settings.quickPrompts);
  $('readDiagnostics').textContent = lastReadReport ? JSON.stringify(lastReadReport, null, 2) : '还没有读取记录。打开普通网页后点击重新读取。';
  $('settingsDialog').showModal();
}
async function saveSettings(event) {
  event.preventDefault();
  const settingsError = (message) => { $('settingsError').textContent = message; $('settingsError').hidden = false; };
  const model = $('modelSelect').value === 'custom' ? $('customModel').value.trim() : $('modelSelect').value;
  if (!model || !/^[a-zA-Z0-9._:-]+$/.test(model)) { settingsError('请输入有效的模型 ID，仅使用字母、数字、点、短横线、冒号或下划线。'); return; }
  const preferenceDraft = { style: $('stylePrompt').value.trim(), replyStyle: $('replyStylePrompt').value.trim(), memory: $('memoryPrompt').value.trim(), quickPrompts: collectQuickPrompts() };
  const invalid = validatePreferences(preferenceDraft);
  if (invalid) { settingsError(invalid); return; }
  const next = normalizeSettings({ ...settings, ...preferenceDraft, apiKey: $('apiKey').value.trim(), model, autoRead: $('autoRead').checked, usePageContext: $('usePageContext').checked, thinking: $('thinking').checked, webSearchEnabled: $('webSearch').checked });
  try { await chrome.storage.local.set({ settings: next }); settings = next; }
  catch { settingsError('设置保存失败，请检查本机存储空间。'); return; }
  $('modelBadge').textContent = settings.model; renderQuickPrompts(); updateComposerNote(); $('settingsDialog').close(); notice('设置已长期保存在本机，将用于所有对话的后续回复。');
  if (settings.autoRead && contextMode !== 'paste') await readCurrent();
  else if (!page) await refreshSiteTarget();
}
function downloadConversation() {
  const conversation = current(); if (!conversation?.messages.length) return;
  const blob = new Blob([exportMarkdown(conversation)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url;
  a.download = `阅见-${conversation.title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 50)}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function acquirePanelLock() {
  // A single writer prevents separate Chrome windows from overwriting each
  // other's local snapshots. The browser releases the lock when this page closes.
  return new Promise((resolve) => {
    navigator.locks.request('yuejian-conversation-writer', { ifAvailable: true }, async (lock) => {
      if (!lock) { resolve(false); return; }
      resolve(true);
      await new Promise((release) => window.addEventListener('pagehide', release, { once: true }));
    }).catch(() => resolve(false));
  });
}
async function initialize() {
  if (!(await acquirePanelLock())) {
    document.querySelectorAll('button, input, textarea, select').forEach((element) => { element.disabled = true; });
    notice('另一个 Chrome 窗口正在使用阅见。请关闭那个窗口的阅见侧栏，再重新打开这里，避免对话互相覆盖。', true);
    return;
  }
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const stored = await chrome.storage.local.get(['settings', 'conversations', 'activeId']);
  settings = normalizeSettings(stored.settings); conversations = Array.isArray(stored.conversations) ? stored.conversations : [];
  activeId = stored.activeId || conversations[0]?.id || '';
  for (const c of conversations) for (const m of c.messages) {
    if (m.status === 'streaming') m.status = 'interrupted';
    if (m.webSearch?.status === 'searching') m.webSearch.status = 'stopped';
  }
  windowId = (await chrome.windows.getCurrent()).id;
  $('thinking').checked = settings.thinking; $('webSearch').checked = settings.webSearchEnabled; $('modelBadge').textContent = settings.model;
  renderQuickPrompts(); updateComposerNote();
  if (!current()) newConversation(); else { renderConversation(); persist(); }
  $('chatForm').addEventListener('submit', submit);
  $('prompt').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); } });
  $('stopBtn').addEventListener('click', () => controller?.abort());
  $('newChatBtn').addEventListener('click', newConversation);
  $('historyBtn').addEventListener('click', () => { renderHistory(); $('historyDialog').showModal(); });
  $('settingsBtn').addEventListener('click', openSettings);
  $('copyDiagnosticsBtn').addEventListener('click', async () => {
    try {
      if (!lastReadReport) throw new Error('还没有读取记录。请先读取一个网页。');
      await navigator.clipboard.writeText(JSON.stringify(lastReadReport, null, 2));
      $('settingsError').textContent = '已复制读取诊断，可发给我排查。';
    } catch (error) { $('settingsError').textContent = error.message || '复制失败，请选中下面的诊断文字复制。'; }
    $('settingsError').hidden = false;
  });
  $('settingsForm').addEventListener('submit', saveSettings);
  $('toggleKeyBtn').addEventListener('click', () => { const hidden = $('apiKey').type === 'password'; $('apiKey').type = hidden ? 'text' : 'password'; $('toggleKeyBtn').textContent = hidden ? '隐藏' : '显示'; });
  $('modelSelect').addEventListener('change', () => { $('customModel').hidden = $('modelSelect').value !== 'custom'; });
  $('resetStyleBtn').addEventListener('click', () => { $('stylePrompt').value = DEFAULT_STYLE; });
  $('thinking').addEventListener('change', () => saveToggle('thinking', 'thinking'));
  $('webSearch').addEventListener('change', () => saveToggle('webSearchEnabled', 'webSearch'));
  $('addQuickPromptBtn').addEventListener('click', () => {
    const draft = collectQuickPrompts(); if (draft.length >= 8) return;
    renderQuickEditor([...draft, { id: uid(), label: '新提问', prompt: '' }]);
  });
  $('resetQuickPromptsBtn').addEventListener('click', () => renderQuickEditor(DEFAULT_QUICK_PROMPTS));
  $('refreshPageBtn').addEventListener('click', () => { contextMode = 'auto'; return readCurrent(); });
  $('pasteBtn').addEventListener('click', () => $('pasteDialog').showModal());
  $('usePasteBtn').addEventListener('click', () => {
    const text = $('pasteText').value.trim(); if (!text) return;
    ++readVersion; reading = false; contextMode = 'paste';
    page = { id: uid(), title: $('pasteTitle').value.trim() || '粘贴内容', url: '', text: text.slice(0, 120000), truncated: text.length > 120000, originalLength: text.length, capturedAt: new Date().toISOString(), method: 'paste' };
    renderPageStatus(); $('pasteDialog').close();
  });
  $('exportBtn').addEventListener('click', downloadConversation);
  document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(button.dataset.close).close()));
  chrome.tabs.onActivated.addListener(({ windowId: id }) => { if (id === windowId) onPageChanged(); });
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (tab.windowId !== windowId || !tab.active) return;
    if (change.url || change.status === 'loading') invalidatePage();
    // A completion event must not supersede an in-flight capture, especially
    // the capture whose result is about to be attached to a user message.
    if ((change.status === 'complete' || (change.url && tab.status === 'complete')) && settings.autoRead && !document.hidden && !reading && !sending && !busy) readCurrent();
    else if (change.url || change.status === 'complete') refreshSiteTarget();
  });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || message.type !== 'yuejian:read-current-tab' || message.windowId !== windowId) return;
    // Match a fresh panel's startup behavior and respect the auto-read setting.
    onPageChanged();
  });
  pollTimer = setInterval(pollCurrentPage, 5000);
  window.addEventListener('pagehide', () => { clearInterval(pollTimer); controller?.abort(); persist(); });
  if (settings.autoRead && !document.hidden) await readCurrent(); else await refreshSiteTarget();
  if (!settings.apiKey) notice('先在右上角设置中填写 DeepSeek API Key，就可以开始聊天。');
}
initialize().catch((error) => notice(`初始化失败：${error.message}。请在 Chrome 扩展管理页重新加载插件。`, true));
