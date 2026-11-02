/**
 * 对话 Agent 的配置与运行时类型。
 *
 * 这里刻意不 import `@earendil-works/pi-agent-core`：larklet 主入口不该让没装 pi 的应用
 * 在类型检查时也去找这两个包。工具用结构化类型描述，与 pi 的 `AgentTool` 兼容。
 */

import type { LarkletEvent } from '../events.js';

/** 额外工具。结构与 `@earendil-works/pi-agent-core` 的 `AgentTool` 对齐。 */
export interface LarkletAgentTool {
  /** 工具名，模型用它来调用。 */
  name: string;
  /** 给人看的名字。 */
  label?: string;
  /** 给模型看的说明，写清楚什么时候该用。 */
  description?: string;
  /** 参数的 JSON Schema。 */
  parameters?: unknown;
  /** 执行工具。抛错会被当成工具失败回给模型。 */
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): unknown;
}

/** `app/agent.ts` 里可以写的东西。 */
export interface LarkletAgentConfig {
  /** 人设与回复规矩。留空时用默认提示词。 */
  systemPrompt?: string;
  /** 机器人名字，会出现在默认提示词里。默认读 `LARK_BOT_NAME`，再没有就是 `Larklet`。 */
  botName?: string;
  /** 群聊里必须 @ 机器人才回复。默认 true。私聊不受影响。 */
  requireMention?: boolean;
  /** 每次回复带多少条历史。默认 30。 */
  historyLimit?: number;
  /** 超过这个时间的消息不处理（毫秒）。默认 5 分钟。 */
  staleThresholdMs?: number;
  /** 除内置的 `reply_text` 之外，额外给模型用的工具。 */
  tools?: LarkletAgentTool[];
}

/** 归一化之后的配置：字段都有默认值。 */
export interface ResolvedAgentConfig {
  systemPrompt: string;
  botName: string;
  requireMention: boolean;
  historyLimit: number;
  staleThresholdMs: number;
  tools: LarkletAgentTool[];
}

/** 跑起来的 Agent。 */
export interface AgentHandle {
  /** 没有在跑的轮次时 resolve。退出前等它，可以避免回复发不出去。 */
  idle(): Promise<void>;
}

/** 装好的 Agent。核心用它把消息交给 Agent。 */
export interface AgentRunner extends AgentHandle {
  /** 这条事件要不要交给 Agent。返回 true 表示已经接管，不再走默认分发。 */
  handle(event: LarkletEvent): Promise<boolean>;
}

/** 从飞书事件里读出来的一条消息。 */
export interface AgentMessage {
  messageId: string;
  chatId: string;
  /** `p2p` / `group`。 */
  chatType: string;
  senderId?: string;
  /** 飞书的 `sender.sender_type`：`user` / `app` / `bot` / `system` … */
  senderType?: string;
  /** 已经把 @ 占位符换成人名的正文。 */
  text: string;
  mentions: AgentMention[];
  /** 毫秒时间戳。 */
  createTime: number;
  /** 用户回复的那条消息。 */
  replyToMessageId?: string;
}

export interface AgentMention {
  /** 消息正文里的占位符，例如 `@_user_1`。 */
  key: string;
  openId?: string;
  name?: string;
}

/** 身份函数，纯粹为了给 `app/agent.ts` 一个类型出口。 */
export function defineAgent<T extends LarkletAgentConfig>(config: T): T {
  return config;
}

/** 默认提示词。工具只有 `reply_text`，回复是纯文本。 */
export function defaultSystemPrompt(botName: string): string {
  return `你是 ${botName}，一个飞书对话助手。

通过工具回复用户。用户能看到的只有你发给他的飞书消息。

工具：
- reply_text：发送文字回复。content 写要发给用户的正文。

规则：
- 跟随用户语言，简洁自然。
- 只根据用户消息和对话上下文作答，不编造不确定的事实。
- 必须调用 reply_text，用户才能看到回复。`;
}
