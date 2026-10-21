const ENDPOINT = 'https://api.deepseek.com/chat/completions';

function abortError() {
  return new DOMException('已停止生成。', 'AbortError');
}

function httpError(status) {
  const descriptions = {
    400: '请求格式不符合要求，请检查模型名称与设置。',
    401: 'API Key 无效或已失效，请在设置中检查密钥。',
    402: 'DeepSeek API 账户余额不足，请前往开放平台查看余额。',
    403: 'DeepSeek 拒绝了本次请求，请检查账户和密钥权限。',
    404: '接口或模型不存在，请检查模型名称。',
    422: '请求参数不符合要求，请检查模型名称与设置。',
    429: '请求过于频繁或已达到并发上限，请稍后重试。',
    500: 'DeepSeek 服务暂时出现故障，请稍后重试。',
    502: 'DeepSeek 网关暂时不可用，请稍后重试。',
    503: 'DeepSeek 服务繁忙，请稍后重试。',
    504: 'DeepSeek 服务响应超时，请稍后重试。',
  };
  const error = new Error(descriptions[status] || `请求失败（HTTP ${status}），请稍后重试。`);
  error.status = status;
  return error;
}

/** Stream only to the official DeepSeek endpoint. No secret or upstream error is logged. */
export async function streamChat({ apiKey, model = 'deepseek-flash', thinking = false, messages, signal, onDelta = () => {} } = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw new Error('请先在设置中填写 DeepSeek API Key。');
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('没有可发送的消息。');
  if (signal?.aborted) throw abortError();
  const body = {
    model: typeof model === 'string' && model.trim() ? model.trim() : 'deepseek-flash',
    messages,
    thinking: { type: thinking ? 'enabled' : 'disabled' },
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: thinking ? 16384 : 8192,
  };
  if (thinking) body.reasoning_effort = 'high';

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw abortError();
    throw new Error('无法连接 DeepSeek，请检查网络连接后重试。');
  }
  if (!response.ok) throw httpError(response.status);
  if (!response.body) throw new Error('DeepSeek 返回了空响应，请重试。');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const result = { content: '', reasoning: '', usage: null, finishReason: null };
  let buffer = '';
  let doneEvent = false;
  const cancelReader = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancelReader, { once: true });

  function consumeEvent(rawEvent) {
    if (!rawEvent.trim()) return;
    const data = rawEvent.split(/\r\n|\n|\r/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data.trim()) return; // Includes SSE keep-alive comments.
    if (data.trim() === '[DONE]') { doneEvent = true; return; }
    let event;
    try { event = JSON.parse(data); }
    catch { throw new Error('DeepSeek 响应格式异常，未能完整解析回答。'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('DeepSeek 响应格式异常，未能完整解析回答。');
    if (event.error) throw new Error('DeepSeek 在生成过程中返回错误，请稍后重试。');
    if (event.usage) result.usage = event.usage;
    const choice = event.choices?.[0];
    if (!choice) return;
    const content = typeof choice.delta?.content === 'string' ? choice.delta.content : '';
    const reasoning = typeof choice.delta?.reasoning_content === 'string' ? choice.delta.reasoning_content : '';
    result.content += content;
    result.reasoning += reasoning;
    if (choice.finish_reason) result.finishReason = choice.finish_reason;
    if (content || reasoning) onDelta({ content, reasoning });
  }

  function consumeBuffer(final = false) {
    let boundary;
    while ((boundary = /\r?\n\r?\n|\r\r/.exec(buffer))) {
      const raw = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      consumeEvent(raw);
      if (signal?.aborted) throw abortError();
      if (doneEvent) return;
    }
    if (final && buffer.trim()) {
      consumeEvent(buffer);
      buffer = '';
    }
    if (buffer.length > 4_000_000) throw new Error('响应格式异常：未找到完整的消息边界。');
  }

  try {
    while (!doneEvent) {
      if (signal?.aborted) throw abortError();
      let chunk;
      try { chunk = await reader.read(); }
      catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw abortError();
        throw new Error('网络连接中断，已保留收到的部分回答，请重试。');
      }
      if (signal?.aborted) throw abortError();
      if (chunk.done) {
        buffer += decoder.decode();
        consumeBuffer(true);
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      consumeBuffer();
    }
    if (signal?.aborted) throw abortError();
    if (!doneEvent && !result.finishReason) throw new Error('连接提前中断，回答尚未完整结束，已保留收到的内容。');
    return result;
  } finally {
    signal?.removeEventListener('abort', cancelReader);
    try { await reader.cancel(); } catch { /* A closed or aborted stream needs no further work. */ }
    reader.releaseLock();
  }
}
