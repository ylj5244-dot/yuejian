// Keep ALL dependencies inside this function: Chrome serializes it for
// scripting.executeScript and does not carry its module scope into the page.
export function extractPage({ selectionOnly = false, maxChars = 120000, captureErrors = false } = {}) {
  // Chrome does not reliably propagate exceptions thrown in injected scripts.
  // Keep the error boundary inside the serialized function, returning only
  // JSON-safe values to callers that opt into the capture contract.
  const knownFailures = new WeakMap();
  function fail(code, message) {
    const error = new Error(message);
    knownFailures.set(error, code);
    throw error;
  }
  try {
  if (!/^https?:$/.test(location.protocol)) fail('UNSUPPORTED_PAGE', '只支持普通 HTTP(S) 网页；请打开网页，或手动粘贴内容。');
  const limit = Math.min(120000, Math.max(1, Math.floor(Number(maxChars) || 120000)));
  const selection = selectionOnly ? window.getSelection() : null;
  if (selectionOnly && (!selection || !selection.rangeCount || selection.isCollapsed || !selection.toString().trim())) {
    fail('NO_VISIBLE_TEXT', '请先在网页中选中一段文字，再读取选区。');
  }
  if (!document.body) fail('WAIT_FOR_CONTENT', '网页还没有可读取的内容，请稍后重试。');

  const gateSelector = '.paywall, .subscription-wall, [data-paywall="true"], [data-access="locked"]';
  const gateError = '页面显示付费或订阅访问限制。请先通过网站正常获得阅读权限，或手动粘贴你有权使用的内容。';
  // A visible access gate can cover DOM text without hiding the underlying
  // article. Do not read through it, including in shadow roots and local frames.
  for (const gate of document.querySelectorAll(gateSelector)) {
    if (!Array.from(gate.getClientRects()).some(rectangle => rectangle.width > 0 && rectangle.height > 0)) continue;
    let visible = true;
    for (let element = gate; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (element.hidden || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) { visible = false; break; }
    }
    if (visible) fail('ACCESS_RESTRICTED', gateError);
  }

  // Page chrome, forms' labels, buttons, comments, ads and footers are page
  // content. Only omit non-rendered content and editable/control values.
  const excludedSelector = [
    'script', 'style', 'noscript', 'template', 'input', 'textarea', 'select', 'option',
    'canvas', '[hidden]', '[inert]', '[aria-hidden="true"]', '[role="textbox"]',
    '[contenteditable]:not([contenteditable="false"])',
  ].join(',');
  const styles = new WeakMap();
  const visibility = new WeakMap();
  function styleOf(element) {
    if (!styles.has(element)) styles.set(element, (element.ownerDocument?.defaultView || window).getComputedStyle(element));
    return styles.get(element);
  }
  function parentOf(element) {
    return element.assignedSlot || element.parentElement || element.getRootNode?.().host || null;
  }
  function excluded(element) {
    if (!element || element.nodeType !== 1) return false;
    if (visibility.has(element)) return visibility.get(element);
    let hidden = element.matches(excludedSelector) || element.isContentEditable;
    if (!hidden) {
      const style = styleOf(element);
      hidden = style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
        || style.contentVisibility === 'hidden' || Number(style.opacity) === 0
        || /blur\((?!\s*0(?:px)?\s*\))/.test(style.filter)
        || /\bopacity\(\s*(?:0+(?:\.0*)?|\.0+)\s*%?\s*\)/i.test(style.filter);
      if (!hidden) hidden = excluded(parentOf(element));
    }
    visibility.set(element, Boolean(hidden));
    return Boolean(hidden);
  }
  function forbiddenSelectionEnd(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return element && excluded(element);
  }
  if (selectionOnly && (forbiddenSelectionEnd(selection.anchorNode) || forbiddenSelectionEnd(selection.focusNode))) {
    fail('NO_VISIBLE_TEXT', '无法读取表单、编辑区域或隐藏内容中的选区，请选择网页文字。');
  }

  const selections = [];
  if (selectionOnly) for (let index = 0; index < selection.rangeCount; index += 1) selections.push(selection.getRangeAt(index));
  const blockTags = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT',
    'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR',
    'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TR', 'UL']);
  const measuringRanges = new WeakMap();
  function inClip(rectangle, clipping) {
    // No viewport test: already loaded text below the fold and inside scroll
    // containers must be included without scrolling or loading more content.
    return rectangle.width > 0 && rectangle.height > 0 && clipping.every(clip =>
      (!clip.x || (rectangle.right > clip.rectangle.left && rectangle.left < clip.rectangle.right))
      && (!clip.y || (rectangle.bottom > clip.rectangle.top && rectangle.top < clip.rectangle.bottom)));
  }
  function rendered(element, clipping) {
    return Array.from(element.getClientRects()).some(rectangle => inClip(rectangle, clipping));
  }
  function visibleText(node, start, end, clipping) {
    const owner = node.ownerDocument || document;
    if (!measuringRanges.has(owner)) measuringRanges.set(owner, owner.createRange());
    const range = measuringRanges.get(owner);
    range.setStart(node, start); range.setEnd(node, end);
    const rects = Array.from(range.getClientRects());
    if (!rects.some(rectangle => inClip(rectangle, clipping))) return '';
    if (!clipping.length || rects.every(rectangle => clipping.every(clip =>
      (!clip.x || (rectangle.left >= clip.rectangle.left && rectangle.right <= clip.rectangle.right))
      && (!clip.y || (rectangle.top >= clip.rectangle.top && rectangle.bottom <= clip.rectangle.bottom))))) {
      return node.nodeValue.slice(start, end);
    }
    // Only partially clipped text needs character-level checks. Ordinary page
    // text uses one range and cached ancestor/style data throughout the walk.
    let result = '';
    for (let offset = start; offset < end; offset += 1) {
      range.setStart(node, offset); range.setEnd(node, offset + 1);
      if (Array.from(range.getClientRects()).some(rectangle => inClip(rectangle, clipping))) result += node.nodeValue[offset];
    }
    return result;
  }

  function clippingFor(element, previous) {
    const style = styleOf(element);
    const rectangle = element.getBoundingClientRect();
    const scrollX = /^(auto|scroll|overlay)$/.test(style.overflowX) && element.scrollWidth > element.clientWidth;
    const scrollY = /^(auto|scroll|overlay)$/.test(style.overflowY) && element.scrollHeight > element.clientHeight;
    // Fixed-height app shells commonly hide overflow around an inner scroller.
    // Its loaded content remains reachable by normal scrolling, so outer
    // overflow bounds must not clip that content along its scrolling axis.
    // Only relax a bound when the whole scrollport fits within it; keep CSS
    // clip/clip-path, non-scrolling axes and every clip inside the scroller.
    if ((scrollX || scrollY) && rendered(element, previous)) {
      previous = previous.map(clip => clip.overflow ? {
        ...clip,
        x: clip.x && !(scrollX && rectangle.left >= clip.rectangle.left && rectangle.right <= clip.rectangle.right),
        y: clip.y && !(scrollY && rectangle.top >= clip.rectangle.top && rectangle.bottom <= clip.rectangle.bottom),
      } : clip).filter(clip => clip.x || clip.y);
    }
    const additions = [];
    // overflow:auto/scroll exposes the rest of its loaded content by normal
    // scrolling. Only genuinely cut-off content is excluded.
    const x = /^(hidden|clip)$/.test(style.overflowX);
    const y = /^(hidden|clip)$/.test(style.overflowY);
    if ((x || y) && element.tagName !== 'HTML') {
      let overflowRectangle = rectangle;
      const owner = element.ownerDocument;
      const root = owner?.documentElement;
      const rootStyle = root ? styleOf(root) : null;
      // With the root's default visible overflow, HTML propagates body overflow
      // to the viewport. A body containing only fixed children can have height 0
      // while the children fill the visible viewport. Its box is not their clip.
      if (element === owner?.body && rootStyle?.overflowX === 'visible' && rootStyle.overflowY === 'visible'
        && (!style.contain || style.contain === 'none') && (!rootStyle.contain || rootStyle.contain === 'none')) {
        const view = owner.defaultView || window;
        const width = root.clientWidth || view.innerWidth;
        const height = root.clientHeight || view.innerHeight;
        if (width > 0 && height > 0) overflowRectangle = { left: 0, top: 0, right: width, bottom: height, width, height };
      }
      additions.push({ rectangle: overflowRectangle, x, y, overflow: true });
    }
    const clip = style.clip;
    if (clip && clip !== 'auto') {
      const values = clip.match(/^rect\(([^)]+)\)$/)?.[1].split(/[ ,]+/).filter(Boolean);
      if (!values || values.length !== 4) return null;
      const lengths = values.map((value, index) => value === 'auto' ? [0, rectangle.width, rectangle.height, 0][index] : parseFloat(value));
      if (lengths.some(value => !Number.isFinite(value))) return null;
      additions.push({ rectangle: { top: rectangle.top + lengths[0], right: rectangle.left + lengths[1], bottom: rectangle.top + lengths[2], left: rectangle.left + lengths[3] }, x: true, y: true });
    }
    const path = style.clipPath;
    if (path && path !== 'none') {
      // Rectangular inset clips are common for collapsed content. Other shapes
      // cannot be safely reduced to their bounding box: omit that subtree.
      const inset = path.match(/^inset\(([^)]+)\)$/)?.[1].split(/\s+round\s+/)[0].trim().split(/\s+/);
      if (!inset || inset.length > 4) return null;
      const values = inset.length === 1 ? [inset[0], inset[0], inset[0], inset[0]]
        : inset.length === 2 ? [inset[0], inset[1], inset[0], inset[1]]
          : inset.length === 3 ? [inset[0], inset[1], inset[2], inset[1]] : inset;
      const offsets = values.map((value, index) => /^-?\d*\.?\d+(px|%)?$/.test(value)
        ? parseFloat(value) * (value.endsWith('%') ? (index % 2 ? rectangle.width : rectangle.height) / 100 : 1) : NaN);
      if (offsets.some(value => !Number.isFinite(value))) return null;
      additions.push({ rectangle: { top: rectangle.top + offsets[0], right: rectangle.right - offsets[1], bottom: rectangle.bottom - offsets[2], left: rectangle.left + offsets[3] }, x: true, y: true });
    }
    if (additions.some(clip => (clip.x && clip.rectangle.right <= clip.rectangle.left)
      || (clip.y && clip.rectangle.bottom <= clip.rectangle.top))) return null;
    return additions.length ? previous.concat(additions) : previous;
  }

  const parts = [];
  const warnings = [];
  function warn(code) { if (!warnings.includes(code)) warnings.push(code); }
  const visited = new WeakSet();
  function visit(node, inheritedClipping = []) {
    if (visited.has(node)) return;
    visited.add(node);
    if (node.nodeType === 3) {
      if (!node.nodeValue || excluded(node.parentElement)) return;
      if (selectionOnly) {
        for (const range of selections) {
          if (node.ownerDocument !== document || !range.intersectsNode(node)) continue;
          const start = range.startContainer === node ? range.startOffset : 0;
          const end = range.endContainer === node ? range.endOffset : node.nodeValue.length;
          if (start < end) parts.push(visibleText(node, start, end, inheritedClipping));
        }
      } else parts.push(visibleText(node, 0, node.nodeValue.length, inheritedClipping));
      return;
    }
    if (node.nodeType !== 1 || excluded(node)) return;
    if (node.matches(gateSelector) && Array.from(node.getClientRects()).some(rectangle => rectangle.width > 0 && rectangle.height > 0)) fail('ACCESS_RESTRICTED', gateError);
    const clipping = clippingFor(node, inheritedClipping);
    if (!clipping) return;
    const block = blockTags.has(node.tagName);
    if (block || node.tagName === 'BR') parts.push('\n');
    const contentStart = parts.length;
    if (node.tagName === 'IFRAME') {
      if (!selectionOnly && rendered(node, clipping)) {
        const frameStart = parts.length;
        try {
          const frameDocument = node.contentDocument;
          if (frameDocument?.body) {
            parts.push('\n');
            // Frame rectangles are in their own coordinate system. Treat each
            // embedded document as an independent capture: a detached ad frame
            // must not erase successfully captured main-document content.
            visit(frameDocument.body);
            if (parts.slice(frameStart).some(part => part.trim())) parts.push('\n');
            else { parts.length = frameStart; warn('FRAME_EMPTY'); }
          } else warn('FRAME_UNAVAILABLE');
        } catch (error) {
          // A gate can be encountered after earlier text from the same frame.
          // Roll back the whole frame so no pre-gate material slips through.
          parts.length = frameStart;
          warn(knownFailures.get(error) === 'ACCESS_RESTRICTED' ? 'FRAME_ACCESS_RESTRICTED' : 'FRAME_UNAVAILABLE');
        }
      }
    } else if (node.tagName === 'IMG') {
      if (!selectionOnly && rendered(node, clipping)) {
        const alt = node.getAttribute('alt')?.trim();
        if (alt) parts.push(` ${alt} `);
      }
    } else if (node.tagName === 'DETAILS' && !node.open) {
      const summary = Array.from(node.children).find(child => child.tagName === 'SUMMARY');
      if (summary) visit(summary, clipping);
    } else if (node.shadowRoot) {
      for (const child of node.shadowRoot.childNodes) visit(child, clipping);
    } else if (node.tagName === 'SLOT' && node.assignedNodes) {
      const assigned = node.assignedNodes({ flatten: true });
      for (const child of assigned.length ? assigned : node.childNodes) visit(child, clipping);
    } else {
      for (const child of node.childNodes) visit(child, clipping);
    }
    if (!selectionOnly && (node.tagName === 'BUTTON' || node.tagName === 'A' || node.getAttribute('role') === 'button')
      && !parts.slice(contentStart).some(part => part.trim())
      && rendered(node, clipping)) {
      const label = node.getAttribute('aria-label') || node.getAttribute('title');
      if (label?.trim()) parts.push(` ${label.trim()} `);
    }
    if (block) parts.push('\n');
    if (node.tagName === 'TD' || node.tagName === 'TH') parts.push('\t');
  }

  visit(document.body);
  const text = parts.join('').replace(/\u00a0/g, ' ').replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) fail('NO_VISIBLE_TEXT', selectionOnly ? '选区中没有可读取的公开内容，请重新选择。' : '未找到可读取的网页内容。页面可能尚未加载、需要登录，或使用 PDF／特殊布局；可手动粘贴。');
  const originalLength = text.length;
  return {
    ...(captureErrors ? { ok: true } : {}),
    title: (document.title || '未命名网页').trim().slice(0, 300),
    url: location.href,
    text: text.slice(0, limit),
    selection: Boolean(selectionOnly),
    truncated: originalLength > limit,
    originalLength,
    capturedAt: new Date().toISOString(),
    method: selectionOnly ? 'selection' : 'page',
    ...(warnings.length ? { warnings, partial: true } : {}),
  };
  } catch (error) {
    if (!captureErrors) throw error;
    // These diagnostics describe the capture environment, never page contents,
    // addresses, credentials, or the extension's settings.
    const diagnostics = { readyState: '', bodyPresent: false, frameCount: 0 };
    try { diagnostics.readyState = String(document.readyState || ''); } catch {}
    try { diagnostics.bodyPresent = Boolean(document.body); } catch {}
    try { diagnostics.frameCount = document.querySelectorAll('iframe,frame').length; } catch {}
    const code = knownFailures.get(error) || 'EXTRACTION_FAILED';
    const allowedTypes = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
      'SecurityError', 'NotAllowedError', 'NotFoundError', 'InvalidStateError', 'IndexSizeError', 'InvalidAccessError',
      'NotSupportedError', 'AbortError', 'UnknownError'];
    let type = 'Error';
    try { if (allowedTypes.includes(error?.name)) type = error.name; } catch {}
    return {
      ok: false,
      error: {
        code,
        type,
        message: code === 'EXTRACTION_FAILED' ? '网页提取脚本执行失败，请使用读取诊断查看原因。' : error.message,
      },
      diagnostics,
    };
  }
}
