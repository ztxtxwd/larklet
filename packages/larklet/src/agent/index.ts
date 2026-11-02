import type { LarkletEvent } from '../events.js';
import {
  addMessageReaction,
  getBotIdentity,
  postText,
  removeMessageReaction,
  tenantAccessToken,
} from '../feishu.js';
import { fetchChatHistory } from './history.js';
import { AgentOrchestrator } from './orchestrator.js';
import { readAgentMessage, shouldHandleMessage } from './policy.js';
import { runAgentTurn } from './turn.js';
import type { AgentHandle, AgentMessage, AgentRunner, ResolvedAgentConfig } from './types.js';

export interface AgentRunnerOptions {
  appId?: string;
  appSecret?: string;
}

/**
 * 装好一个 Agent。
 *
 * 这个文件会 import `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai`，
 * 所以只能被动态 import —— 只有应用真的写了 `app/agent.ts` 才会加载。
 */
export async function createAgentRunner(
  config: ResolvedAgentConfig,
  options: AgentRunnerOptions = {},
): Promise<AgentRunner> {
  const credentials = (): { appId: string; appSecret: string } | undefined => {
    const appId = options.appId?.trim() || process.env.LARKLET_APP_ID || process.env.APP_ID;
    const appSecret = options.appSecret?.trim() || process.env.LARKLET_APP_SECRET || process.env.APP_SECRET;
    return appId && appSecret ? { appId, appSecret } : undefined;
  };

  const accessToken = async (): Promise<string | undefined> => {
    const creds = credentials();
    if (!creds) return undefined;
    try {
      return await tenantAccessToken(creds.appId, creds.appSecret);
    } catch (error) {
      console.warn('[larklet][agent] 获取 tenant_access_token 失败', error);
      return undefined;
    }
  };

  let botOpenIdCache: string | undefined;
  let botOpenIdPending: Promise<string | undefined> | undefined;

  const botOpenId = async (): Promise<string | undefined> => {
    if (botOpenIdCache) return botOpenIdCache;
    botOpenIdPending ??= (async () => {
      const token = await accessToken();
      if (!token) return undefined;
      try {
        const identity = await getBotIdentity({ accessToken: token });
        botOpenIdCache = identity.openId;
        return botOpenIdCache;
      } catch (error) {
        console.warn('[larklet][agent] 读取机器人身份失败', error);
        return undefined;
      }
    })();
    return botOpenIdPending;
  };

  const orchestrator = new AgentOrchestrator({
    config,
    async sendText(chatId, text) {
      const token = await accessToken();
      if (!token) throw new Error('发送消息需要配置 app_id 与 app_secret');
      await postText({ accessToken: token, receiveId: chatId, text, receiveIdType: 'chat_id' });
    },
    async fetchHistory(chatId, beforeMs, excludeMessageId) {
      const token = await accessToken();
      if (!token) return [];
      return fetchChatHistory({
        accessToken: token,
        chatId,
        beforeMs,
        limit: config.historyLimit,
        excludeMessageId,
      });
    },
    botOpenId,
    async addReaction(messageId) {
      const token = await accessToken();
      if (!token) return undefined;
      try {
        const reaction = await addMessageReaction({ accessToken: token, messageId, emojiType: 'OnIt' });
        return reaction.reactionId;
      } catch (error) {
        console.warn('[larklet][agent] 添加表情失败', error);
        return undefined;
      }
    },
    async removeReaction(messageId, reactionId) {
      const token = await accessToken();
      if (!token) return;
      await removeMessageReaction({ accessToken: token, messageId, reactionId });
    },
    runTurn: (turn) => runAgentTurn(turn),
  });

  return {
    idle: () => orchestrator.idle(),
    async handle(event: LarkletEvent): Promise<boolean> {
      const message = readAgentMessage(event);
      if (!message) return false;
      if (!shouldHandleMessage(message, config, await botOpenId())) return false;
      void orchestrator.run(message);
      return true;
    },
  };
}

export type { AgentHandle, AgentMessage, AgentRunner, ResolvedAgentConfig } from './types.js';
export { loadAgentConfig, normalizeAgentConfig } from './config.js';
export { defaultSystemPrompt, defineAgent } from './types.js';
export type { LarkletAgentConfig, LarkletAgentTool } from './types.js';
