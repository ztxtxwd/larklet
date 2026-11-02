import { existsSync } from 'node:fs';
import path from 'node:path';

import { importModule } from '../router.js';
import {
  defaultSystemPrompt,
  type LarkletAgentConfig,
  type LarkletAgentTool,
  type ResolvedAgentConfig,
} from './types.js';

const AGENT_FILES = ['agent.ts', 'agent.tsx', 'agent.jsx', 'agent.js'] as const;

const DEFAULT_HISTORY_LIMIT = 30;
const DEFAULT_STALE_THRESHOLD_MS = 300_000;

/** 每个文件一份缓存。key 是文件路径。 */
const cache = new Map<string, { raw: unknown; config: ResolvedAgentConfig }>();

/**
 * 读取 `app/agent.*`。
 *
 * ```ts
 * // app/agent.ts
 * export const agent = { systemPrompt: '你是订单助手' };
 * ```
 *
 * 也可以默认导出一个对象。返回 `undefined` 表示这个应用没有配置 Agent，
 * 没命中路由的消息照旧被忽略。
 */
export async function loadAgentConfig(appDir: string): Promise<ResolvedAgentConfig | undefined> {
  const file = AGENT_FILES.map((name) => path.join(appDir, name)).find((candidate) => existsSync(candidate));
  if (!file) return undefined;

  const mod = await importModule(file);
  const raw = mod.agent ?? mod.default;
  if (raw === undefined) throw new Error(`${file} 需要导出 agent 对象或默认配置`);
  if (!isRecord(raw)) throw new Error(`${file} 的 agent 需要是对象`);

  // importModule 按 mtime 换 URL，改过文件就会拿到新的模块对象。配置没动时沿用上次的归一化结果，
  // 好让调用方判断「配置变了没有」。
  const cached = cache.get(file);
  if (cached && cached.raw === raw) return cached.config;
  const config = normalizeAgentConfig(raw, file);
  cache.set(file, { raw, config });
  return config;
}

export function normalizeAgentConfig(raw: Record<string, unknown>, file = 'app/agent.ts'): ResolvedAgentConfig {
  const config = raw as LarkletAgentConfig & Record<string, unknown>;
  const botName = str(config.botName) ?? process.env.LARK_BOT_NAME?.trim() ?? 'Larklet';

  const tools = config.tools ?? [];
  if (!Array.isArray(tools)) throw new Error(`${file} 的 agent.tools 需要是数组`);
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== 'string' || !tool.name.trim()) {
      throw new Error(`${file} 的 agent.tools 里每个工具都需要 name`);
    }
    if (typeof tool.execute !== 'function') {
      throw new Error(`${file} 的 agent.tools 里的 ${tool.name} 需要 execute 函数`);
    }
  }

  return {
    systemPrompt: str(config.systemPrompt) ?? defaultSystemPrompt(botName),
    botName,
    requireMention: config.requireMention === undefined ? true : Boolean(config.requireMention),
    historyLimit: intOf(config.historyLimit) ?? DEFAULT_HISTORY_LIMIT,
    staleThresholdMs: intOf(config.staleThresholdMs) ?? DEFAULT_STALE_THRESHOLD_MS,
    tools: tools as LarkletAgentTool[],
  };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function intOf(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
