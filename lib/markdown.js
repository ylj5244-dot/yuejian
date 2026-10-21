// Small, deliberately conservative Markdown renderer. Every text fragment is
// escaped; HTML is emitted only by the fixed tags below, never by model output.
const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function safeURL(value) {
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function inline(source, depth = 0) {
  if (depth > 8) return escapeHTML(source);
  let html = '';
  for (let index = 0; index < source.length;) {
    const rest = source.slice(index);
    if (rest[0] === '\\' && /[\\`*_[\]{}()#+\-.!|>]/.test(rest[1] || '')) {
      html += escapeHTML(rest[1]); index += 2; continue;
    }
    if (rest[0] === '`') {
      const ticks = rest.match(/^`+/)[0];
      const end = source.indexOf(ticks, index + ticks.length);
      if (end !== -1) {
        html += `<code>${escapeHTML(source.slice(index + ticks.length, end))}</code>`;
        index = end + ticks.length; continue;
      }
    }
    const link = rest.match(/^(!?)\[([^\]\n]*)\]\(/);
    if (link) {
      const start = index + link[0].length;
      let end = start;
      let parentheses = 1;
      while (end < source.length && parentheses && source[end] !== '\n') {
        if (source[end] === '(') parentheses += 1;
        if (source[end] === ')') parentheses -= 1;
        if (parentheses) end += 1;
      }
      if (parentheses === 0) {
        const label = inline(link[2], depth + 1);
        const url = safeURL(source.slice(start, end).trim());
        html += link[1] ? `[图片：${label || '未命名'}]`
          : url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
        index = end + 1; continue;
      }
    }
    let emphasized = false;
    for (const [marker, tag] of [['**', 'strong'], ['__', 'strong'], ['*', 'em'], ['_', 'em']]) {
      if (!rest.startsWith(marker)) continue;
      if (marker.includes('_') && index > 0 && /[\p{L}\p{N}]/u.test(source[index - 1])) continue;
      const end = source.indexOf(marker, index + marker.length);
      if (end > index + marker.length && !/\s/.test(source[index + marker.length])) {
        html += `<${tag}>${inline(source.slice(index + marker.length, end), depth + 1)}</${tag}>`;
        index = end + marker.length; emphasized = true; break;
      }
    }
    if (emphasized) continue;
    html += escapeHTML(source[index]);
    index += 1;
  }
  return html;
}

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim());
}

function tableDivider(line) {
  return line.includes('|') && cells(line).every(cell => /^:?-{3,}:?$/.test(cell));
}

function blocks(lines, depth = 0) {
  const output = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})([^`]*)$/);
    if (fence) {
      const code = [];
      index += 1;
      const endPattern = new RegExp(`^\\s{0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (index < lines.length && !endPattern.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      const language = fence[2].trim().match(/^[a-z0-9_-]{1,30}$/i)?.[0];
      output.push(`<pre><code${language ? ` class="language-${escapeHTML(language)}"` : ''}>${escapeHTML(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      index += 1; continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      output.push('<hr>'); index += 1; continue;
    }
    if (index + 1 < lines.length && line.includes('|') && tableDivider(lines[index + 1])) {
      const headings = cells(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        const values = cells(lines[index++]);
        rows.push(`<tr>${headings.map((_, column) => `<td>${inline(values[column] || '')}</td>`).join('')}</tr>`);
      }
      output.push(`<div class="table-scroll"><table><thead><tr>${headings.map(value => `<th>${inline(value)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
      continue;
    }
    const list = line.match(/^\s{0,3}(?:([-+*])|(\d{1,9})[.)])\s+(.+)$/);
    if (list) {
      const ordered = Boolean(list[2]);
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s{0,3}(?:([-+*])|(\d{1,9})[.)])\s+(.+)$/);
        if (!item || Boolean(item[2]) !== ordered) break;
        items.push(`<li>${inline(item[3])}</li>`); index += 1;
      }
      const start = ordered && Number(list[2]) !== 1 ? ` start="${Number(list[2])}"` : '';
      output.push(`<${tag}${start}>${items.join('')}</${tag}>`);
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) quote.push(lines[index++].replace(/^\s{0,3}> ?/, ''));
      output.push(`<blockquote>${depth < 8 ? blocks(quote, depth + 1) : `<p>${inline(quote.join('\n'))}</p>`}</blockquote>`);
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim()
      && !/^\s{0,3}(?:#{1,6}\s|>|`{3,}|~{3,}|[-+*]\s|\d{1,9}[.)]\s)/.test(lines[index])
      && !(index + 1 < lines.length && tableDivider(lines[index + 1]))) {
      paragraph.push(lines[index++]);
    }
    output.push(`<p>${paragraph.map(value => inline(value)).join('<br>')}</p>`);
  }
  return output.join('\n');
}

export function renderMarkdown(text) {
  if (text === null || text === undefined || text === '') return '';
  return blocks(String(text).replace(/\r\n?/g, '\n').split('\n'));
}
