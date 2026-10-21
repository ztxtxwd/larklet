import type { FeishuCardJson } from '@open-feishu-card/components';

import { LarkletError } from './app.js';
import { readStore, type Operator } from './request.js';

const DEFAULT_OPEN_API = 'https://open.feishu.cn';

const NAMED_OPEN_API: Record<string, string> = {
  Feishu: DEFAULT_OPEN_API,
  Lark: 'https://open.larksuite.com',
};

/**
 * 开放平台根地址。`Feishu` / `Lark` 映射官方域名；
 * `http(s)://...` 原样使用。未传时读 `LARK_DOMAIN`，再没有则用飞书国内域名。
 */
export function resolveOpenApiBase(domain?: string): string {
  const raw = (domain ?? process.env.LARK_DOMAIN ?? '').trim();
  if (!raw) return DEFAULT_OPEN_API;
  const named = NAMED_OPEN_API[raw];
  if (named) return named;
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
  return DEFAULT_OPEN_API;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

const tokens = new Map<string, TokenCache>();

export type ReceiveIdType = 'open_id' | 'chat_id';

/** 收件人 id 的前缀决定类型：`oc_` 是会话，其余按 open_id。 */
function inferReceiveIdType(receiveId: string): ReceiveIdType {
  return receiveId.startsWith('oc_') ? 'chat_id' : 'open_id';
}

/** 把渲染好的卡片作为交互消息发出。菜单 / 斜杠命令没有卡片回传体，这是对应的响应。 */
export async function sendInteractiveCard(
  appId: string,
  appSecret: string,
  receiveId: string,
  card: FeishuCardJson,
  receiveIdType: ReceiveIdType = 'open_id',
): Promise<void> {
  const base = resolveOpenApiBase();
  const token = await tenantAccessToken(appId, appSecret, base);
  const response = await fetch(`${base}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }),
  });
  const payload = await readFeishu(response);
  if (payload.code !== 0) {
    throw new LarkletError(`发送菜单卡片失败：${payload.msg || payload.code}`, 502);
  }
}

/** 发出一张交互卡片，返回飞书 `message_id`。 */
export async function postInteractiveCard(opts: {
  accessToken: string;
  receiveId: string;
  card: object;
  receiveIdType?: ReceiveIdType;
  openApiBase?: string;
}): Promise<{ messageId: string }> {
  const base = resolveOpenApiBase(opts.openApiBase);
  const receiveIdType = opts.receiveIdType ?? inferReceiveIdType(opts.receiveId);
  const response = await fetch(`${base}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.accessToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      receive_id: opts.receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(opts.card),
    }),
  });
  const payload = await readFeishu(response);
  const messageId = payload.data?.message_id;
  if (payload.code !== 0 || !messageId) {
    throw new LarkletError(`发送卡片失败：${payload.msg || payload.code}`, 502);
  }
  return { messageId };
}

/** 发一条纯文本消息，返回飞书 `message_id`。收件人按前缀判定，`oc_` 开头是会话。 */
export async function postText(opts: {
  accessToken: string;
  receiveId: string;
  text: string;
  receiveIdType?: ReceiveIdType;
  openApiBase?: string;
}): Promise<{ messageId: string }> {
  const base = resolveOpenApiBase(opts.openApiBase);
  const receiveIdType = opts.receiveIdType ?? inferReceiveIdType(opts.receiveId);
  const response = await fetch(`${base}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.accessToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      receive_id: opts.receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text: opts.text }),
    }),
  });
  const payload = await readFeishu(response);
  const messageId = payload.data?.message_id;
  if (payload.code !== 0 || !messageId) {
    throw new LarkletError(`发送文本失败：${payload.msg || payload.code}`, 502);
  }
  return { messageId };
}

export interface SendTextOptions {
  /** 凭证，默认取当前卡片上下文，再退回 `LARKLET_APP_ID` / `LARKLET_APP_SECRET`（也认 `APP_ID` / `APP_SECRET`）。 */
  appId?: string;
  appSecret?: string;
  /** 默认按收件人 id 前缀判断：`oc_` 是 `chat_id`，其余是 `open_id`。 */
  receiveIdType?: ReceiveIdType;
  /** 覆盖开放平台域名，例如 Lark 的 `https://open.larksuite.com`。 */
  openApiBase?: string;
}

/**
 * 收到事件后回一句话：直接发文本到会话或用户。
 *
 * ```ts
 * // open_id 私聊给提问的人，chat_id 发到群
 * await sendText(message.chat_id as string, '收到，马上处理');
 * ```
 *
 * 与 `sendCard` 不同，它不要求运行在 Server Action 里，`app/events.ts` 的事件处理函数也能直接调用。
 */
export async function sendText(
  receiveIdOrChatId: string,
  text: string,
  options: SendTextOptions = {},
): Promise<{ messageId: string }> {
  const receiveId = receiveIdOrChatId.trim();
  if (!receiveId) throw new Error('sendText 需要 open_id 或 chat_id');
  if (!text.trim()) throw new Error('sendText 需要非空文本');

  const store = readStore();
  const appId = options.appId?.trim() || store?.appId || process.env.LARKLET_APP_ID || process.env.APP_ID;
  const appSecret =
    options.appSecret?.trim() || store?.appSecret || process.env.LARKLET_APP_SECRET || process.env.APP_SECRET;
  if (!appId || !appSecret) {
    throw new LarkletError('发送文本需要配置 app_id 与 app_secret', 400);
  }

  const accessToken = await tenantAccessToken(appId, appSecret, options.openApiBase);
  return postText({
    accessToken,
    receiveId,
    text,
    receiveIdType: options.receiveIdType,
    openApiBase: options.openApiBase,
  });
}

/** 用卡片 JSON 更新一条已发出的消息。 */
export async function patchInteractiveCard(opts: {
  accessToken: string;
  messageId: string;
  card: object;
  openApiBase?: string;
}): Promise<void> {
  const base = resolveOpenApiBase(opts.openApiBase);
  const response = await fetch(`${base}/open-apis/im/v1/messages/${opts.messageId}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${opts.accessToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ content: JSON.stringify(opts.card) }),
  });
  const payload = await readFeishu(response);
  if (payload.code !== 0) {
    throw new LarkletError(`更新卡片失败：${payload.msg || payload.code}`, 502);
  }
}

/** 群聊斜杠命令发到群；菜单点击与私聊斜杠命令私聊给操作人。 */
export async function deliverMenuCard(
  appId: string,
  appSecret: string,
  target: { operator: Operator; chatId?: string; chatType?: string; card: FeishuCardJson },
): Promise<void> {
  if (target.chatType === 'group' && target.chatId) {
    await sendInteractiveCard(appId, appSecret, target.chatId, target.card, 'chat_id');
    return;
  }
  const openId = target.operator.openId;
  if (!openId) return;
  await sendInteractiveCard(appId, appSecret, openId, target.card, 'open_id');
}

/** 供本地预览拉图片等复用；带进程内缓存。 */
export async function tenantAccessToken(appId: string, appSecret: string, openApiBase?: string): Promise<string> {
  const base = resolveOpenApiBase(openApiBase);
  const cacheKey = `${base}\n${appId}`;
  const cached = tokens.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const response = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const payload = await readFeishu(response);
  if (payload.code !== 0 || typeof payload.tenant_access_token !== 'string') {
    throw new LarkletError(`获取 tenant_access_token 失败：${payload.msg || payload.code}`, 502);
  }
  const expire = typeof payload.expire === 'number' ? payload.expire : 7200;
  tokens.set(cacheKey, { token: payload.tenant_access_token, expiresAt: Date.now() + Math.max(expire - 60, 30) * 1000 });
  return payload.tenant_access_token;
}

export class EphemeralSendError extends LarkletError {
  readonly code?: number;

  constructor(message: string, code?: number) {
    super(message, 502);
    this.name = 'EphemeralSendError';
    this.code = code;
  }
}

export class EphemeralDeleteError extends LarkletError {
  readonly code?: number;

  constructor(message: string, code?: number) {
    super(message, 502);
    this.name = 'EphemeralDeleteError';
    this.code = code;
  }
}

/**
 * 在群里发一张只有 `openId` 能看见的交互卡片。
 * `card` 按飞书 ephemeral 接口原样作为对象提交，不要先 stringify。
 */
export async function sendEphemeralCard(opts: {
  accessToken: string;
  chatId: string;
  openId: string;
  card: object;
  /** 默认 `https://open.feishu.cn`。国际版 Lark 传 `https://open.larksuite.com`。 */
  openApiBase?: string;
}): Promise<{ messageId: string }> {
  const base = resolveOpenApiBase(opts.openApiBase);
  const response = await fetch(`${base}/open-apis/ephemeral/v1/send`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.accessToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      chat_id: opts.chatId,
      open_id: opts.openId,
      msg_type: 'interactive',
      card: opts.card,
    }),
  });
  const payload = await readFeishu(response);
  const messageId = payload.data?.message_id;
  if (payload.code !== 0 || !messageId) {
    throw new EphemeralSendError(
      `发送仅特定人可见的卡片失败：${payload.msg || payload.code}`,
      payload.code,
    );
  }
  return { messageId };
}

/** 删除仅特定人可见的卡片。`18051` 表示已经删过，视为成功。 */
export async function deleteEphemeralCard(opts: {
  accessToken: string;
  messageId: string;
  openApiBase?: string;
}): Promise<void> {
  const base = resolveOpenApiBase(opts.openApiBase);
  const response = await fetch(`${base}/open-apis/ephemeral/v1/delete`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.accessToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ message_id: opts.messageId }),
  });
  const payload = await readFeishu(response);
  if (payload.code === 18051) return;
  if (payload.code !== 0) {
    throw new EphemeralDeleteError(
      `删除仅特定人可见的卡片失败：${payload.msg || payload.code}`,
      payload.code,
    );
  }
}

async function readFeishu(response: Response): Promise<{
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
  data?: { message_id?: string };
}> {
  const text = await response.text();
  if (!text) return { code: response.ok ? 0 : response.status, msg: response.statusText };
  try {
    return JSON.parse(text) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
  } catch {
    throw new LarkletError(`飞书接口返回的不是 JSON：${response.status}`, 502);
  }
}
