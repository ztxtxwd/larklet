import type { LarkletEvent } from '../events.js';
import { parseMessageText, readMentions } from './history.js';
import type { AgentMessage, ResolvedAgentConfig } from './types.js';

/** 只有这几种消息会交给 Agent。其它类型（系统消息、卡片消息等）直接跳过。 */
const HANDLED_MESSAGE_TYPES = new Set(['text', 'post', 'image']);

/**
 * 从飞书事件里读出一条消息。读不出正文时返回 `undefined`。
 *
 * 事件的形状（`im.message.receive_v1`，2.0 与 1.0 一致）：
 * - `sender.sender_type` / `sender.sender_id.open_id`
 * - `message.message_id` / `chat_id` / `chat_type` / `message_type`
 * - `message.content` 是 JSON 字符串
 * - `message.mentions[]`：`{ key, id: { open_id }, name }`
 * - `message.create_time` 毫秒
 */
export function readAgentMessage(event: LarkletEvent): AgentMessage | undefined {
  const body = event.event;
  if (!isRecord(body)) return undefined;
  const message = isRecord(body.message) ? body.message : undefined;
  if (!message) return undefined;

  const messageType = stringField(message, 'message_type');
  if (!messageType || !HANDLED_MESSAGE_TYPES.has(messageType)) return undefined;

  const mentions = readMentions(message.mentions);
  const text = parseMessageText(messageType, stringField(message, 'content'), mentions);
  if (!text.trim()) return undefined;

  const sender = isRecord(body.sender) ? body.sender : undefined;
  const senderId = isRecord(sender?.sender_id) ? sender.sender_id : sender;

  const createTime = Number(stringField(message, 'create_time') ?? '');

  return {
    messageId: stringField(message, 'message_id') ?? '',
    chatId: stringField(message, 'chat_id') ?? '',
    chatType: stringField(message, 'chat_type') ?? '',
    senderId: stringField(senderId ?? {}, 'open_id'),
    senderType: stringField(sender ?? {}, 'sender_type'),
    text,
    mentions,
    createTime: Number.isFinite(createTime) ? createTime : 0,
    replyToMessageId: stringField(message, 'parent_id') ?? stringField(message, 'root_id'),
  };
}

/**
 * 这条消息要不要交给 Agent。
 *
 * - 机器人自己发的、别的机器人发的，一律不回（否则两个机器人会对着 @ 来回刷）。
 * - 过期的事件不回。
 * - 群里必须 @ 机器人。私聊不用。
 */
export function shouldHandleMessage(
  msg: AgentMessage,
  config: ResolvedAgentConfig,
  botOpenId?: string,
): boolean {
  if (!msg.chatId) return false;

  // 发送者不是人：机器人回声、别的机器人的消息、系统消息都不进模型。
  if (msg.senderType && msg.senderType !== 'user') return false;
  if (botOpenId && msg.senderId === botOpenId) return false;

  // 过期事件。飞书重投或者队列积压时会出现。
  if (config.staleThresholdMs > 0 && msg.createTime > 0) {
    if (Date.now() - msg.createTime > config.staleThresholdMs) return false;
  }

  // 群里必须 @ 机器人。私聊直接说就行。
  // 认不出机器人自己（bot/v3/info 没调通）时宁可不回，也不去接每一条群消息。
  if (config.requireMention && msg.chatType === 'group') {
    const mentioned = msg.mentions.some((mention) => Boolean(botOpenId) && mention.openId === botOpenId);
    if (!mentioned) return false;
  }

  return true;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
