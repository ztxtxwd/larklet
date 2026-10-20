import { createDecipheriv, createHash } from 'node:crypto';

import type { MessageContext, Operator } from './request.js';

export interface CardAction {
  operator: Operator;
  message: MessageContext;
  /** 应用校验 token（2.0 在 header.token，1.0 在 body.token）。不是 event.token。 */
  verificationToken?: string;
  value: Record<string, unknown>;
  formValue?: Record<string, unknown>;
  option?: string;
  tag?: string;
  name?: string;
  /** 部分通道会把当前卡片带回，用于从封印宿主读 state。 */
  card?: unknown;
}

/**
 * 打开端点的入口：机器人菜单 `application.bot.menu_v6`，
 * 或用户消息里以 `/` 开头的斜杠命令（`im.message.receive_v1`）。
 */
export interface MenuEvent {
  operator: Operator;
  /** 菜单 event_key，或斜杠命令去掉 `/` 后的内容，例如 `guide` 或 `ticket/42?from=menu`。 */
  eventKey: string;
  /** 用户点击菜单的时间。飞书给的是秒级时间戳。 */
  timestamp?: number;
  verificationToken?: string;
  /** 斜杠命令来源会话；`chatType === 'group'` 时卡片投递到该群。 */
  chatId?: string;
  chatType?: string;
  messageId?: string;
}

export type Incoming =
  | { kind: 'challenge'; challenge: string; token?: string }
  | { kind: 'action'; action: CardAction }
  | { kind: 'menu'; menu: MenuEvent }
  | { kind: 'ignore' };

export function decryptBody(body: unknown, encryptKey: string | undefined): unknown {
  if (!encryptKey || !isRecord(body) || typeof body.encrypt !== 'string') return body;
  const key = createHash('sha256').update(encryptKey).digest();
  const buffer = Buffer.from(body.encrypt, 'base64');
  const iv = buffer.subarray(0, 16);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  const json = Buffer.concat([decipher.update(buffer.subarray(16)), decipher.final()]).toString('utf8');
  return JSON.parse(json) as unknown;
}

/** 兼容卡片回传 2.0（header/event）和 1.0 扁平体，以及本地预览塞进来的同形 JSON。 */
export function normalizeIncoming(body: unknown): Incoming {
  if (!isRecord(body)) return { kind: 'ignore' };

  if (body.type === 'url_verification' && typeof body.challenge === 'string') {
    return { kind: 'challenge', challenge: body.challenge, token: typeof body.token === 'string' ? body.token : undefined };
  }

  const header = isRecord(body.header) ? body.header : undefined;
  const eventType = typeof header?.event_type === 'string' ? header.event_type : undefined;
  const event = isRecord(body.event) ? body.event : body;

  if (eventType === 'application.bot.menu_v6' || body.type === 'application.bot.menu_v6') {
    return { kind: 'menu', menu: readMenu(event, header, body) };
  }

  if (eventType === 'im.message.receive_v1' || body.type === 'im.message.receive_v1') {
    const menu = readSlashCommand(event, header, body);
    return menu ? { kind: 'menu', menu } : { kind: 'ignore' };
  }

  const actionRecord = isRecord(event.action) ? event.action : undefined;
  const looksLikeAction =
    eventType === 'card.action.trigger' ||
    body.type === 'card.action.trigger' ||
    (actionRecord !== undefined && (event.open_id !== undefined || event.open_message_id !== undefined || body.event !== undefined));

  if (!looksLikeAction || !actionRecord) return { kind: 'ignore' };

  const operatorRecord = isRecord(event.operator) ? event.operator : event;
  const context = isRecord(event.context) ? event.context : event;

  return {
    kind: 'action',
    action: {
      operator: {
        openId: stringField(operatorRecord, 'open_id'),
        userId: stringField(operatorRecord, 'user_id'),
        unionId: stringField(operatorRecord, 'union_id'),
        tenantKey: stringField(operatorRecord, 'tenant_key') ?? stringField(header ?? {}, 'tenant_key'),
        name: stringField(operatorRecord, 'name') ?? stringField(operatorRecord, 'operator_name'),
        avatar: stringField(operatorRecord, 'avatar'),
      },
      message: {
        openMessageId: stringField(context, 'open_message_id'),
        openChatId: stringField(context, 'open_chat_id'),
      },
      verificationToken: header ? stringField(header, 'token') : stringField(body, 'token'),
      value: isRecord(actionRecord.value) ? actionRecord.value : {},
      formValue: isRecord(actionRecord.form_value) ? actionRecord.form_value : undefined,
      option: stringField(actionRecord, 'option'),
      tag: stringField(actionRecord, 'tag'),
      name: stringField(actionRecord, 'name'),
      card: event.card ?? body.card,
    },
  };
}

function readMenu(
  event: Record<string, unknown>,
  header: Record<string, unknown> | undefined,
  body: Record<string, unknown>,
): MenuEvent {
  const operatorRecord = isRecord(event.operator) ? event.operator : {};
  const operatorId = isRecord(operatorRecord.operator_id) ? operatorRecord.operator_id : operatorRecord;
  const timestamp = event.timestamp;
  return {
    operator: {
      openId: stringField(operatorId, 'open_id'),
      userId: stringField(operatorId, 'user_id'),
      unionId: stringField(operatorId, 'union_id'),
      tenantKey: stringField(header ?? {}, 'tenant_key') ?? stringField(operatorRecord, 'tenant_key'),
      name: stringField(operatorRecord, 'operator_name'),
    },
    eventKey: stringField(event, 'event_key') ?? '',
    timestamp: typeof timestamp === 'number' ? timestamp : undefined,
    verificationToken: header ? stringField(header, 'token') : stringField(body, 'token'),
  };
}

/**
 * 用户发给机器人的文本若以 `/` 开头（群聊里可先 @bot），把斜杠后的内容当作菜单 `event_key`。
 * 例如私聊 `/guide`、群聊 `@机器人 /guide` 与点击 event_key 为 `guide` 的菜单等价。
 */
function readSlashCommand(
  event: Record<string, unknown>,
  header: Record<string, unknown> | undefined,
  body: Record<string, unknown>,
): MenuEvent | undefined {
  const sender = isRecord(event.sender) ? event.sender : undefined;
  if (!sender) return undefined;
  const senderType = stringField(sender, 'sender_type');
  if (senderType !== undefined && senderType !== 'user') return undefined;

  const eventKey = slashEventKey(event);
  if (!eventKey) return undefined;

  const senderId = isRecord(sender.sender_id) ? sender.sender_id : sender;
  const message = isRecord(event.message) ? event.message : undefined;
  const createTime = message ? stringField(message, 'create_time') : undefined;
  const timestamp = createTime !== undefined ? Number(createTime) : undefined;
  return {
    operator: {
      openId: stringField(senderId, 'open_id'),
      userId: stringField(senderId, 'user_id'),
      unionId: stringField(senderId, 'union_id'),
      tenantKey: stringField(header ?? {}, 'tenant_key') ?? stringField(sender, 'tenant_key'),
    },
    eventKey,
    chatId: message ? stringField(message, 'chat_id') : undefined,
    chatType: message ? stringField(message, 'chat_type') : undefined,
    messageId: message ? stringField(message, 'message_id') : undefined,
    timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
    verificationToken: header ? stringField(header, 'token') : stringField(body, 'token'),
  };
}

/** 从文本消息抽出斜杠命令 key；去掉 @mention 占位后须以 `/` 开头。 */
function slashEventKey(event: Record<string, unknown>): string | undefined {
  const message = isRecord(event.message) ? event.message : undefined;
  if (!message || stringField(message, 'message_type') !== 'text') return undefined;

  const contentRaw = stringField(message, 'content');
  if (!contentRaw) return undefined;

  let text: string;
  try {
    const content = JSON.parse(contentRaw) as unknown;
    text = isRecord(content) && typeof content.text === 'string' ? content.text : '';
  } catch {
    return undefined;
  }

  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  for (const mention of mentions) {
    if (!isRecord(mention)) continue;
    const key = stringField(mention, 'key');
    if (!key) continue;
    text = text.split(key).join(' ');
  }

  text = text.replace(/\s+/g, ' ').trim();
  if (!text.startsWith('/')) return undefined;
  const eventKey = text.slice(1).trim();
  return eventKey || undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
