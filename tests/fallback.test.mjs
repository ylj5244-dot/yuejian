import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { extractVisibleBlocks } from '../lib/fallback.js';

function capture(specs, { bodyStyle = {}, bodyRect, rootStyle = {}, maxChars, gates = [] } = {}) {
  const rect = { width: 400, height: 20, left: 0, top: 0, right: 400, bottom: 20 };
  const all = [];
  const make = ([tag, text = '', props = {}, children = []]) => {
    const node = { nodeType: 1, tagName: tag.toUpperCase(), parentElement: null, childNodes: [], ...props };
    node.getAttribute = name => node.attrs?.[name] ?? null;
    node.hasAttribute = name => Object.hasOwn(node.attrs || {}, name);
    node.getClientRects = () => [node.rect || rect];
    node.getBoundingClientRect = () => node.rect || rect;
    node.matches = selector => selector.includes('.paywall') && node.gate;
    if (text) node.childNodes.push({ nodeType: 3, nodeValue: text, parentElement: node });
    for (const child of children) { const item = make(child); item.parentElement = node; node.childNodes.push(item); }
    all.push(node);
    return node;
  };
  const root = make(['html', '', { style: rootStyle }]);
  const body = make(['body', '', { style: bodyStyle, ...(bodyRect ? { rect: bodyRect } : {}) }, specs]);
  body.parentElement = root;
  const document = { title: '兼容测试', readyState: 'complete', body, documentElement: root,
    querySelectorAll: () => gates.length ? gates : all.filter(node => node.gate) };
  const getComputedStyle = node => {
    if (node.fault) throw new Error('private content must not leak');
    return { display: 'block', visibility: 'visible', opacity: '1', filter: 'none', clip: 'auto',
      clipPath: 'none', overflowX: 'visible', overflowY: 'visible', contain: 'none', ...node.style };
  };
  // No Range APIs, WeakMap or module-scope dependencies are supplied.
  const run = vm.runInNewContext(`(${extractVisibleBlocks.toString()})`, {
    document, location: { protocol: 'https:', href: 'https://example.test/story' }, getComputedStyle,
    window: { innerWidth: 800, innerHeight: 600, getComputedStyle }, WeakMap: undefined,
  });
  return run({ maxChars });
}

test('fallback serializes independently and preserves ordinary below-fold text and block order', () => {
  const result = capture([['header', '标题'], ['main', '', {}, [['p', '首段'], ['p', '末段', {
    rect: { width: 400, height: 20, left: 0, right: 400, top: 2000, bottom: 2020 },
  }]]], ['footer', '页脚']]);
  assert.equal(result.ok, true);
  assert.match(result.text, /标题\s+首段\s+末段\s+页脚/);
  assert.equal(result.method, 'visible-blocks');
  assert.equal(result.partial, true);
});

test('fallback keeps healthy sibling content when one subtree throws', () => {
  const result = capture([['p', '前文'], ['div', '秘密', { fault: true }], ['p', '后文']]);
  assert.equal(result.ok, true);
  assert.match(result.text, /前文\s+后文/);
  assert.doesNotMatch(JSON.stringify(result), /秘密|private content/);
});

test('fallback excludes editable values, hidden, clipped, blurred, and embedded content', () => {
  const hidden = [
    ['input', '秘密'], ['textarea', '秘密'], ['select', '秘密'], ['script', '秘密'], ['canvas', '秘密'],
    ['div', '秘密', { attrs: { contenteditable: '' } }], ['div', '秘密', { attrs: { role: 'textbox' } }],
    ['div', '秘密', { attrs: { inert: '' } }], ['div', '秘密', { attrs: { 'aria-hidden': 'true' } }],
    ['div', '秘密', { hidden: true }], ['div', '秘密', { style: { display: 'none' } }],
    ['div', '秘密', { style: { visibility: 'hidden' } }], ['div', '秘密', { style: { opacity: '0' } }],
    ['div', '秘密', { style: { filter: 'blur(4px)' } }], ['div', '秘密', { style: { clip: 'rect(0px,0px,0px,0px)' } }],
    ['div', '秘密', { style: { clipPath: 'inset(100%)' } }],
    ['div', '', { style: { overflowY: 'hidden' } }, [['p', '秘密']]],
    ['iframe', '', {}, [['p', '秘密']]],
  ];
  const result = capture([['p', '公开'], ...hidden]);
  assert.equal(result.text, '公开');
});

test('fallback refuses visible access gates but not hidden gates', () => {
  assert.equal(capture([['article', '正文'], ['div', '订阅', { gate: true }]]).error.code, 'ACCESS_RESTRICTED');
  const hidden = capture([['article', '正文'], ['div', '订阅', { gate: true, style: { display: 'none' } }]]);
  assert.equal(hidden.ok, true);
  assert.equal(hidden.text, '正文');
});

test('fallback descends into fixed children of zero-height body but respects actual root clipping', () => {
  const zero = { width: 800, height: 0, top: 0, bottom: 0, left: 0, right: 800 };
  const styles = { overflowX: 'hidden', overflowY: 'hidden' };
  assert.equal(capture([['div', '', { rect: zero }, [['p', '可见固定布局']]]], { bodyStyle: styles, bodyRect: zero }).text, '可见固定布局');
  const clipped = capture([['p', '隐藏不要']], { bodyStyle: { ...styles, contain: 'paint' }, bodyRect: zero });
  assert.equal(clipped.ok, false);
  const viewportClip = capture([['p', '可见'], ['p', '隐藏不要', {
    rect: { width: 400, height: 20, left: 0, right: 400, top: 900, bottom: 920 },
  }]], { bodyStyle: styles, bodyRect: zero });
  assert.equal(viewportClip.text, '可见');
});

test('fallback enforces character bounds and emits metadata-only empty diagnostics', () => {
  const result = capture([['p', '文'.repeat(120001)]]);
  assert.equal(result.text.length, 120000);
  assert.equal(result.originalLength, 120001);
  assert.equal(result.truncated, true);
  assert.equal(capture([['p', '12345']], { maxChars: 3 }).text, '123');
  const empty = capture([['p', '秘密', { fault: true }]]);
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, 'NO_VISIBLE_TEXT');
  assert.doesNotMatch(JSON.stringify(empty), /秘密|private content|example.test/);
});

test('body containment prevents overflow propagation even for layout and style containment', () => {
  const zero = { width: 800, height: 0, top: 0, bottom: 0, left: 0, right: 800 };
  for (const contain of ['layout', 'style', 'size', 'inline-size']) {
    const result = capture([['p', '裁剪隐藏文字']], {
      bodyStyle: { overflowX: 'hidden', overflowY: 'hidden', contain }, bodyRect: zero,
    });
    assert.equal(result.ok, false, contain);
    assert.equal(result.error.code, 'NO_VISIBLE_TEXT', contain);
  }
});

test('fallback omits shadow hosts rather than reading unassigned light DOM', () => {
  const result = capture([
    ['p', '公开文字'],
    ['div', '', { shadowRoot: { childNodes: [] } }, [['p', '未分配的隐藏文字']]],
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.text, '公开文字');
});
