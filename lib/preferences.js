import { DEFAULT_STYLE, DEFAULT_REPLY_STYLE, QUICK_PROMPTS } from './context.js';

const LIMITS = { style: 12000, replyStyle: 8000, memory: 12000, quickPrompts: 8, label: 24, prompt: 4000 };
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value : '';

export const DEFAULT_QUICK_PROMPTS = Object.freeze([
  Object.freeze({ id: 'summarize', label: '归纳要点', prompt: QUICK_PROMPTS.summarize }),
  Object.freeze({ id: 'analyze', label: '检视逻辑', prompt: QUICK_PROMPTS.analyze }),
  Object.freeze({ id: 'write', label: '写成评论', prompt: QUICK_PROMPTS.write }),
]);

export const DEFAULT_SETTINGS = Object.freeze({
  apiKey: '',
  model: 'deepseek-flash',
  style: DEFAULT_STYLE,
  replyStyle: DEFAULT_REPLY_STYLE,
  memory: '',
  quickPrompts: DEFAULT_QUICK_PROMPTS,
  autoRead: true,
  usePageContext: true,
  thinking: false,
  webSearchEnabled: true,
});

/** Recover stored data safely. An explicit empty list means the user removed all shortcuts. */
export function normalizeQuickPrompts(raw) {
  if (!Array.isArray(raw)) return DEFAULT_QUICK_PROMPTS.map(item => ({ ...item }));
  const result = [];
  const used = new Set();
  for (const [index, item] of raw.entries()) {
    if (result.length >= LIMITS.quickPrompts) break;
    if (!isRecord(item) || !text(item.label).trim() || !text(item.prompt).trim()) continue;
    let id = text(item.id);
    if (!SAFE_ID.test(id) || used.has(id)) {
      const base = `quick-${index + 1}`;
      id = base;
      let suffix = 2;
      while (used.has(id)) id = `${base}-${suffix++}`;
    }
    used.add(id);
    result.push({ id, label: item.label.trim().slice(0, LIMITS.label), prompt: item.prompt.slice(0, LIMITS.prompt) });
  }
  return result;
}

/** Pure migration for chrome.storage.local settings. No writes and no shared mutable values. */
export function normalizeSettings(raw) {
  const saved = isRecord(raw) ? raw : {};
  const model = text(saved.model).trim();
  const normalized = {
    apiKey: text(saved.apiKey),
    model: /^[a-zA-Z0-9._:-]+$/.test(model) ? model : DEFAULT_SETTINGS.model,
    style: (text(saved.style).trim() ? saved.style : DEFAULT_STYLE).slice(0, LIMITS.style),
    replyStyle: (text(saved.replyStyle).trim() ? saved.replyStyle : DEFAULT_REPLY_STYLE).slice(0, LIMITS.replyStyle),
    memory: text(saved.memory).slice(0, LIMITS.memory),
    quickPrompts: normalizeQuickPrompts(saved.quickPrompts),
  };
  for (const key of ['autoRead', 'usePageContext', 'thinking', 'webSearchEnabled']) {
    normalized[key] = typeof saved[key] === 'boolean' ? saved[key] : DEFAULT_SETTINGS[key];
  }
  return normalized;
}

/** Validate editable values before normalization so a save never silently drops user edits. */
export function validatePreferences(raw) {
  if (!isRecord(raw)) return '偏好设置格式不正确，请重新填写。';
  for (const [key, label] of [['style', '写作风格'], ['replyStyle', '回复风格'], ['memory', '长期要求']]) {
    if (typeof raw[key] !== 'string') return `${label}必须是文字。`;
    if (raw[key].length > LIMITS[key]) return `${label}最多 ${LIMITS[key]} 个字符，请缩短后保存。`;
  }
  if (!Array.isArray(raw.quickPrompts)) return '快捷提问格式不正确，请重新编辑。';
  if (raw.quickPrompts.length > LIMITS.quickPrompts) return `最多保留 ${LIMITS.quickPrompts} 条快捷提问。`;
  const used = new Set();
  for (const [index, item] of raw.quickPrompts.entries()) {
    const name = `第 ${index + 1} 条快捷提问`;
    if (!isRecord(item)) return `${name}格式不正确。`;
    if (!SAFE_ID.test(text(item.id))) return `${name}的标识无效，请删除后重新添加。`;
    if (used.has(item.id)) return `${name}的标识重复，请删除后重新添加。`;
    used.add(item.id);
    if (!text(item.label).trim()) return `${name}需要填写按钮名称。`;
    if (item.label.length > LIMITS.label) return `${name}的按钮名称最多 ${LIMITS.label} 个字符。`;
    if (!text(item.prompt).trim()) return `${name}需要填写提问内容。`;
    if (item.prompt.length > LIMITS.prompt) return `${name}的内容最多 ${LIMITS.prompt} 个字符。`;
  }
  return '';
}
