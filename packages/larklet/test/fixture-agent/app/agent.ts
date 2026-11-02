import { defineAgent } from '../../../src/index.js';

export const agent = defineAgent({
  systemPrompt: '你是测试机器人',
  requireMention: true,
});
