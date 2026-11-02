import type { AgentRunner, ResolvedAgentConfig } from './types.js';

export interface AgentRunnerOptions {
  appId?: string;
  appSecret?: string;
}

/**
 * 运行时所在的模块。用变量形式的 specifier，TypeScript 就不会把它拉进调用方的编译单元 ——
 * 没装 `@earendil-works/pi-*` 的应用做类型检查时也不会报错。
 */
const RUNTIME: string = './index.js';

/**
 * 动态加载 Agent 运行时。
 *
 * `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 是可选依赖，
 * 只有应用真的写了 `app/agent.ts` 才会加载它们。
 */
export async function loadAgentRunner(
  config: ResolvedAgentConfig,
  options: AgentRunnerOptions = {},
): Promise<AgentRunner> {
  let mod: {
    createAgentRunner(config: ResolvedAgentConfig, options: AgentRunnerOptions): Promise<AgentRunner>;
  };
  try {
    mod = (await import(RUNTIME)) as typeof mod;
  } catch (error) {
    throw new Error(
      '使用 app/agent.ts 需要安装 @earendil-works/pi-agent-core 与 @earendil-works/pi-ai',
      { cause: error },
    );
  }
  return mod.createAgentRunner(config, options);
}
