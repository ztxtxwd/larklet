import { listChatMessages, type ChatMessageItem } from '../feishu.js';
import type { AgentMention } from './types.js';

/** 历史里的一行。`bot` 是机器人自己发的。 */
export interface HistoryLine {
  role: 'user' | 'bot';
  text: string;
}

/** 提到人的最小形状。开放平台推的和历史里读的都算。 */
export interface MentionLike {
  key?: string;
  name?: string;
}

/**
 * 拉当前会话的历史消息。只取当前这条之前的，按时间正序。
 * 拉失败不影响这一轮 —— 调用方会省略历史块继续。
 */
export async function fetchChatHistory(opts: {
  accessToken: string;
  chatId: string;
  /** 只取这个时间（毫秒）之前的。 */
  beforeMs?: number;
  limit?: number;
  /** 要跳过的消息（当前这条）。 */
  excludeMessageId?: string;
  openApiBase?: string;
}): Promise<HistoryLine[]> {
  const items = await listChatMessages({
    accessToken: opts.accessToken,
    chatId: opts.chatId,
    beforeMs: opts.beforeMs,
    limit: opts.limit,
    openApiBase: opts.openApiBase,
  });

  const lines: HistoryLine[] = [];
  // 开放平台按时间倒序返回，模型看的历史要从旧到新。
  for (const item of [...items].reverse()) {
    const line = toHistoryLine(item, opts.excludeMessageId);
    if (line) lines.push(line);
  }
  return lines;
}

/** 历史渲染成给模型看的文本块。 */
export function renderHistory(lines: HistoryLine[]): string {
  return lines.map((line) => `${line.role === 'user' ? '用户' : '机器人'}: ${line.text}`).join('\n');
}

export function toHistoryLine(item: ChatMessageItem, excludeMessageId?: string): HistoryLine | undefined {
  if (!item.msg_type || item.deleted === true) return undefined;
  if (excludeMessageId && item.message_id === excludeMessageId) return undefined;
  const role: HistoryLine['role'] = item.sender?.sender_type === 'app' ? 'bot' : 'user';
  const text = parseMessageText(item.msg_type, item.body?.content, item.mentions);
  if (!text) return undefined;
  return { role, text };
}

/**
 * 消息正文。`text` 与 `post` 抽文字，`@_user_1` 这类占位符还原成 `@名字`，
 * 图片、文件这些非文本只留占位。
 */
export function parseMessageText(
  msgType: string | undefined,
  content: string | undefined,
  mentions?: MentionLike[],
): string {
  if (!msgType) return '';
  switch (msgType) {
    case 'text':
      return hydrateMentions(parseTextContent(content), mentions).trim();
    case 'post':
      return hydrateMentions(parsePostContent(content), mentions).trim();
    case 'image':
      return '[图片]';
    case 'file':
      return '[文件]';
    case 'audio':
      return '[语音]';
    case 'media':
    case 'video':
      return '[视频]';
    case 'sticker':
      return '[表情]';
    case 'interactive':
      return '[卡片]';
    default:
      return `[${msgType}]`;
  }
}

/** 从 mention 列表里读出占位符与被 @ 的人。 */
export function readMentions(raw: unknown): AgentMention[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentMention[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const key = typeof item.key === 'string' ? item.key : undefined;
    if (!key) continue;
    const id = isRecord(item.id) ? item.id : undefined;
    out.push({
      key,
      openId: typeof id?.open_id === 'string' ? id.open_id : undefined,
      name: typeof item.name === 'string' ? item.name : undefined,
    });
  }
  return out;
}

function parseTextContent(content: string | undefined): string {
  if (!content) return '';
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return '';
  }
}

function parsePostContent(content: string | undefined): string {
  if (!content) return '';
  try {
    const parsed = JSON.parse(content) as Record<string, { content?: unknown[][] } | undefined>;
    const locale = parsed.zh_cn ?? parsed.en_us ?? Object.values(parsed)[0];
    const parts: string[] = [];
    for (const paragraph of locale?.content ?? []) {
      for (const node of paragraph ?? []) {
        const tag = (node as { tag?: string }).tag;
        if (tag === 'text' || tag === 'a' || tag === 'md') {
          parts.push(String((node as { text?: string }).text ?? ''));
        } else if (tag === 'at') {
          parts.push(`@${(node as { user_name?: string }).user_name ?? ''}`);
        } else if (tag === 'img') {
          parts.push('[图片]');
        }
      }
      parts.push('\n');
    }
    return parts.join('');
  } catch {
    return '';
  }
}

/** 把正文里的 @ 占位符换成 `@名字`。 */
export function hydrateMentions(text: string, mentions?: MentionLike[]): string {
  let out = text;
  for (const mention of mentions ?? []) {
    if (!mention.key) continue;
    out = out.replaceAll(mention.key, `@${mention.name ?? ''}`);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
