import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const templateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../template');

/**
 * Agent 用的模型运行时。与 larklet 的可选 peer 依赖对齐：
 * 应用自己装这两个包，larklet 只在真的写了 `app/agent.ts` 时才加载它们。
 */
const AGENT_DEPENDENCIES: Record<string, string> = {
  '@earendil-works/pi-agent-core': '^0.84.3',
  '@earendil-works/pi-ai': '^0.84.3',
};

const AGENT_ENV = `
# 对话 Agent 用的模型，走 OpenAI 兼容接口。不用 Agent 的话可以删掉这几行。
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=
LLM_MODEL=gpt-4.1-mini
`;

/**
 * 模板里 larklet / larklet-web 的版本，跟随本包清单里的版本号。
 * 三个包同版本发布，所以这里写的就是它们当前的版本。
 */
function dependencyVersion(): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as {
    version: string;
  };
  return `^${manifest.version}`;
}

export interface ScaffoldResult {
  dest: string;
  name: string;
}

export interface ScaffoldOptions {
  /**
   * 一并生成对话 Agent：`apps/bot/app/agent.ts`，以及模型相关的依赖与环境变量。
   */
  agent?: boolean;
}

/** 把 bot + web 的 workspace 写到 `dest`。依赖取 npm 上的 larklet / larklet-web。 */
export function scaffold(destInput: string, options: ScaffoldOptions = {}): ScaffoldResult {
  const dest = path.resolve(destInput);
  const name = packageName(path.basename(dest));
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
    throw new Error(`目录已存在且非空：${dest}`);
  }

  const replace = {
    __APP_NAME__: name,
    __LARKLET_SPEC__: dependencyVersion(),
    __LARKLET_WEB_SPEC__: dependencyVersion(),
  };
  copyTemplate(templateRoot, dest, replace, new Set(['agent']));
  if (options.agent) applyAgent(dest, replace);
  return { dest, name };
}

/** 加上面具没写的东西：`app/agent.ts`、模型运行时依赖、模型环境变量。 */
function applyAgent(dest: string, replace: Record<string, string>): void {
  const source = path.join(templateRoot, 'agent/agent.ts');
  const target = path.join(dest, 'apps/bot/app/agent.ts');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, replaceTokens(fs.readFileSync(source, 'utf8'), replace));

  const pkgPath = path.join(dest, 'apps/bot/package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  pkg.dependencies = { ...pkg.dependencies, ...AGENT_DEPENDENCIES };
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const envPath = path.join(dest, '.env.example');
  fs.appendFileSync(envPath, AGENT_ENV);
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function packageName(dirName: string): string {
  const name = dirName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!name || !/^[a-z0-9]/.test(name)) throw new Error('目录名需要以字母或数字开头');
  return name;
}

function copyTemplate(from: string, to: string, replace: Record<string, string>, skip: Set<string>): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTemplate(source, target, replace, skip);
      continue;
    }
    const text = fs.readFileSync(source, 'utf8');
    fs.writeFileSync(target, replaceTokens(text, replace));
  }
}

function replaceTokens(text: string, replace: Record<string, string>): string {
  return Object.entries(replace).reduce((content, [token, value]) => content.split(token).join(value), text);
}
