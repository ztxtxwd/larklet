import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';

import { getModelRuntime } from './llm.js';
import type { LarkletAgentTool } from './types.js';

export interface TurnResult {
  /** 模型调用过 `reply_text`。 */
  delivered: boolean;
  /** 模型最后一段纯文本。工具没发出去时用它兜底。 */
  finalText: string;
  /** 这一轮被新消息中止了。 */
  aborted: boolean;
}

/**
 * 跑一轮对话。模型通过 `reply_text` 把回复发出去。
 *
 * 回落：模型没调工具、但吐了纯文本，就把那段当回复发出去；
 * 两者都没有就交给调用方发一句抱歉。
 */
export async function runAgentTurn(opts: {
  systemPrompt: string;
  userPrompt: string;
  /** 除 `reply_text` 之外的额外工具。 */
  tools: LarkletAgentTool[];
  /** 把这一轮的回复发回会话。 */
  send: (text: string) => Promise<void>;
  signal?: AbortSignal;
}): Promise<TurnResult> {
  const state = { delivered: false };

  const replyText: AgentTool = {
    name: 'reply_text',
    label: '回复文本',
    description: '向用户发送文字回复。所有沟通都通过这个工具完成。',
    parameters: Type.Object({
      content: Type.String({ description: '回复正文（纯文本）' }),
    }),
    execute: async (_id: unknown, raw: unknown) => {
      const params = raw as { content?: unknown };
      const content = typeof params.content === 'string' ? params.content : '';
      if (!content.trim()) throw new Error('content 不能为空');
      await opts.send(content);
      state.delivered = true;
      return { content: [{ type: 'text', text: '文本已发送。' }], details: {}, terminate: true };
    },
  };

  const tools: AgentTool[] = [
    replyText,
    ...(opts.tools as unknown as AgentTool[]),
  ];

  if (opts.signal?.aborted) return { delivered: false, finalText: '', aborted: true };

  const { model, streamFn } = getModelRuntime();
  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt,
      model,
      tools,
    },
    streamFn: streamFn as never,
  });

  const onAbort = (): void => agent.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  let finalText = '';
  try {
    await agent.prompt(opts.userPrompt);
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }

  for (let i = agent.state.messages.length - 1; i >= 0; i--) {
    const message = agent.state.messages[i];
    if (!message || message.role !== 'assistant') continue;
    finalText = message.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    break;
  }

  return { delivered: state.delivered, finalText, aborted: opts.signal?.aborted === true };
}
