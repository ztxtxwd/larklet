import { defineAgent } from 'larklet';

/**
 * 对话 Agent。
 *
 * 用户发来没命中任何路由的消息时，由它来回复：私聊直接回，群里 @ 机器人才回。
 * 斜杠命令（`/xxx`）和机器人菜单仍然走卡片路由，不归它管。
 *
 * 模型走 OpenAI 兼容接口，配置在工程根目录的 `.env`：
 * `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`。
 */
export const agent = defineAgent({
  systemPrompt: [
    `你是 __APP_NAME__，一个飞书里的助手。`,
    '',
    '通过工具 reply_text 回复用户。用户能看到的只有你发给他的飞书消息。',
    '',
    '规则：',
    '- 跟随用户语言，简洁自然。',
    '- 只根据用户消息和对话上下文作答，不编造不确定的事实。',
    '- 必须调用 reply_text，用户才能看到回复。',
  ].join('\n'),
  /** 群聊里必须 @ 机器人才回复。私聊不用。 */
  requireMention: true,
  /** 每次回复带多少条历史。 */
  historyLimit: 30,
});
