import { randomBytes } from 'node:crypto';

import type { FeishuCardJson } from '@open-feishu-card/components';

import { LarkletError } from './app.js';
import { patchInteractiveCard, postInteractiveCard, tenantAccessToken } from './feishu.js';
import {
  feishuCredentials,
  useStore,
  type MessageContext,
  type Operator,
  type SearchParams,
} from './request.js';

export interface SendCardInit {
  /** 默认用当前消息的 `openChatId`。 */
  chatId?: string;
  userState?: unknown;
  searchParams?: SearchParams;
  operator?: Operator;
  message?: MessageContext;
  /** 覆盖开放平台域名，例如 Lark 的 `https://open.larksuite.com`。 */
  openApiBase?: string;
  /** 仅本地预览：新会话卡片要出现在哪些人的栏里。 */
  openIds?: string[];
  /** 仅本地预览：跟在卡片后面的文字。 */
  previewText?: string;
}

export interface UpdateCardInit {
  userState?: unknown;
  searchParams?: SearchParams;
  operator?: Operator;
  message?: MessageContext;
  openApiBase?: string;
}

/**
 * 往会话里新发一张大家都能看到的卡片。只能在 Server Action 里调用。
 * 预览不请求飞书：同一会话里返回当前 `openMessageId`，方便之后用 `updateCard` 对上预览里的那张卡。
 * 开放平台失败时记一条警告并返回空的 `messageId`，不把错误抛回 Action。
 */
export async function sendCard(
  href: string,
  init: SendCardInit = {},
): Promise<{ messageId?: string }> {
  const target = resolveHref(href);
  const store = useStore();
  assertAction(store.phase, 'sendCard');
  const chatId = (init.chatId ?? store.message.openChatId)?.trim();
  if (!chatId) throw new Error('sendCard 需要会话 open_chat_id');
  if (!store.renderRoute) throw new LarkletError('当前应用不能渲染路由');

  const previewId = store.captureEphemeral ? previewMessageId(store.message, chatId) : undefined;
  const card = await store.renderRoute(target, {
    userState: init.userState !== undefined ? init.userState : store.userState,
    searchParams: init.searchParams,
    operator: init.operator ?? store.operator,
    message: init.message ?? { openChatId: chatId, openMessageId: previewId ?? store.message.openMessageId },
  });

  const messageId = store.captureEphemeral
    ? previewId
    : await deliverSend(card, { chatId, openApiBase: init.openApiBase });
  if (!messageId) return {};

  const openIds = init.openIds?.map((id) => id.trim()).filter(Boolean);
  const previewText = init.previewText?.trim();
  store.messagesSent.push({
    kind: 'send',
    messageId,
    chatId,
    card,
    path: target,
    ...(openIds?.length ? { openIds } : {}),
    ...(previewText ? { previewText } : {}),
  });
  return { messageId };
}

/**
 * 按路径重新渲染并更新一条已有消息。只能在 Server Action 里调用。
 * 目标就是当前这条消息时直接返回：本次回调的响应体会替换它，预览也会重绘这一栏。
 * 开放平台失败时记一条警告并返回 `updated: false`，不抛回 Action。
 */
export async function updateCard(
  messageId: string,
  href: string,
  init: UpdateCardInit = {},
): Promise<{ updated: boolean }> {
  const id = messageId.trim();
  if (!id) throw new Error('updateCard 需要 message_id');
  const target = resolveHref(href);
  const store = useStore();
  assertAction(store.phase, 'updateCard');
  if (id === store.message.openMessageId) return { updated: true };
  if (!store.renderRoute) throw new LarkletError('当前应用不能渲染路由');

  const card = await store.renderRoute(target, {
    userState: init.userState !== undefined ? init.userState : store.userState,
    searchParams: init.searchParams,
    operator: init.operator ?? store.operator,
    message: init.message ?? { openChatId: store.message.openChatId, openMessageId: id },
  });

  if (!store.captureEphemeral) {
    const sent = await deliverUpdate(id, card, init.openApiBase);
    if (!sent) return { updated: false };
  }

  store.messagesSent.push({ kind: 'update', messageId: id, card, path: target });
  return { updated: true };
}

function resolveHref(href: string): string {
  if (!href.startsWith('/')) throw new Error('只接受站内路径，例如 "/gomoku"');
  return href;
}

function assertAction(phase: string, name: string): void {
  if (phase !== 'action') throw new Error(`${name} 只能在 Server Action 里调用`);
}

/** 预览里这张卡已经在当前栏上，沿用它的 message id，后续更新才能对上。 */
function previewMessageId(message: MessageContext, chatId: string): string {
  const current = message.openMessageId?.trim();
  const sameChat = !message.openChatId || message.openChatId === chatId;
  if (sameChat && current) return current;
  return `om_${randomBytes(8).toString('hex')}`;
}

async function deliverSend(
  card: FeishuCardJson,
  target: { chatId: string; openApiBase?: string },
): Promise<string | undefined> {
  try {
    const accessToken = await accessTokenOf(target.openApiBase);
    const sent = await postInteractiveCard({
      accessToken,
      receiveId: target.chatId,
      card,
      openApiBase: target.openApiBase,
    });
    return sent.messageId;
  } catch (error) {
    console.warn('[larklet] 发送卡片失败', error);
    return undefined;
  }
}

async function deliverUpdate(messageId: string, card: FeishuCardJson, openApiBase?: string): Promise<boolean> {
  try {
    const accessToken = await accessTokenOf(openApiBase);
    await patchInteractiveCard({ accessToken, messageId, card, openApiBase });
    return true;
  } catch (error) {
    console.warn('[larklet] 更新卡片失败', error);
    return false;
  }
}

async function accessTokenOf(openApiBase?: string): Promise<string> {
  const creds = feishuCredentials();
  if (!creds) throw new LarkletError('发送或更新卡片需要配置 app_id 与 app_secret');
  return tenantAccessToken(creds.appId, creds.appSecret, openApiBase);
}
