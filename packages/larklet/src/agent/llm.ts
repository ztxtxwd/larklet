import { createModels, createProvider, type Api, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL_ID = 'gpt-4.1-mini';
const PROVIDER_ID = 'openai-compat';

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

export interface ModelRuntime {
  model: Model<Api>;
  /** pi-agent-core 要的流式入口。 */
  streamFn: (...args: never[]) => unknown;
}

/**
 * 模型配置走 OpenAI 兼容接口。OpenAI、OpenRouter、DeepSeek、自建 vLLM 都能用。
 *
 * 环境变量优先认 `LARKLET_LLM_*`，其次是 lark-agent 那套 `LLM_*`，`.env` 可以直接搬。
 */
export function resolveModelConfig(): ModelConfig {
  const baseUrl = env('LARKLET_LLM_BASE_URL') ?? env('LLM_BASE_URL') ?? DEFAULT_BASE_URL;
  const apiKey = env('LARKLET_LLM_API_KEY') ?? env('LLM_API_KEY') ?? '';
  const modelId = env('LARKLET_LLM_MODEL') ?? env('LLM_MODEL') ?? DEFAULT_MODEL_ID;
  if (!apiKey) {
    throw new Error('Agent 需要模型密钥：请设置 LLM_API_KEY（或 LARKLET_LLM_API_KEY）');
  }
  return { baseUrl, apiKey, modelId };
}

const runtimes = new Map<string, ModelRuntime>();

/** 注册并取回模型。密钥不对时第一次调用会抛错。 */
export function getModelRuntime(): ModelRuntime {
  const config = resolveModelConfig();
  // 按 baseUrl + 模型名缓存：换一个接口就换一个 runtime。
  const key = `${config.baseUrl}\n${config.modelId}`;
  const cached = runtimes.get(key);
  if (cached) return cached;

  const openaiModel: Model<'openai-completions'> = {
    id: config.modelId,
    name: config.modelId,
    api: 'openai-completions',
    provider: PROVIDER_ID,
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };

  const models = createModels();
  models.setProvider(
    createProvider({
      id: PROVIDER_ID,
      name: 'OpenAI Compatible',
      baseUrl: config.baseUrl,
      auth: {
        apiKey: {
          name: 'LLM',
          resolve: async () => ({ auth: { apiKey: config.apiKey } }),
        },
      },
      models: [openaiModel],
      api: openAICompletionsApi(),
    }),
  );

  const model = models.getModel(PROVIDER_ID, config.modelId);
  if (!model) throw new Error(`未注册模型：${PROVIDER_ID}/${config.modelId}`);

  const runtime: ModelRuntime = {
    model: model as Model<Api>,
    streamFn: models.streamSimple.bind(models) as (...args: never[]) => unknown,
  };
  runtimes.set(key, runtime);
  return runtime;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}
