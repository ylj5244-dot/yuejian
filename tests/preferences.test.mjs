import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, DEFAULT_QUICK_PROMPTS, normalizeSettings, normalizeQuickPrompts, validatePreferences } from '../lib/preferences.js';
import { DEFAULT_STYLE, DEFAULT_REPLY_STYLE, QUICK_PROMPTS } from '../lib/context.js';

const preferences = (overrides = {}) => ({
  style: '按事实、原因、影响自然展开。',
  replyStyle: '先给结论，用通俗中文解释。',
  memory: '解释英文缩写。不要编造我的经历。',
  quickPrompts: [{ id: 'my-prompt', label: '我的问题', prompt: '解释重要变化。' }],
  ...overrides,
});

test('existing saved settings migrate without losing the key, model, writing style or switches', () => {
  const old = { apiKey: 'sk-example', model: 'my-provider:model-2026', style: '自己的写作风格', autoRead: false, usePageContext: false, thinking: true };
  const migrated = normalizeSettings(old);
  for (const [key, value] of Object.entries(old)) assert.equal(migrated[key], value);
  assert.equal(migrated.replyStyle, DEFAULT_REPLY_STYLE);
  assert.equal(migrated.memory, '');
  assert.equal(migrated.webSearchEnabled, true);
  assert.deepEqual(migrated.quickPrompts.map(item => item.label), ['归纳要点', '检视逻辑', '写成评论']);
  assert.equal(migrated.quickPrompts[0].prompt, QUICK_PROMPTS.summarize);
  assert.equal(migrated.quickPrompts[1].prompt, QUICK_PROMPTS.analyze);
  assert.equal(migrated.quickPrompts[2].prompt, QUICK_PROMPTS.write);
  assert.equal(old.replyStyle, undefined);
});

test('custom preferences survive JSON storage and restart with search disabled and all shortcuts deleted', () => {
  const saved = normalizeSettings({ ...preferences({ quickPrompts: [] }), apiKey: 'sk-example', model: 'custom-model', webSearchEnabled: false });
  const reloaded = normalizeSettings(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(reloaded, saved);
  assert.equal(reloaded.style, preferences().style);
  assert.equal(reloaded.replyStyle, preferences().replyStyle);
  assert.equal(reloaded.memory, preferences().memory);
  assert.equal(reloaded.webSearchEnabled, false);
  assert.deepEqual(reloaded.quickPrompts, []);
  assert.equal(validatePreferences(reloaded), '');
});

test('normalization rejects coercion, tolerates corrupted input and keeps independent snapshots', () => {
  for (const value of [undefined, null, 'bad', [], 1]) assert.deepEqual(normalizeSettings(value), DEFAULT_SETTINGS);
  const normalized = normalizeSettings({ apiKey: {}, model: null, style: '  ', replyStyle: '', memory: null, autoRead: 'false', usePageContext: 0, thinking: 'true', webSearchEnabled: 'false', quickPrompts: null });
  assert.equal(normalized.apiKey, '');
  assert.equal(normalized.model, DEFAULT_SETTINGS.model);
  assert.equal(normalized.style, DEFAULT_STYLE);
  assert.equal(normalized.replyStyle, DEFAULT_REPLY_STYLE);
  assert.equal(normalized.memory, '');
  assert.equal(normalized.autoRead, true);
  assert.equal(normalized.usePageContext, true);
  assert.equal(normalized.thinking, false);
  assert.equal(normalized.webSearchEnabled, true);
  const a = normalizeSettings();
  const b = normalizeSettings();
  a.quickPrompts[0].label = 'changed';
  a.quickPrompts.push({ id: 'added', label: 'added', prompt: 'added' });
  assert.equal(b.quickPrompts[0].label, '归纳要点');
  assert.equal(DEFAULT_QUICK_PROMPTS.length, 3);
  assert.equal(DEFAULT_SETTINGS.quickPrompts[0].label, '归纳要点');
});

test('quick prompt normalization uses stable safe unique ids and caps corrupted stored values', () => {
  const raw = [null, { id: 'same', label: '第一条', prompt: '问题一' }, { id: 'same', label: '第二条', prompt: '问题二' },
    { id: '<script>', label: '第三条', prompt: '问题三' }, { id: 'empty', label: '', prompt: 'empty' },
    ...Array.from({ length: 10 }, (_, index) => ({ id: `p${index}`, label: '字'.repeat(25), prompt: '文'.repeat(4001) })),
  ];
  const result = normalizeQuickPrompts(raw);
  assert.equal(result.length, 8);
  assert.equal(new Set(result.map(item => item.id)).size, result.length);
  assert.equal(result[0].id, 'same');
  for (const item of result) {
    assert.match(item.id, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
    assert.ok(item.label.length <= 24);
    assert.ok(item.prompt.length <= 4000);
  }
  assert.deepEqual(normalizeQuickPrompts(result), result);
  assert.deepEqual(normalizeQuickPrompts([]), []);
  assert.deepEqual(normalizeQuickPrompts('bad'), DEFAULT_QUICK_PROMPTS);
});

test('saving rejects overlong or invalid edits rather than silently cutting user preferences', () => {
  assert.equal(validatePreferences(preferences({ style: '字'.repeat(12000), replyStyle: '字'.repeat(8000), memory: '字'.repeat(12000), quickPrompts: [{ id: 'one', label: '字'.repeat(24), prompt: '字'.repeat(4000) }] })), '');
  for (const [key, limit] of [['style', 12000], ['replyStyle', 8000], ['memory', 12000]]) {
    const result = validatePreferences(preferences({ [key]: '字'.repeat(limit + 1) }));
    assert.equal(typeof result, 'string');
    assert.ok(result.includes(String(limit)), `${key} must explain its length limit`);
    assert.notEqual(validatePreferences(preferences({ [key]: {} })), '');
  }
  assert.equal(validatePreferences(preferences({ style: '', replyStyle: '', memory: '', quickPrompts: [] })), '');
  for (const quickPrompts of [
    null,
    [{ id: 'one', label: ' ', prompt: '内容' }],
    [{ id: 'one', label: '标题', prompt: ' ' }],
    [{ id: 'one', label: '字'.repeat(25), prompt: '内容' }],
    [{ id: 'one', label: '标题', prompt: '字'.repeat(4001) }],
    [{ id: 'one', label: '标题', prompt: '内容' }, { id: 'one', label: '重复', prompt: '内容' }],
    [{ id: '<unsafe>', label: '标题', prompt: '内容' }],
    Array.from({ length: 9 }, (_, index) => ({ id: `p${index}`, label: '标题', prompt: '内容' })),
  ]) assert.notEqual(validatePreferences(preferences({ quickPrompts })), '');
});

test('corrupted oversized stored preferences are bounded without mutation or sharing', () => {
  const raw = { ...preferences(), style: 's'.repeat(12001), replyStyle: 'r'.repeat(8001), memory: 'm'.repeat(12001) };
  const normalized = normalizeSettings(raw);
  assert.equal(normalized.style.length, 12000);
  assert.equal(normalized.replyStyle.length, 8000);
  assert.equal(normalized.memory.length, 12000);
  assert.equal(raw.style.length, 12001);
  normalized.quickPrompts[0].prompt = 'new';
  assert.equal(raw.quickPrompts[0].prompt, '解释重要变化。');
});
