import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLarklet } from '../src/app.js';
import { fakeOpenApi, lastUserText, withEnv, type FakeOpenApi } from './helpers/fake-open-api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentFixture = path.join(here, 'fixture-agent');

const PAGE = 'export default function Page() { return null; }\n';
const AGENT = "export const agent = { systemPrompt: '你是测试机器人' };\n";

interface Fixture {
  root: string;
  cleanup: () => Promise<void>;
}

async function makeApp(files: Record<string, string>): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'larklet-agent-'));
  await fs.mkdir(path.join(root, 'app'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, 'app', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

/** 一条用户发来的文本消息。 */
function messageEvent(options: {
  text: string;
  messageId?: string;
  chatId?: string;
  chatType?: string;
  mentions?: unknown[];
  senderType?: string;
  createTime?: string;
}): Record<string, unknown> {
  return {
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1', token: 'tok', event_id: 'ev_1' },
    event: {
      sender: {
        sender_id: { open_id: 'ou_user' },
        sender_type: options.senderType ?? 'user',
        tenant_key: 't_key',
      },
      message: {
        message_id: options.messageId ?? 'om_1',
        chat_id: options.chatId ?? 'oc_dm',
        chat_type: options.chatType ?? 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: options.text }),
        create_time: options.createTime ?? String(Date.now()),
        ...(options.mentions ? { mentions: options.mentions } : {}),
      },
    },
  };
}

async function withAgent<T>(api: FakeOpenApi, fn: () => Promise<T>): Promise<T> {
  return withEnv(
    {
      LARK_DOMAIN: api.base,
      LARKLET_APP_ID: 'cli_agent',
      LARKLET_APP_SECRET: 'secret_agent',
      APP_ID: undefined,
      APP_SECRET: undefined,
      LLM_BASE_URL: `${api.base}/v1`,
      LLM_API_KEY: 'test-key',
      LLM_MODEL: 'gpt-4.1-mini',
      LARKLET_LLM_BASE_URL: undefined,
      LARKLET_LLM_API_KEY: undefined,
      LARKLET_LLM_MODEL: undefined,
    },
    fn,
  );
}

test('没命中路由的消息由 Agent 应答', async () => {
  const api = await fakeOpenApi({ reply: '收到你的消息了' });
  const fixture = await makeApp({ 'page.tsx': PAGE, 'agent.ts': AGENT });
  try {
    await withAgent(api, async () => {
      const app = await createLarklet({ dir: fixture.root });
      const handled = await app.handle(messageEvent({ text: '你好' }));

      assert.equal(handled.type, 'raw');
      if (handled.type !== 'raw') return;
      assert.equal(handled.eventType, 'im.message.receive_v1');
      assert.deepEqual(handled.response, { code: 0 });

      await app.agent.idle();

      assert.equal(api.calls.length, 1);
      assert.match(api.calls[0].url, /receive_id_type=chat_id/);
      assert.deepEqual(api.calls[0].body, {
        receive_id: 'oc_dm',
        msg_type: 'text',
        content: JSON.stringify({ text: '收到你的消息了' }),
      });
    });
  } finally {
    await api.close();
    await fixture.cleanup();
  }
});

test('斜杠命令仍然走路由，不交给 Agent', async () => {
  const api = await fakeOpenApi();
  const fixture = await makeApp({
    'page.tsx': PAGE,
    'agent.ts': AGENT,
    'item/[id]/page.tsx': "export default function Page() { return null; }\n",
  });
  try {
    await withAgent(api, async () => {
      const app = await createLarklet({ dir: fixture.root });
      const handled = await app.handle(messageEvent({ text: '/item/42' }));

      assert.equal(handled.type, 'menu');
      if (handled.type !== 'menu') return;
      assert.equal(handled.eventKey, 'item/42');

      await app.agent.idle();
      assert.equal(api.calls.length, 0);
    });
  } finally {
    await api.close();
    await fixture.cleanup();
  }
});

test('app/events.ts 注册的处理函数优先，Agent 不介入', async () => {
  const api = await fakeOpenApi();
  const fixture = await makeApp({
    'page.tsx': PAGE,
    'agent.ts': AGENT,
    'events.ts':
      "export const events = { 'im.message.receive_v1': async () => ({ code: 0, taken: true }) };\n",
  });
  try {
    await withAgent(api, async () => {
      const app = await createLarklet({ dir: fixture.root });
      const handled = await app.handle(messageEvent({ text: '你好' }));

      assert.equal(handled.type, 'raw');
      if (handled.type !== 'raw') return;
      assert.deepEqual(handled.response, { code: 0, taken: true });

      await app.agent.idle();
      assert.equal(api.calls.length, 0);
    });
  } finally {
    await api.close();
    await fixture.cleanup();
  }
});

test('群聊里没 @ 机器人就不回', async () => {
  const api = await fakeOpenApi();
  const fixture = await makeApp({ 'page.tsx': PAGE, 'agent.ts': AGENT });
  try {
    await withAgent(api, async () => {
      const app = await createLarklet({ dir: fixture.root });
      const handled = await app.handle(messageEvent({ text: '大家好', chatType: 'group' }));

      assert.equal(handled.type, 'empty');
      await app.agent.idle();
      assert.equal(api.calls.length, 0);
    });
  } finally {
    await api.close();
    await fixture.cleanup();
  }
});

test('群聊里 @ 了机器人就回', async () => {
  const api = await fakeOpenApi({ reply: '在的' });
  const fixture = await makeApp({ 'page.tsx': PAGE, 'agent.ts': AGENT });
  try {
    await withAgent(api, async () => {
      const app = await createLarklet({ dir: fixture.root });
      const handled = await app.handle(
        messageEvent({
          text: '@_user_1 你好',
          chatType: 'group',
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '机器人' }],
        }),
      );

      assert.equal(handled.type, 'raw');
      await app.agent.idle();
      assert.equal(api.calls.length, 1);
      assert.deepEqual((api.calls[0].body as { content: string }).content, JSON.stringify({ text: '在的' }));
    });
  } finally {
    await api.close();
    await fixture.cleanup();
  }
});

test('机器人自己发的消息不回复', async () => {
  const api = await fakeOpenApi();
  const fixture = await makeApp({ 'page.tsx': PAGE, 'agent.ts': AGENT });
  try {
    await withAgent(api, async () => {
      const app = await createLarklet({ dir: fixture.root });
      const handled = await app.handle(messageEvent({ text: '你好', senderType: 'app' }));

      assert.equal(handled.type, 'empty');
      await app.agent.idle();
      assert.equal(api.calls.length, 0);
    });
  } finally {
    await api.close();
    await fixture.cleanup();
  }
});

test('过期的消息不回复', async () => {
  const api = await fakeOpenApi();
  const fixture = await makeApp({ 'page.tsx': PAGE, 'agent.ts': AGENT });
  try {
    await withAgent(api, async () => {
      const app = await createLarklet({ dir: fixture.root });
      const handled = await app.handle(
        messageEvent({ text: '你好', createTime: String(Date.now() - 60 * 60 * 1000) }),
      );

      assert.equal(handled.type, 'empty');
      await app.agent.idle();
      assert.equal(api.calls.length, 0);
    });
  } finally {
    await api.close();
    await fixture.cleanup();
  }
});

test('没有 app/agent.ts 时行为不变，消息被忽略', async () => {
  const api = await fakeOpenApi();
  const fixture = await makeApp({ 'page.tsx': PAGE });
  try {
    await withAgent(api, async () => {
      const app = await createLarklet({ dir: fixture.root });
      const handled = await app.handle(messageEvent({ text: '你好' }));

      assert.equal(handled.type, 'empty');
      await app.agent.idle();
      assert.equal(api.calls.length, 0);
    });
  } finally {
    await api.close();
    await fixture.cleanup();
  }
});

test('app/agent.ts 用 defineAgent 从包入口配置', async () => {
  const api = await fakeOpenApi({ reply: '好的' });
  try {
    await withAgent(api, async () => {
      const app = await createLarklet({ dir: agentFixture });
      const handled = await app.handle(messageEvent({ text: '你好' }));

      assert.equal(handled.type, 'raw');
      await app.agent.idle();
      assert.equal(api.calls.length, 1);
      assert.deepEqual((api.calls[0].body as { content: string }).content, JSON.stringify({ text: '好的' }));
    });
  } finally {
    await api.close();
  }
});

test('同一会话里新消息到了，上一轮让位，只回最新那条', async () => {
  const api = await fakeOpenApi({ echoPrompt: true });
  const fixture = await makeApp({ 'page.tsx': PAGE, 'agent.ts': AGENT });
  try {
    await withAgent(api, async () => {
      const app = await createLarklet({ dir: fixture.root });

      await app.handle(messageEvent({ text: '第一句', messageId: 'om_1' }));
      // 上一轮还没问完模型，同一会话又来一条 —— 上一轮就此作罢。
      await app.handle(messageEvent({ text: '第二句', messageId: 'om_2' }));

      await app.agent.idle();

      assert.equal(api.calls.length, 1);
      const content = (api.calls[0].body as { content: string }).content;
      assert.match(content, /第二句/);
      assert.doesNotMatch(content, /第一句/);
    });
  } finally {
    await api.close();
    await fixture.cleanup();
  }
});

test('上一轮正在问模型时来了新消息，上一轮中止，只回最新那条', async () => {
  const api = await fakeOpenApi({ echoPrompt: true, llmDelayMs: 300 });
  const fixture = await makeApp({ 'page.tsx': PAGE, 'agent.ts': AGENT });
  try {
    await withAgent(api, async () => {
      const app = await createLarklet({ dir: fixture.root });

      await app.handle(messageEvent({ text: '第一句', messageId: 'om_1' }));
      // 等第一轮真的问上模型了，再来一条新消息。
      await api.waitForLlm(1);
      await app.handle(messageEvent({ text: '第二句', messageId: 'om_2' }));

      await app.agent.idle();

      // 两轮都问过模型，但只有最新那条回了话。
      assert.equal(api.llmRequests.length, 2);
      assert.equal(api.calls.length, 1);
      const content = (api.calls[0].body as { content: string }).content;
      assert.match(content, /第二句/);
      assert.doesNotMatch(content, /第一句/);
    });
  } finally {
    await api.close();
    await fixture.cleanup();
  }
});

test('不同会话互不影响，各自都回', async () => {
  const api = await fakeOpenApi({ llmDelayMs: 50 });
  const fixture = await makeApp({ 'page.tsx': PAGE, 'agent.ts': AGENT });
  try {
    await withAgent(api, async () => {
      const app = await createLarklet({ dir: fixture.root });

      await app.handle(messageEvent({ text: '甲', messageId: 'om_1' }));
      await app.handle(messageEvent({ text: '乙', messageId: 'om_2', chatId: 'oc_other' }));

      await app.agent.idle();

      assert.equal(api.calls.length, 2);
      const chats = api.calls.map((call) => (call.body as { receive_id: string }).receive_id).sort();
      assert.deepEqual(chats, ['oc_dm', 'oc_other']);
    });
  } finally {
    await api.close();
    await fixture.cleanup();
  }
});

test('会话历史按时间正序进提示词，当前这条不算历史', async () => {
  const api = await fakeOpenApi({
    echoPrompt: true,
    // 开放平台是倒序返回的。
    history: [
      { message_id: 'om_2', msg_type: 'text', body: { content: JSON.stringify({ text: '后说的' }) }, sender: { sender_type: 'user' } },
      { message_id: 'om_1', msg_type: 'text', body: { content: JSON.stringify({ text: '当前这条' }) }, sender: { sender_type: 'user' } },
      { message_id: 'om_0', msg_type: 'text', body: { content: JSON.stringify({ text: '先说的' }) }, sender: { sender_type: 'user' } },
    ],
  });
  const fixture = await makeApp({ 'page.tsx': PAGE, 'agent.ts': AGENT });
  try {
    await withAgent(api, async () => {
      const app = await createLarklet({ dir: fixture.root });
      await app.handle(messageEvent({ text: '当前这条', messageId: 'om_1' }));
      await app.agent.idle();

      assert.equal(api.llmRequests.length, 1);
      const prompt = lastUserText(api.llmRequests[0]);
      assert.ok(prompt.includes('先说的'), '历史里应该有更早的消息');
      assert.ok(prompt.includes('后说的'), '历史里应该有更晚的消息');
      assert.ok(
        prompt.indexOf('先说的') < prompt.indexOf('后说的'),
        '历史应该从旧到新',
      );
      // 当前这条只出现在「用户消息」里，不该出现在历史里。
      assert.equal(prompt.split('当前这条').length - 1, 1);
    });
  } finally {
    await api.close();
    await fixture.cleanup();
  }
});
