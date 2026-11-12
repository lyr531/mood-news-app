import { config, hasApiKey } from './config.js';

/**
 * 调用智谱 GLM 对话接口（OpenAI 兼容格式）
 * 文档: https://open.bigmodel.cn/dev/api/normal-model/glm-4
 */
export async function chat(messages, opts = {}) {
  if (!hasApiKey()) {
    const err = new Error('未配置 ZHIPU_API_KEY，请在 .env 中填写');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const {
    temperature = 0.7,
    maxTokens = 1500,
    json = false,
    timeoutMs = 60000,
    model = config.model,
  } = opts;

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (json) body.response_format = { type: 'json_object' };

  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`GLM 接口 ${res.status}: ${text.slice(0, 300)}`);
      }

      const data = JSON.parse(text);
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('GLM 返回内容为空');
      return content;
    } catch (err) {
      lastErr = err;
      if (err.code === 'NO_API_KEY') throw err;
      if (attempt === 1) await sleep(1200);
    }
  }
  throw lastErr;
}

/** 从模型输出里稳妥地抠出 JSON（容忍 ```json 包裹、前后废话） */
export function parseJson(text) {
  if (!text) throw new Error('空内容');
  let s = String(text).trim();

  // 去掉 ```json ... ``` 包裹
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  try {
    return JSON.parse(s);
  } catch {
    /* 继续尝试截取 */
  }

  const first = Math.min(
    ...[s.indexOf('{'), s.indexOf('[')].filter((i) => i >= 0),
  );
  const lastCurly = s.lastIndexOf('}');
  const lastSquare = s.lastIndexOf(']');
  const last = Math.max(lastCurly, lastSquare);
  if (Number.isFinite(first) && last > first) {
    return JSON.parse(s.slice(first, last + 1));
  }
  throw new Error('无法解析模型返回的 JSON');
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}