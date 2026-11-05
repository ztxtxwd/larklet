import assert from 'node:assert/strict';
import test from 'node:test';

import { CompanionSession } from '../src/client/session.js';

interface Call {
  url: string;
  body?: Record<string, unknown>;
}

function fakeFetch(handler: (url: string, init?: RequestInit) => unknown): typeof fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) });
    return new Response(JSON.stringify(handler(url, init)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch & { calls: Call[] };
  impl.calls = calls;
  return impl;
}

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    appId: 'cli_test',
    allowDirectMessageId: false,
    title: '测试应用',
    scopes: ['im:message'],
    sendScopes: ['im:message', 'im:message.send_as_user'],
    ...overrides,
  };
}

test('不在飞书里时，加号菜单只加载配置与应用目录', async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url === '/api/config') return config({ previewUrl: 'http://127.0.0.1:8787' });
    if (url === '/api/apps') return { ok: true, apps: [{ href: '/ticket', title: '工单', description: '' }] };
    throw new Error(`unexpected ${url}`);
  });
  const session = new CompanionSession({
    url: new URL('http://localhost/plus'),
    userAgent: 'node',
    fetchImpl,
  });

  await session.start();
  const state = session.getState();

  assert.equal(state.ready, true);
  assert.equal(state.loading, false);
  assert.equal(state.scene, 'plus');
  assert.equal(state.inFeishu, false);
  assert.equal(state.preview, true);
  assert.equal(state.apps.length, 1);
  assert.equal(state.error, '');
});

test('不在飞书里时，?message_id= 先用机器人身份读消息类型', async () => {
  const fetchImpl = fakeFetch((url, init) => {
    if (url === '/api/config') return config({ allowDirectMessageId: true });
    if (url === '/api/message') {
      const body = JSON.parse(String(init?.body)) as { userAccessToken?: string };
      assert.equal(body.userAccessToken, '');
      return { ok: true, messageId: 'om_source', msgType: 'image' };
    }
    throw new Error(`unexpected ${url}`);
  });
  const session = new CompanionSession({
    url: new URL('http://localhost/message?message_id=om_source'),
    userAgent: 'node',
    fetchImpl,
  });

  await session.start();
  const state = session.getState();

  assert.equal(state.message.messageId, 'om_source');
  assert.equal(state.message.msgType, 'image');
  assert.equal(state.message.needUserAuth, false);
});

test('机器人读不到消息时，标记需要用户授权', async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url === '/api/config') return config({ allowDirectMessageId: true });
    if (url === '/api/message') return { ok: false, error: '机器人不在会话里' };
    throw new Error(`unexpected ${url}`);
  });
  const session = new CompanionSession({
    url: new URL('http://localhost/message?message_id=om_source'),
    userAgent: 'node',
    fetchImpl,
  });

  await session.start();
  const state = session.getState();

  assert.equal(state.message.needUserAuth, true);
  assert.equal(state.message.messageId, 'om_source');
  assert.match(state.user.error, /飞书客户端/);
});

test('本地预览把卡片发到模拟群', async () => {
  const fetchImpl = fakeFetch((url, init) => {
    if (url === '/api/config') return config({ previewUrl: 'http://127.0.0.1:8787' });
    if (url === '/api/apps') return { ok: true, apps: [] };
    if (url === '/api/preview/deliver') {
      const body = JSON.parse(String(init?.body)) as { href?: string };
      assert.equal(body.href, '/ticket');
      return { ok: true, messageId: 'om_preview' };
    }
    throw new Error(`unexpected ${url}`);
  });
  const session = new CompanionSession({
    url: new URL('http://localhost/plus'),
    userAgent: 'node',
    fetchImpl,
  });
  await session.start();

  const result = await session.sendApp('/ticket', { as: 'bot', target: 'current' });
  assert.equal(result.ok, true);
  assert.equal(result.messageId, 'om_preview');

  // 本地预览没有用户身份，只能以机器人身份发送。
  const blocked = await session.sendApp('/ticket', { as: 'user', target: 'current' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /机器人身份/);
});
