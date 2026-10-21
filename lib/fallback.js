// Self-contained for chrome.scripting.executeScript. This deliberately avoids
// Range measurements and skips uncertain regions instead of guessing visibility.
export function extractVisibleBlocks({ maxChars = 120000 } = {}) {
  let skippedSubtrees = 0;
  const diagnostics = () => ({ readyState: document.readyState || 'unknown', bodyPresent: Boolean(document.body), skippedSubtrees });
  const fail = (code, message) => ({ ok: false, error: { code, message }, diagnostics: diagnostics() });
  try {
    if (!/^https?:$/.test(location.protocol)) return fail('UNSUPPORTED_PAGE', '只支持普通 HTTP(S) 网页。');
    if (!document.body) return fail('WAIT_FOR_CONTENT', '网页尚未加载文字，请稍后重试。');
    const limit = Math.min(120000, Math.max(1, Math.floor(Number(maxChars) || 120000)));
    const root = document.documentElement;
    const styleOf = element => (element.ownerDocument?.defaultView || window).getComputedStyle(element);
    const rectangles = element => Array.from(element.getClientRects()).filter(r => r.width > 0 && r.height > 0);
    const hiddenStyle = style => style.display === 'none' || /^(hidden|collapse)$/.test(style.visibility)
      || style.contentVisibility === 'hidden' || (style.opacity !== '' && Number(style.opacity) === 0)
      || /blur\((?!\s*0(?:px)?\s*\))/.test(style.filter || '')
      || /\bopacity\(\s*(?:0+(?:\.0*)?|\.0+)\s*%?\s*\)/i.test(style.filter || '');
    const gateSelector = '.paywall, .subscription-wall, [data-paywall="true"], [data-access="locked"]';
    for (const gate of document.querySelectorAll(gateSelector)) {
      if (!rectangles(gate).length) continue;
      let visible = true;
      for (let element = gate; element; element = element.parentElement) {
        if (element.hidden || hiddenStyle(styleOf(element))) { visible = false; break; }
      }
      if (visible) return fail('ACCESS_RESTRICTED', '页面显示订阅访问限制，请先通过网站正常获得阅读权限。');
    }
    const excludedTags = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|INPUT|TEXTAREA|SELECT|OPTION|CANVAS|IFRAME|OBJECT|EMBED)$/;
    const blockTags = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DETAILS|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|SUMMARY|TABLE|TR|UL)$/;
    const parts = [];
    const viewport = { left: 0, top: 0, right: window.innerWidth || root?.clientWidth || 0, bottom: window.innerHeight || root?.clientHeight || 0 };
    function blocked(element, style) {
      return excludedTags.test(element.tagName) || element.hidden || element.isContentEditable
        || element.hasAttribute('hidden') || element.hasAttribute('inert')
        || element.getAttribute('aria-hidden') === 'true' || element.getAttribute('role') === 'textbox'
        || (element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false')
        || hiddenStyle(style) || (style.clip && style.clip !== 'auto') || (style.clipPath && style.clipPath !== 'none');
    }
    // Only roots get clipping boxes. Any other clipped subtree is omitted.
    function rootClip(element, style) {
      const x = /^(hidden|clip)$/.test(style.overflowX);
      const y = /^(hidden|clip)$/.test(style.overflowY);
      const contained = /\b(paint|strict|content)\b/.test(style.contain || '');
      if (!x && !y && !contained) return null;
      const rootStyle = root ? styleOf(root) : {};
      const propagated = element === root || (element === document.body && (!style.contain || style.contain === 'none')
        && rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible'
        && (!rootStyle.contain || rootStyle.contain === 'none'));
      return { box: propagated ? viewport : element.getBoundingClientRect(), x: x || contained, y: y || contained };
    }
    const rootStyle = root ? styleOf(root) : {};
    if (root && blocked(root, rootStyle)) return fail('NO_VISIBLE_TEXT', '当前页面没有可读取的可见文字。');
    const initialClip = root ? rootClip(root, rootStyle) : null;
    function rendered(element, clips) {
      return rectangles(element).some(rectangle => clips.every(({ box, x, y }) =>
        (!x || (rectangle.left >= box.left && rectangle.right <= box.right))
        && (!y || (rectangle.top >= box.top && rectangle.bottom <= box.bottom))));
    }
    function visit(element, inheritedClips) {
      try {
        if (element.nodeType !== 1) return;
        // Light DOM below a shadow host can be unassigned and never rendered.
        if (element.shadowRoot) { skippedSubtrees += 1; return; }
        const style = styleOf(element);
        if (blocked(element, style)) return;
        const isBody = element === document.body;
        if (!isBody && (/^(hidden|clip)$/.test(style.overflowX) || /^(hidden|clip)$/.test(style.overflowY)
          || /\b(paint|strict|content)\b/.test(style.contain || ''))) { skippedSubtrees += 1; return; }
        const clip = isBody ? rootClip(element, style) : null;
        const clips = clip ? inheritedClips.concat(clip) : inheritedClips;
        const block = blockTags.test(element.tagName);
        if (block || element.tagName === 'BR') parts.push('\n');
        const content = element.tagName === 'DETAILS' && !element.open
          ? Array.from(element.childNodes).filter(child => child.tagName === 'SUMMARY') : element.childNodes;
        for (const child of content) {
          try {
            if (child.nodeType === 3 && child.nodeValue && rendered(element, clips)) parts.push(child.nodeValue);
            else if (child.nodeType === 1) visit(child, clips);
          } catch { skippedSubtrees += 1; }
        }
        if (block) parts.push('\n');
        if (element.tagName === 'TD' || element.tagName === 'TH') parts.push('\t');
      } catch { skippedSubtrees += 1; }
    }
    visit(document.body, initialClip ? [initialClip] : []);
    const text = parts.join('').replace(/\u00a0/g, ' ').replace(/[ \t\f\v]+/g, ' ')
      .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) return fail('NO_VISIBLE_TEXT', '当前页面没有可读取的可见文字。');
    return { ok: true, title: (document.title || '未命名网页').trim().slice(0, 300), url: location.href,
      text: text.slice(0, limit), truncated: text.length > limit, originalLength: text.length,
      capturedAt: new Date().toISOString(), method: 'visible-blocks', partial: true,
      warnings: ['已使用可见文字兼容读取，部分内容可能未包含。'] };
  } catch {
    return fail('EXTRACTION_FAILED', '兼容读取暂未成功，请使用读取诊断查看原因。');
  }
}
