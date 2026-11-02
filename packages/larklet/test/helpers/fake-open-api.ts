import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  method: string;
  url: string;
  body?: unknown;
}

export interface FakeOpenApi {
  /** 开放平台根地址。给 `LARK_DOMAIN` 用。 */
  base: string;
  /** 发出去的消息（`POST /open-apis/im/v1/messages`）。 */
  calls: FakeRequest[];
  /** 收到的所有请求。 */
  requests: FakeRequest[];
  /** 历史消息接口的返回。 */
  history: unknown[];
  /** 机器人自己的 open_id。 */
  botOpenId: string;
  /** 假模型返回的回复正文。 */
  reply: string;
  /** 模型收到的请求。 */
  llmRequests: unknown[];
  /** 等到第 N 次模型请求进来。 */
  waitForLlm(count: number): Promise<void>;
  close(): Promise<void>;
}

export interface FakeOpenApiOptions {
  botOpenId?: string;
  reply?: string;
  /** 第 N 次调用模型时返回的回复。给 `reply` 兜底。 */
  replies?: string[];
  /** 把用户消息原样回回去。用来断言「回的是哪一条消息」。 */
  echoPrompt?: boolean;
  history?: unknown[];
  /** 假模型答话前先等这么久。用来模拟「模型正在思考」。 */
  llmDelayMs?: number;
}

/**
 * 本地假开放平台 + 假模型。
 *
 * 覆盖：tenant_access_token、发消息、拉历史、机器人信息、表情回复，
 * 以及 OpenAI 兼容的流式接口（`/v1/chat/completions`），后者会调一次 `reply_text`。
 */
export async function fakeOpenApi(options: FakeOpenApiOptions = {}): Promise<FakeOpenApi> {
  const state: FakeOpenApi = {
    base: '',
    calls: [],
    requests: [],
    history: options.history ?? [],
    botOpenId: options.botOpenId ?? 'ou_bot',
    reply: options.reply ?? '收到',
    llmRequests: [],
    waitForLlm: async () => {},
    close: async () => {},
  };

  // 每来一次模型请求，就唤醒一个在等的 waiter。
  const llmWaiters: (() => void)[] = [];
  state.waitForLlm = (count: number) =>
    new Promise<void>((resolve) => {
      if (state.llmRequests.length >= count) {
        resolve();
        return;
      }
      llmWaiters.push(resolve);
    });

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '';
      const method = req.method ?? 'GET';
      let body: unknown;
      try {
        body = raw ? (JSON.parse(raw) as unknown) : undefined;
      } catch {
        body = raw;
      }
      state.requests.push({ method, url, body });

      // 假模型：OpenAI 兼容的流式接口。
      if (url.startsWith('/v1/chat/completions')) {
        state.llmRequests.push(body);
        llmWaiters.splice(0).forEach((resolve) => resolve());
        const answer = options.echoPrompt
          ? lastUserText(body)
          : (options.replies?.[state.llmRequests.length - 1] ?? state.reply);
        const chunks = [
          sse({
            id: 'chatcmpl-1',
            object: 'chat.completion.chunk',
            created: 1_700_000_000,
            model: 'gpt-4.1-mini',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      type: 'function',
                      function: {
                        name: 'reply_text',
                        arguments: JSON.stringify({ content: answer }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
          sse({
            id: 'chatcmpl-1',
            object: 'chat.completion.chunk',
            created: 1_700_000_000,
            model: 'gpt-4.1-mini',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          }),
          'data: [DONE]\n\n',
        ];
        const write = (): void => {
          if (res.writableEnded || res.destroyed) return;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const chunk of chunks) res.write(chunk);
          res.end();
        };
        if (options.llmDelayMs) setTimeout(write, options.llmDelayMs);
        else write();
        return;
      }

      if (url.startsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        res.end(JSON.stringify({ code: 0, msg: 'ok', tenant_access_token: 't_token', expire: 7200 }));
        return;
      }
      if (url.startsWith('/open-apis/bot/v3/info')) {
        res.end(
          JSON.stringify({
            code: 0,
            msg: 'ok',
            bot: { open_id: state.botOpenId, app_name: '测试机器人' },
          }),
        );
        return;
      }
      // 拉历史：GET /open-apis/im/v1/messages?container_id_type=chat
      if (method === 'GET' && url.startsWith('/open-apis/im/v1/messages')) {
        res.end(JSON.stringify({ code: 0, msg: 'ok', data: { items: state.history, has_more: false } }));
        return;
      }
      // 表情回复：POST /open-apis/im/v1/messages/:id/reactions
      if (method === 'POST' && /\/open-apis\/im\/v1\/messages\/[^/]+\/reactions$/.test(url)) {
        res.end(JSON.stringify({ code: 0, msg: 'ok', data: { reaction_id: 'r_1' } }));
        return;
      }
      // 摘表情：DELETE /open-apis/im/v1/messages/:id/reactions/:reaction_id
      if (method === 'DELETE' && url.includes('/reactions/')) {
        res.end(JSON.stringify({ code: 0, msg: 'ok' }));
        return;
      }
      // 发消息：POST /open-apis/im/v1/messages?receive_id_type=…
      if (method === 'POST' && url.startsWith('/open-apis/im/v1/messages')) {
        state.calls.push({ method, url, body });
        res.end(JSON.stringify({ code: 0, msg: 'ok', data: { message_id: `om_${state.calls.length}` } }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ code: 404, msg: 'not found' }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  state.base = `http://127.0.0.1:${port}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      // 模型客户端会留着 keep-alive 连接，不主动掐掉的话 close() 一直等。
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 从模型请求里取出最后一条用户消息的正文。 */
export function lastUserText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: unknown };
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((block) =>
          block && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : '',
        )
        .join('');
    }
  }
  return '';
}

/** 临时改环境变量，跑完还原。 */
export function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
