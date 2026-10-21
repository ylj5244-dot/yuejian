import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { extractPage } from '../lib/extract.js';

let browser;
let browserUnavailable;
before(async () => {
  try {
    let playwright;
    try { playwright = createRequire(import.meta.url)('playwright'); }
    catch { playwright = await import('/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'); }
    browser = await playwright.chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
      args: ['--no-sandbox'],
    });
  } catch (error) {
    browserUnavailable = `Browser unavailable: ${error.message.split('\n')[0]}`;
  }
});
after(async () => { await browser?.close(); });

async function withPage(t, html, callback) {
  if (!browser) { t.skip(browserUnavailable); return; }
  const page = await browser.newPage();
  await page.route('https://article.example/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://article.example/story');
  try { await callback(page); }
  finally { await page.close(); }
}

// A small DOM boundary fixture keeps core serialized extraction checks runnable
// when Chromium is not installed. Layout and real browser behavior are covered
// by the integration cases below rather than simulated here.
function runStaticPage(sections, options, bodyProperties = {}, rootProperties) {
  const rectangle = { width: 100, height: 20, left: 0, top: 0, right: 100, bottom: 20 };
  const document = { title: '整页测试' };
  function element(tag, text = '') {
    const node = {
      nodeType: 1, tagName: tag.toUpperCase(), ownerDocument: document,
      parentElement: null, childNodes: [], children: [],
      matches(selector) { return selector.split(',').some(part => part.trim().toUpperCase() === this.tagName); },
      getAttribute: () => null, hasAttribute: () => false,
      getClientRects: () => [rectangle], getBoundingClientRect: () => rectangle,
      querySelector: () => null, querySelectorAll: () => [],
    };
    if (text) node.childNodes.push({ nodeType: 3, nodeValue: text, textContent: text, ownerDocument: document, parentElement: node });
    return node;
  }
  document.body = Object.assign(element('body'), bodyProperties);
  if (rootProperties) {
    document.documentElement = Object.assign(element('html'), rootProperties);
    document.body.parentElement = document.documentElement;
  }
  function append(parent, [tag, value, properties = {}, children = []]) {
    const node = element(tag, value);
    Object.assign(node, properties);
    node.parentElement = parent;
    parent.childNodes.push(node);
    parent.children.push(node);
    for (const child of children) append(node, child);
  }
  for (const section of sections) append(document.body, section);
  document.querySelectorAll = selector => document.body.children.filter(node => node.matches(selector));
  document.createRange = () => {
    let node;
    return { setStart(value) { node = value; }, setEnd() {}, getClientRects: () => [node.parentElement.testTextRectangle || rectangle] };
  };
  const getComputedStyle = node => ({ display: 'block', visibility: 'visible', opacity: '1', clipPath: 'none', clip: 'auto', filter: 'none', overflowX: 'visible', overflowY: 'visible', ...node.testStyle });
  const window = { getComputedStyle };
  document.defaultView = window;
  const run = vm.runInNewContext(`(${extractPage.toString()})`, {
    location: { protocol: 'https:', href: 'https://article.example/story' }, document, window, getComputedStyle,
  });
  return run(options);
}

function childFrameFixture(failure) {
  const rectangle = { width: 100, height: 20, left: 0, top: 0, right: 100, bottom: 20 };
  const document = {};
  const element = (tag, text = '') => {
    const node = {
      nodeType: 1, tagName: tag, ownerDocument: document, parentElement: null, childNodes: [], children: [],
      matches: () => false, getAttribute: () => null,
      getBoundingClientRect: () => rectangle, getClientRects: () => [rectangle],
    };
    if (text) node.childNodes.push({ nodeType: 3, nodeValue: text, ownerDocument: document, parentElement: node });
    return node;
  };
  const body = element('BODY');
  const prefix = element('P', '嵌入页已读前缀需要回滚');
  const bad = element('DIV', '嵌入页错误后内容不要');
  if (failure === 'restricted') bad.matches = selector => selector.includes('.paywall');
  body.childNodes = failure === 'empty' ? [] : [prefix, bad];
  prefix.parentElement = body; bad.parentElement = body;
  document.body = body;
  document.defaultView = { getComputedStyle(node) {
    if (failure === 'runtime' && node === bad) throw new TypeError('Child frame detached during measurement');
    return { display: 'block', visibility: 'visible', opacity: '1', clip: 'auto', clipPath: 'none', overflowX: 'visible', overflowY: 'visible', filter: 'none' };
  } };
  document.createRange = () => ({ setStart() {}, setEnd() {}, getClientRects: () => [rectangle] });
  return document;
}

test('serialized whole-page extraction keeps surrounding page regions and document order', () => {
  const result = runStaticPage([['header', '网站标题'], ['nav', '网页导航'], ['article', '文章内容'], ['aside', '侧栏信息'], ['footer', '页脚信息']]);
  assert.match(result.text, /网站标题\s+网页导航\s+文章内容\s+侧栏信息\s+页脚信息/);
  assert.equal(result.method, 'page');
});

test('captureErrors preserves successful text and returns serializable explicit failures', () => {
  const success = runStaticPage([['p', '正常页面文字']], { captureErrors: true });
  assert.equal(success.ok, true);
  assert.equal(success.text, '正常页面文字');
  const empty = runStaticPage([], { captureErrors: true });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, 'NO_VISIBLE_TEXT');
  assert.equal(empty.diagnostics.bodyPresent, true);
  assert.doesNotThrow(() => JSON.stringify(empty));
});

test('captureErrors catches injected runtime failures without misclassifying them as empty pages', () => {
  const run = vm.runInNewContext(`(${extractPage.toString()})`, {
    location: { protocol: 'https:', href: 'https://article.example/private?token=secret' },
    document: { readyState: 'complete', body: {}, querySelectorAll() { throw new TypeError('DOM measurement failed'); } },
  });
  assert.throws(() => run(), /DOM measurement failed/);
  const result = run({ captureErrors: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'EXTRACTION_FAILED');
  assert.equal(result.error.type, 'TypeError');
  assert.doesNotMatch(result.error.message, /DOM measurement failed/);
  assert.deepEqual(JSON.parse(JSON.stringify(result.diagnostics)), { readyState: 'complete', bodyPresent: true, frameCount: 0 });
  assert.doesNotMatch(JSON.stringify(result), /token=|https:|private/);
});

test('captured error types are allowlisted and arbitrary thrown data is not copied', () => {
  const run = vm.runInNewContext(`(${extractPage.toString()})`, {
    location: { protocol: 'https:' },
    document: { body: {}, querySelectorAll() { throw { name: 'SecretError-name', message: 'SecretError-body' }; } },
  });
  const result = run({ captureErrors: true });
  assert.equal(result.error.type, 'Error');
  assert.doesNotMatch(JSON.stringify(result), /SecretError/);
});

test('an embedded frame failure preserves the main article and rolls back partial frame text', () => {
  for (const [failure, warning] of [['runtime', 'FRAME_UNAVAILABLE'], ['restricted', 'FRAME_ACCESS_RESTRICTED'], ['empty', 'FRAME_EMPTY']]) {
    const result = runStaticPage([
      ['article', '主页面完整正文保留'],
      ['iframe', '', { contentDocument: childFrameFixture(failure) }],
      ['footer', '主页面结尾保留'],
    ], { captureErrors: true });
    assert.equal(result.ok, true, failure);
    assert.equal(result.partial, true);
    assert.match(result.text, /主页面完整正文保留\s+主页面结尾保留/);
    assert.doesNotMatch(result.text, /嵌入页/);
    assert.deepEqual(Array.from(result.warnings), [warning]);
  }
});

test('captureErrors distinguishes unsupported pages and documents still waiting for a body', () => {
  for (const [protocol, code] of [['chrome:', 'UNSUPPORTED_PAGE'], ['https:', 'WAIT_FOR_CONTENT']]) {
    const run = vm.runInNewContext(`(${extractPage.toString()})`, {
      location: { protocol }, document: { body: null, readyState: 'loading', querySelectorAll: () => [] },
    });
    const result = run({ captureErrors: true });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(result.diagnostics.readyState, 'loading');
    assert.equal(result.diagnostics.bodyPresent, false);
  }
});

test('a zero-height body with viewport overflow does not discard its visible fixed app', () => {
  const viewport = { width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600 };
  const zeroHeightBody = { ...viewport, height: 0, bottom: 0 };
  const result = runStaticPage([
    ['main', '', {
      testStyle: { position: 'fixed', overflowX: 'auto', overflowY: 'auto' },
      clientWidth: 800, scrollWidth: 800, clientHeight: 600, scrollHeight: 2400,
      getClientRects: () => [viewport], getBoundingClientRect: () => viewport,
    }, [['p', '固定布局的可见文字']]],
  ], undefined, {
    testStyle: { overflowX: 'hidden', overflowY: 'hidden' }, getBoundingClientRect: () => zeroHeightBody,
  }, { clientWidth: 800, clientHeight: 600 });
  assert.match(result.text, /固定布局的可见文字/);
});

test('body containment keeps zero-height overflow clipped instead of propagating it', () => {
  const result = runStaticPage([['p', '裁剪的正文不要']], { captureErrors: true }, {
    testStyle: { contain: 'paint', overflowX: 'hidden', overflowY: 'hidden' },
    getBoundingClientRect: () => ({ width: 800, height: 0, left: 0, top: 0, right: 800, bottom: 0 }),
  }, { clientWidth: 800, clientHeight: 600 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NO_VISIBLE_TEXT');
});

test('whole-page extraction defaults to 120000 characters and enforces the same hard cap', () => {
  const sections = [['p', '文'.repeat(120001)]];
  for (const options of [undefined, { maxChars: 500000 }]) {
    const result = runStaticPage(sections, options);
    assert.equal(result.text.length, 120000);
    assert.equal(result.originalLength, 120001);
    assert.equal(result.truncated, true);
  }
});

test('fully clipped image alternatives and control labels remain excluded', () => {
  const clipped = { testStyle: { clipPath: 'inset(100%)' }, getAttribute: name => ['alt', 'aria-label'].includes(name) ? '隐藏文字不要' : null };
  const result = runStaticPage([['p', '公开内容'], ['img', '', clipped], ['button', '', clipped]]);
  assert.equal(result.text, '公开内容');
});

test('a clipped app shell does not cut off loaded text in its inner scroll container', () => {
  const viewport = { width: 400, height: 600, left: 0, top: 0, right: 400, bottom: 600 };
  const port = { width: 400, height: 500, left: 0, top: 100, right: 400, bottom: 600 };
  const bottomText = { width: 200, height: 20, left: 0, top: 1500, right: 200, bottom: 1520 };
  const clippedText = { width: 200, height: 20, left: 0, top: 2000, right: 200, bottom: 2020 };
  const result = runStaticPage([
    ['header', '页面顶部'],
    ['main', '', {
      testStyle: { overflowX: 'auto', overflowY: 'auto' },
      clientWidth: 400, scrollWidth: 400, clientHeight: 500, scrollHeight: 2400,
      getClientRects: () => [port], getBoundingClientRect: () => port,
    }, [
      ['p', '滚动容器已加载末尾', { testTextRectangle: bottomText }],
      ['section', '', { testStyle: { overflowY: 'hidden' }, getBoundingClientRect: () => port }, [
        ['p', '真正裁剪内容不要', { testTextRectangle: clippedText }],
      ]],
      ['section', '', { testStyle: { filter: 'blur(4px)' } }, [
        ['p', '模糊内容不要', { testTextRectangle: bottomText }],
      ]],
    ]],
  ], undefined, { testStyle: { overflowX: 'hidden', overflowY: 'hidden' }, getBoundingClientRect: () => viewport });
  assert.match(result.text, /滚动容器已加载末尾/);
  assert.doesNotMatch(result.text, /不要/);
});

test('scroll containers cannot relax explicit clipping or an axis that cannot scroll', () => {
  const viewport = { width: 400, height: 600, left: 0, top: 0, right: 400, bottom: 600 };
  const below = { width: 200, height: 20, left: 0, top: 1500, right: 200, bottom: 1520 };
  const scrollProperties = {
    testStyle: { overflowX: 'auto', overflowY: 'auto' },
    clientWidth: 400, scrollWidth: 400, clientHeight: 600, scrollHeight: 2400,
    getClientRects: () => [viewport], getBoundingClientRect: () => viewport,
  };
  for (const bodyStyle of [{ clipPath: 'inset(0px)' }, { overflowY: 'hidden' }]) {
    const properties = bodyStyle.overflowY ? { ...scrollProperties, scrollHeight: 600 } : scrollProperties;
    const result = runStaticPage([
      ['header', '可见内容'],
      ['main', '', properties, [['p', '裁剪内容不要', { testTextRectangle: below }]]],
    ], undefined, { testStyle: bodyStyle, getBoundingClientRect: () => viewport });
    assert.equal(result.text, '可见内容');
  }
});

test('serialized extraction rejects privileged pages without depending on module scope', () => {
  const run = vm.runInNewContext(`(${extractPage.toString()})`, { location: { protocol: 'chrome:', href: 'chrome://settings/' } });
  assert.throws(() => run(), /HTTP|网页|支持/);
});

test('empty selection produces an actionable error in serialized function', () => {
  const run = vm.runInNewContext(`(${extractPage.toString()})`, {
    location: { protocol: 'https:', href: 'https://article.example/' },
    document: { title: 'Test', body: null },
    window: { getSelection: () => ({ isCollapsed: true, rangeCount: 0, toString: () => '' }) },
  });
  assert.throws(() => run({ selectionOnly: true }), /选中|选取|选区/);
});

test('serialized extraction stops at a visible subscription access gate', () => {
  const gate = { getClientRects: () => [{ width: 100, height: 100 }], parentElement: null, hidden: false };
  const run = vm.runInNewContext(`(${extractPage.toString()})`, {
    location: { protocol: 'https:', href: 'https://article.example/' },
    document: { body: {}, querySelectorAll: selector => selector.includes('.paywall') ? [gate] : [] },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  });
  assert.throws(() => run(), /付费|订阅|访问限制/);
  const result = run({ captureErrors: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ACCESS_RESTRICTED');
  assert.equal(result.text, undefined);
});

test('extracts the whole rendered page including navigation, forms, sidebars and footer', async t => {
  await withPage(t, `<title>阅读测试</title><header>站点标题</header><nav>页面导航</nav><article><h1>文章标题</h1>
    <p>这是正文第一段，有价值的阅读内容。</p><p>这是正文第二段，更多有价值的阅读内容。</p>
    <div hidden>隐藏不要</div><div style="display:none">CSS隐藏不要</div><div style="opacity:0">透明不要</div>
    <div aria-hidden="true">ARIA隐藏不要</div><div style="filter:blur(4px)">锁定正文不要</div>
    <form><label>搜索标签</label><input value="私人值不要"><input type="password" value="密码不要"><textarea>私密草稿不要</textarea><button>搜索按钮</button></form>
    <div contenteditable="true">编辑内容不要</div><aside>相关侧栏</aside><div class="advertisement">可见广告</div>
    <script>脚本不要</script></article><section>读者评论</section><footer>页脚信息</footer>`, async page => {
    const result = await page.evaluate(extractPage);
    assert.equal(result.title, '阅读测试');
    assert.equal(result.url, 'https://article.example/story');
    assert.match(result.text, /正文第一段/);
    assert.match(result.text, /正文第二段/);
    for (const text of ['站点标题', '页面导航', '搜索标签', '搜索按钮', '相关侧栏', '可见广告', '读者评论', '页脚信息']) assert.ok(result.text.includes(text), text);
    assert.doesNotMatch(result.text, /不要/);
    assert.equal(result.selection, false);
    assert.equal(result.method, 'page');
    assert.equal(result.truncated, false);
    assert.equal(result.originalLength, result.text.length);
    assert.ok(Number.isFinite(Date.parse(result.capturedAt)));
  });
});

test('includes both WeChat article containers and surrounding recommendations', async t => {
  await withPage(t, '<h1>微信文章</h1><div id="js_content"><p>微信正文第一段。</p><p>微信正文第二段。</p></div><section>推荐其他文章</section>', async page => {
    const result = await page.evaluate(extractPage);
    assert.match(result.text, /微信正文第一段/);
    assert.match(result.text, /推荐其他文章/);
  });
});

test('returns only selected article text while preserving metadata', async t => {
  await withPage(t, '<article><p id="text">选中的一小段文章</p><p>没有选中的文章</p></article>', async page => {
    await page.locator('#text').evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    const result = await page.evaluate(extractPage, { selectionOnly: true });
    assert.equal(result.text, '选中的一小段文章');
    assert.equal(result.selection, true);
    assert.equal(result.method, 'selection');
  });
});

test('rejects a selection originating in editable content', async t => {
  await withPage(t, '<article>可读取正文</article><div id="secret" contenteditable>私密编辑草稿</div>', async page => {
    await page.locator('#secret').evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await assert.rejects(page.evaluate(extractPage, { selectionOnly: true }), /表单|编辑|选区|选中/);
  });
});

test('a selection spanning private and visible nodes never includes the private text', async t => {
  await withPage(t, '<article id="story"><p>公开内容</p><div contenteditable>私人草稿</div><p>结尾内容</p></article>', async page => {
    await page.locator('#story').evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    const result = await page.evaluate(extractPage, { selectionOnly: true });
    assert.match(result.text, /公开内容/);
    assert.match(result.text, /结尾内容/);
    assert.doesNotMatch(result.text, /私人草稿/);
  });
});

test('truncates content to requested size and reports original visible length', async t => {
  await withPage(t, '<main><p>' + '正文内容'.repeat(100) + '</p></main>', async page => {
    const result = await page.evaluate(extractPage, { maxChars: 50 });
    assert.equal(result.text.length, 50);
    assert.equal(result.originalLength, 400);
    assert.equal(result.truncated, true);
  });
});

test('reads ordinary body content and preserves paragraph breaks', async t => {
  await withPage(t, '<div><p>普通网页第一段。</p><p>普通网页第二段。</p></div>', async page => {
    const result = await page.evaluate(extractPage);
    assert.match(result.text, /第一段。\n+普通网页第二段/);
  });
});

test('includes loaded content below the viewport and inside long scroll containers', async t => {
  await withPage(t, `<header>页面开头</header><div style="height:3000px"></div><p>页面底部已加载文字</p>
    <div style="height:80px;overflow:auto"><p>滚动容器顶部</p><div style="height:2000px"></div><p>滚动容器底部已加载文字</p></div>`, async page => {
    const result = await page.evaluate(extractPage);
    assert.match(result.text, /页面底部已加载文字/);
    assert.match(result.text, /滚动容器底部已加载文字/);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
  });
});

test('reads a fixed-height app with a scrolling main without expanding clipped descendants', async t => {
  await withPage(t, `<style>html,body{margin:0;height:100%;overflow:hidden}header{height:20px}main{height:calc(100% - 20px);overflow:auto}</style>
    <header>应用标题</header><main><p>应用开头</p><div style="height:3000px"></div><p>应用末尾已加载文字</p>
    <section style="height:20px;overflow:hidden"><div style="height:40px">公开摘要</div><p>截断秘密不要</p></section></main>`, async page => {
    const result = await page.evaluate(extractPage);
    assert.match(result.text, /应用末尾已加载文字/);
    assert.doesNotMatch(result.text, /不要/);
    assert.equal(await page.locator('main').evaluate(element => element.scrollTop), 0);
  });
});

test('reads a visible fixed app when body overflow propagates to the viewport', async t => {
  await withPage(t, `<style>body{overflow:hidden}main{position:fixed;inset:0;overflow:auto}</style>
    <main><p>固定页面第一段。</p><div style="height:2400px"></div><p>固定页面末尾已加载文字。</p>
    <div style="height:0;overflow:hidden"><p>折叠秘密不要</p></div></main>`, async page => {
    assert.equal(await page.locator('body').evaluate(element => element.getBoundingClientRect().height), 0);
    const result = await page.evaluate(extractPage, { captureErrors: true });
    assert.equal(result.ok, true);
    assert.match(result.text, /固定页面第一段/);
    assert.match(result.text, /固定页面末尾已加载文字/);
    assert.doesNotMatch(result.text, /秘密不要/);
  });
});

test('preserves table rows, image alternatives, captions and useful icon button labels', async t => {
  await withPage(t, `<table><tr><th>项目</th><th>结果</th></tr><tr><td>样本一</td><td>通过</td></tr></table>
    <figure><img alt="实验流程示意图" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" width="40" height="40"><figcaption>图一：实验流程</figcaption></figure>
    <button aria-label="下一页"><svg width="10" height="10"></svg></button>`, async page => {
    const result = await page.evaluate(extractPage);
    assert.match(result.text, /项目\s+结果\n+样本一\s+通过/);
    assert.match(result.text, /实验流程示意图/);
    assert.match(result.text, /图一：实验流程/);
    assert.match(result.text, /下一页/);
  });
});

test('reads open shadow roots once and only accessible same-origin frame text', async t => {
  await withPage(t, '<header>顶层页面</header><div id="host"><p slot="body">插槽文字</p><p>未分配文字不要</p></div><iframe id="local"></iframe><iframe id="opaque" sandbox=""></iframe>', async page => {
    await page.evaluate(async () => {
      document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<nav>影子导航</nav><slot name="body"></slot>';
      await Promise.all(['local', 'opaque'].map(id => new Promise(resolve => {
        const frame = document.getElementById(id);
        frame.onload = resolve;
        frame.srcdoc = id === 'local' ? '<article>同源框架正文</article><footer>框架页脚</footer>' : '<p>不透明框架文字不要</p>';
      })));
    });
    const result = await page.evaluate(extractPage);
    for (const text of ['顶层页面', '影子导航', '插槽文字', '同源框架正文', '框架页脚']) assert.ok(result.text.includes(text), text);
    assert.equal(result.text.match(/插槽文字/g)?.length, 1);
    assert.doesNotMatch(result.text, /不要/);
  });
});

test('does not expand disclosures or read text cut off by hidden overflow', async t => {
  await withPage(t, `<p>公开文字</p><details><summary>折叠章节标题</summary><p>折叠内容不要</p></details>
    <div style="height:20px;overflow:hidden"><div style="height:40px">可见摘要</div><p>裁剪内容不要</p></div>`, async page => {
    const result = await page.evaluate(extractPage);
    assert.match(result.text, /折叠章节标题/);
    assert.match(result.text, /可见摘要/);
    assert.doesNotMatch(result.text, /不要/);
    assert.equal(await page.locator('details').evaluate(element => element.open), false);
  });
});

test('preserves meaningful spaces between inline elements', async t => {
  await withPage(t, '<article><p><strong>Hello</strong> <em>world</em>.</p></article>', async page => {
    assert.equal((await page.evaluate(extractPage)).text, 'Hello world.');
  });
});

test('refuses full extraction when an active paywall covers article content', async t => {
  await withPage(t, '<article>正文可能在遮罩后面。</article><div class="paywall" style="position:fixed;inset:0">订阅后阅读</div>', async page => {
    await assert.rejects(page.evaluate(extractPage), /付费|订阅|访问限制/);
  });
});

test('excludes CSS-clipped text and zero-opacity filters, including ancestor styles', async t => {
  await withPage(t, `<article><p>可见正文保留。</p>
    <div style="clip-path:inset(100%)"><p>路径裁剪秘密不要</p></div>
    <div style="position:absolute;clip:rect(0px,0px,0px,0px)"><p>旧式裁剪秘密不要</p></div>
    <div style="filter:opacity(0)"><p>透明滤镜秘密不要</p></div>
    <div style="filter:opacity(0%)"><p>百分比透明秘密不要</p></div>
    <div style="filter:opacity(0.5)">半透明可见保留。</div>
    </article>`, async page => {
    const result = await page.evaluate(extractPage);
    assert.match(result.text, /可见正文保留/);
    assert.match(result.text, /半透明可见保留/);
    assert.doesNotMatch(result.text, /秘密不要/);
  });
});
