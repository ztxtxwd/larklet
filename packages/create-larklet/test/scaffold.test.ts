import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { scaffold } from '../src/scaffold.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('生成包含 bot 与 web 的 workspace', () => {
  const dest = path.join(here, '../.tmp-scaffold');
  fs.rmSync(dest, { recursive: true, force: true });
  const rootVersion = JSON.parse(fs.readFileSync(path.join(here, '../package.json'), 'utf8')) as { version: string };
  try {
    const created = scaffold(path.join(dest, 'Inbox Demo'));
    assert.equal(created.name, 'inbox-demo');
    const root = JSON.parse(fs.readFileSync(path.join(created.dest, 'package.json'), 'utf8')) as { name: string };
    assert.equal(root.name, 'inbox-demo');
    const workspace = fs.readFileSync(path.join(created.dest, 'pnpm-workspace.yaml'), 'utf8');
    assert.match(workspace, /apps\/\*/);

    const bot = JSON.parse(fs.readFileSync(path.join(created.dest, 'apps/bot/package.json'), 'utf8')) as {
      dependencies: { larklet: string };
    };
    assert.equal(bot.dependencies.larklet, `^${rootVersion.version}`);

    const web = JSON.parse(fs.readFileSync(path.join(created.dest, 'apps/web/package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.equal(web.dependencies['larklet-web'], `^${rootVersion.version}`);
    // 模板不绑定组件库，预置页自带样式。
    assert.equal(web.dependencies['@douyinfe/semi-ui'], undefined);
    assert.equal(web.devDependencies['@semi-bot/semi-theme-universedesign'], undefined);
    // tsx watch 在 Windows 上拿不到终端 stdin（被 concurrently 接成管道）时会卡住，
    // 8788 永远不监听，所以用 Node 自带的 watch。
    assert.equal(web.scripts['dev:api'], 'node --watch --import tsx src/server.ts');
    // `NODE_ENV=x cmd` 只有 sh 认识，cmd/PowerShell 要用 cross-env。
    assert.equal(web.scripts['start'], 'cross-env NODE_ENV=production tsx src/server.ts');

    const vite = fs.readFileSync(path.join(created.dest, 'apps/web/vite.config.ts'), 'utf8');
    assert.doesNotMatch(vite, /semi/i);
    const app = fs.readFileSync(path.join(created.dest, 'apps/web/src/App.tsx'), 'utf8');
    assert.match(app, /MessagePage/);
    assert.match(app, /PlusPage/);
    for (const page of ['MessagePage.tsx', 'PlusPage.tsx']) {
      assert.match(fs.readFileSync(path.join(created.dest, 'apps/web/src', page), 'utf8'), /useCompanion/);
    }
    assert.match(fs.readFileSync(path.join(created.dest, '.gitignore'), 'utf8'), /node_modules/);

    const mcp = JSON.parse(fs.readFileSync(path.join(created.dest, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    assert.equal(mcp.mcpServers['feishu-doc'].command, 'npx');
    assert.deepEqual(mcp.mcpServers['feishu-doc'].args, ['feishu-doc-mcp@latest']);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('带 --agent 时生成对话 Agent 与模型配置', () => {
  const dest = path.join(here, '../.tmp-scaffold-agent');
  fs.rmSync(dest, { recursive: true, force: true });
  try {
    const created = scaffold(path.join(dest, 'Inbox Demo'), { agent: true });

    const agent = fs.readFileSync(path.join(created.dest, 'apps/bot/app/agent.ts'), 'utf8');
    assert.match(agent, /defineAgent/);
    assert.match(agent, /inbox-demo/);

    const bot = JSON.parse(fs.readFileSync(path.join(created.dest, 'apps/bot/package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.match(bot.dependencies['@earendil-works/pi-agent-core'], /^\^0\./);
    assert.match(bot.dependencies['@earendil-works/pi-ai'], /^\^0\./);

    const env = fs.readFileSync(path.join(created.dest, '.env.example'), 'utf8');
    assert.match(env, /LLM_BASE_URL=/);
    assert.match(env, /LLM_API_KEY=/);
    assert.match(env, /LLM_MODEL=/);

    // 模板里的 agent 素材不该被当成工程的一部分拷进去。
    assert.equal(fs.existsSync(path.join(created.dest, 'agent')), false);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});
