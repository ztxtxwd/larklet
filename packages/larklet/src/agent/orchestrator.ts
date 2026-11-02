import { renderHistory, type HistoryLine } from './history.js';
import type { TurnResult } from './turn.js';
import type { AgentHandle, AgentMessage, LarkletAgentTool, ResolvedAgentConfig } from './types.js';

const FALLBACK_REPLY = '抱歉，刚刚处理消息时出了点问题，请稍后再试。';

export interface AgentRuntime {
  config: ResolvedAgentConfig;
  /** 发一条文字到会话。 */
  sendText(chatId: string, text: string): Promise<void>;
  /** 拉当前会话的历史（当前这条之前）。 */
  fetchHistory(chatId: string, beforeMs: number, excludeMessageId: string): Promise<HistoryLine[]>;
  /** 机器人自己的 open_id，用来认出「群里 @ 的是我」和「这条是我发的」。 */
  botOpenId(): Promise<string | undefined>;
  /** 给消息加一个处理中的表情，返回表情 id。 */
  addReaction(messageId: string): Promise<string | undefined>;
  /** 摘掉处理中的表情。 */
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  /** 跑一轮模型。 */
  runTurn(opts: {
    systemPrompt: string;
    userPrompt: string;
    tools: LarkletAgentTool[];
    send: (text: string) => Promise<void>;
    signal: AbortSignal;
  }): Promise<TurnResult>;
}

interface ActiveTurn {
  messageId: string;
  reactionId?: string;
  reactionRemoved: boolean;
  controller: AbortController;
}

/**
 * 轮次编排。
 *
 * 同一会话同时只跑一轮：新消息到了就中止上一轮，上一轮不再发消息。
 * 不同会话各跑各的。
 */
export class AgentOrchestrator implements AgentHandle {
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly turnChains = new Map<string, Promise<void>>();
  private readonly pending = new Set<Promise<void>>();
  /** 每个会话的消息计数。用来认出「这条消息已经被更新的消息顶掉了」。 */
  private readonly generations = new Map<string, number>();

  constructor(private readonly runtime: AgentRuntime) {}

  /** 没有在跑的轮次时 resolve。 */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  /** 跑一轮。 */
  async run(msg: AgentMessage): Promise<void> {
    // 先把计数记上 —— 后面要靠它认出「这一轮已经被更新的消息顶掉了」。
    const generation = (this.generations.get(msg.chatId) ?? 0) + 1;
    this.generations.set(msg.chatId, generation);

    // 新消息到了，同一会话上一轮就此中止，不再发消息。
    // 要在排队之前就中止 —— 等上一轮跑完再中止就没有意义了。
    void this.cancelActiveTurn(msg.chatId);

    const previous = this.turnChains.get(msg.chatId);
    const task = (previous ?? Promise.resolve())
      .then(() => this.runTurn(msg, generation))
      .catch((error) => {
        console.error('[larklet][agent] 处理失败', msg.chatId, msg.messageId, error);
      });
    this.turnChains.set(msg.chatId, task);
    this.pending.add(task);
    void task.then(
      () => {
        this.pending.delete(task);
        if (this.turnChains.get(msg.chatId) === task) this.turnChains.delete(msg.chatId);
      },
      () => {
        this.pending.delete(task);
      },
    );
  }

  private async runTurn(msg: AgentMessage, generation: number): Promise<void> {
    // 排到这儿时已经有更新的消息了，这一轮不必再跑。
    if (this.generations.get(msg.chatId) !== generation) return;

    const reactionId = await this.runtime.addReaction(msg.messageId);
    const turn: ActiveTurn = {
      messageId: msg.messageId,
      reactionId,
      reactionRemoved: false,
      controller: new AbortController(),
    };
    // 加表情这段时间里可能又来了新消息 —— 再认一次，别把上一轮的回复发出去。
    if (this.generations.get(msg.chatId) !== generation) {
      await this.removeOnItReactionOnce(turn);
      return;
    }
    this.activeTurns.set(msg.chatId, turn);
    try {
      await this.process(msg, turn.controller.signal);
    } catch (error) {
      console.error('[larklet][agent] 处理失败', msg.chatId, msg.messageId, error);
      if (!turn.controller.signal.aborted) {
        await this.runtime.sendText(msg.chatId, FALLBACK_REPLY).catch(() => {});
      }
    } finally {
      if (this.activeTurns.get(msg.chatId) === turn) this.activeTurns.delete(msg.chatId);
      await this.removeOnItReactionOnce(turn);
    }
  }

  private async process(msg: AgentMessage, signal: AbortSignal): Promise<void> {
    let historyBlock = '';
    try {
      const lines = await this.runtime.fetchHistory(msg.chatId, msg.createTime, msg.messageId);
      historyBlock = renderHistory(lines);
    } catch (error) {
      console.warn('[larklet][agent] 历史拉取失败', msg.chatId, error);
    }

    const userPrompt = [
      historyBlock ? `[最近聊天记录]\n${historyBlock}` : '',
      msg.replyToMessageId ? `[当前消息是对消息 ${msg.replyToMessageId} 的回复]` : '',
      `[用户消息]\n${msg.text}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const result = await this.runtime.runTurn({
      systemPrompt: this.runtime.config.systemPrompt,
      userPrompt,
      tools: this.runtime.config.tools,
      send: async (text) => {
        if (signal.aborted) return;
        await this.runtime.sendText(msg.chatId, text);
      },
      signal,
    });

    if (result.aborted) return;
    if (!result.delivered && result.finalText) {
      await this.runtime.sendText(msg.chatId, result.finalText);
      return;
    }
    if (!result.delivered) {
      await this.runtime.sendText(msg.chatId, FALLBACK_REPLY).catch(() => {});
    }
  }

  /** 中止同一会话还没跑完的轮次。 */
  private cancelActiveTurn(chatId: string): Promise<void> {
    const active = this.activeTurns.get(chatId);
    if (!active) return Promise.resolve();
    this.activeTurns.delete(chatId);
    active.controller.abort();
    return this.removeOnItReactionOnce(active);
  }

  private async removeOnItReactionOnce(turn: ActiveTurn): Promise<void> {
    if (!turn.reactionId || turn.reactionRemoved) return;
    turn.reactionRemoved = true;
    await this.runtime.removeReaction(turn.messageId, turn.reactionId).catch(() => {});
  }
}
