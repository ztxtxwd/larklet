import { randomBytes } from 'node:crypto';

import type { FeishuCardJson } from '@open-feishu-card/components';

import { LarkletError } from './app.js';
import { deleteEphemeralCard, sendEphemeralCard, tenantAccessToken } from './feishu.js';
import { feishuCredentials, useStore, type SearchParams } from './request.js';

export interface SendEphemeralInit {
  /** 默认用当前消息的 `openChatId`。 */
  chatId?: string;
  /** 私卡自己的 card state。默认沿用当前卡片。 */
  userState?: unknown;
  searchParams?: SearchParams;
  /** 覆盖开放平台域名，例如 Lark 的 `https://open.larksuite.com`。 */
  openApiBase?: string;
}

/**
 * 在当前群里发一张只有 `openId` 能看见的卡片。
 * 只能在 Server Action 里调用。`href` 会按收件人重新渲染（`operator().openId` 是收件人）。
 * 返回飞书 `message_id`，之后交给 `deleteEphemeral`。
 */
export async function sendEphemeral(
  href: string,
  openId: string,
  init: SendEphemeralInit = {},
): Promise<{ messageId: string }> {
  if (!href.startsWith('/')) {
    throw new Error('sendEphemeral 只接受站内路径，例如 sendEphemeral("/hand", openId)');
  }
  const who = openId.trim();
  if (!who) throw new Error('sendEphemeral 需要收件人 open_id');

  const store = useStore();
  if (store.phase !== 'action') {
    throw new Error('sendEphemeral 只能在 Server Action 里调用');
  }
  const chatId = init.chatId ?? store.message.openChatId;
  if (!chatId) throw new Error('sendEphemeral 需要群聊 open_chat_id');
  if (!store.renderRoute) throw new LarkletError('当前应用不能渲染路由');

  const card = await store.renderRoute(href, {
    userState: init.userState !== undefined ? init.userState : store.userState,
    searchParams: init.searchParams,
    operator: { openId: who },
    message: { openChatId: chatId },
  });

  const messageId = store.captureEphemeral
    ? `om_ephemeral_${randomBytes(8).toString('hex')}`
    : await deliver(card, { chatId, openId: who, openApiBase: init.openApiBase });

  store.ephemeralSent.push({ messageId, openId: who, chatId, card, path: href });
  return { messageId };
}

/** 删除一张仅特定人可见的卡片。只能在 Server Action 里调用。 */
export async function deleteEphemeral(messageId: string, openApiBase?: string): Promise<void> {
  const id = messageId.trim();
  if (!id) throw new Error('deleteEphemeral 需要 message_id');
  const store = useStore();
  if (store.phase !== 'action') {
    throw new Error('deleteEphemeral 只能在 Server Action 里调用');
  }
  if (!store.captureEphemeral) {
    const creds = feishuCredentials();
    if (!creds) throw new LarkletError('删除仅特定人可见的卡片需要配置 app_id 与 app_secret');
    const accessToken = await tenantAccessToken(creds.appId, creds.appSecret, openApiBase);
    await deleteEphemeralCard({ accessToken, messageId: id, openApiBase });
  }
  store.ephemeralDeleted.push(id);
}

async function deliver(
  card: FeishuCardJson,
  target: { chatId: string; openId: string; openApiBase?: string },
): Promise<string> {
  const creds = feishuCredentials();
  if (!creds) throw new LarkletError('发送仅特定人可见的卡片需要配置 app_id 与 app_secret');
  const accessToken = await tenantAccessToken(creds.appId, creds.appSecret, target.openApiBase);
  const sent = await sendEphemeralCard({
    accessToken,
    chatId: target.chatId,
    openId: target.openId,
    card,
    openApiBase: target.openApiBase,
  });
  return sent.messageId;
}
