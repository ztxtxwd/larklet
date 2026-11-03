import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createCompanionApp } from '../src/server.js';

test('读消息的类型：先用机器人身份，读不到再用用户身份', async () => {
  const calls: Array<{ url: string; authorization?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') ?? undefined });
    if (url.endsWith('/tenant_access_token/internal')) {
      return json({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
    }
    if (url.includes('/im/v1/messages/om_1')) {
      return json({
        code: 0,
        data: { items: [{ message_id: 'om_1', msg_type: 'interactive', body: { content: '{}' } }] },
      });
    }
    if (url.includes('/im/v1/messages/om_text')) {
      return json({
        code: 0,
        data: { items: [{ message_id: 'om_text', msg_type: 'text', body: { content: '{}' } }] },
      });
    }
    return json({ code: 404, msg: url }, 404);
  };

  const app = createCompanionApp({
    appId: 'cli_test',
    appSecret: 'secret',
    allowDirectMessageId: true,
    title: '收件箱',
    fetchImpl,
  });

  const config = await app.request('/api/config');
  assert.deepEqual(await config.json(), {
    ok: true,
    appId: 'cli_test',
    allowDirectMessageId: true,
    title: '收件箱',
    // 读消息只要 im:message；发消息才要 send_as_user。
    scopes: ['im:message'],
    sendScopes: ['im:message', 'im:message.send_as_user'],
  });

  const card = await app.request('/api/message', {
    method: 'POST',
    body: JSON.stringify({ messageId: 'om_1', userAccessToken: 'user-token' }),
  });
  assert.equal(card.status, 200);
  assert.deepEqual(await card.json(), { ok: true, messageId: 'om_1', msgType: 'interactive' });

  // 文本消息同样能读，快捷操作不再只认卡片。
  const text = await app.request('/api/message', {
    method: 'POST',
    body: JSON.stringify({ messageId: 'om_text', userAccessToken: 'user-token' }),
  });
  assert.equal(text.status, 200);
  assert.deepEqual(await text.json(), { ok: true, messageId: 'om_text', msgType: 'text' });

  // 给了用户身份就用用户身份读，不多请求一次令牌。
  const reads = calls.filter((call) => call.url.includes('/im/v1/messages/'));
  assert.equal(reads.length, 2);
  assert.ok(reads.every((call) => call.authorization === 'Bearer user-token'));
  assert.equal(calls.some((call) => call.url.endsWith('/tenant_access_token/internal')), false);

  // 没给用户身份：先用机器人身份读。机器人在会话里就不用麻烦用户授权。
  const asBot = await app.request('/api/message', {
    method: 'POST',
    body: JSON.stringify({ messageId: 'om_1' }),
  });
  assert.equal(asBot.status, 200);
  assert.deepEqual(await asBot.json(), { ok: true, messageId: 'om_1', msgType: 'interactive' });
  assert.ok(
    calls
      .filter((call) => call.url.includes('/im/v1/messages/'))
      .some((call) => call.authorization === 'Bearer tenant-token'),
  );

  const missing = await app.request('/api/message', {
    method: 'POST',
    body: JSON.stringify({ userAccessToken: 'user-token' }),
  });
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { ok: false, error: '缺少 messageId' });
});

test('换取用户身份并给网页签名', async () => {
  const calls: Array<{ url: string; authorization?: string; body?: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ url, authorization: headers.get('authorization') ?? undefined, body });
    if (url.endsWith('/tenant_access_token/internal')) {
      return json({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
    }
    if (url.endsWith('/app_access_token/internal')) {
      return json({ code: 0, app_access_token: 'app-token', expire: 7200 });
    }
    if (url.endsWith('/jssdk/ticket/get')) {
      return json({ code: 0, data: { ticket: 'ticket-1', expire_in: 7200 } });
    }
    if (url.endsWith('/oauth/v3/token')) {
      return json({ code: 0, access_token: 'user-token', expires_in: 100 });
    }
    if (url.endsWith('/authen/v1/user_info')) {
      return json({ code: 0, data: { open_id: 'ou_1', union_id: 'on_1', name: 'Ada', avatar_url: '' } });
    }
    return json({ code: 404, msg: url }, 404);
  };

  const app = createCompanionApp({
    appId: 'cli_test',
    appSecret: 'secret',
    fetchImpl,
  });

  const authed = await app.request('/api/auth/callback', {
    method: 'POST',
    body: JSON.stringify({ code: 'auth-code' }),
  });
  assert.deepEqual(await authed.json(), {
    ok: true,
    openId: 'ou_1',
    unionId: 'on_1',
    name: 'Ada',
    avatarUrl: '',
    accessToken: 'user-token',
    expiresIn: 100,
  });
  const exchange = calls.find((call) => call.url.endsWith('/oauth/v3/token'));
  assert.equal(exchange?.url, 'https://accounts.feishu.cn/oauth/v3/token');
  assert.deepEqual(exchange?.body, {
    grant_type: 'authorization_code',
    client_id: 'cli_test',
    client_secret: 'secret',
    code: 'auth-code',
  });
  assert.equal(exchange?.authorization, undefined);

  const signed = await app.request('/api/jsapi-signature', {
    method: 'POST',
    body: JSON.stringify({ url: 'https://bot.example/send?message_id=om_1' }),
  });
  const signature = await signed.json() as { ok: boolean; signature: string; nonceStr: string; timestamp: number };
  assert.equal(signature.ok, true);
  const raw = `jsapi_ticket=ticket-1&noncestr=${signature.nonceStr}&timestamp=${signature.timestamp}&url=https://bot.example/send?message_id=om_1`;
  assert.equal(signature.signature, createHash('sha1').update(raw).digest('hex'));
});

test('加号菜单按应用路径把新卡片发到当前会话', async () => {
  const calls: Array<{ url: string; body?: unknown; authorization?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ url, body, authorization: new Headers(init?.headers).get('authorization') ?? undefined });
    if (url.endsWith('/_larklet/apps')) {
      return json({
        apps: [
          { href: '/semantle', title: '猜词', description: '语义猜词', intro: '按语义猜一个中文词。' },
          { href: '//evil', title: '跳过', description: '' },
        ],
      });
    }
    if (url.endsWith('/tenant_access_token/internal')) {
      return json({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
    }
    if (url.endsWith('/_larklet/render')) {
      assert.deepEqual(body, { href: '/semantle' });
      return json({ card: { schema: '2.0', header: { title: { content: '猜词' } } } });
    }
    if (url.includes('/im/v1/messages?')) {
      return json({ code: 0, data: { message_id: 'om_app' } });
    }
    return json({ code: 404, msg: url }, 404);
  };

  const app = createCompanionApp({
    appId: 'cli_test',
    appSecret: 'secret',
    cardRenderUrl: 'http://larklet.test',
    fetchImpl,
  });

  const listed = await app.request('/api/apps');
  assert.deepEqual(await listed.json(), {
    ok: true,
    apps: [{ href: '/semantle', title: '猜词', description: '语义猜词', intro: '按语义猜一个中文词。' }],
  });

  const missing = await app.request('/api/apps/send', {
    method: 'POST',
    body: JSON.stringify({ href: '/missing', chatId: 'oc_1' }),
  });
  assert.equal(missing.status, 400);

  const sent = await app.request('/api/apps/send', {
    method: 'POST',
    body: JSON.stringify({ href: '/semantle', chatId: 'oc_1' }),
  });
  assert.deepEqual(await sent.json(), { ok: true, messageId: 'om_app' });
  const send = calls.find((call) => call.url.includes('/im/v1/messages?'));
  assert.deepEqual(send?.body, {
    receive_id: 'oc_1',
    msg_type: 'interactive',
    content: JSON.stringify({ schema: '2.0', header: { title: { content: '猜词' } } }),
  });
  // 不传 as 时仍按机器人身份发送。
  assert.equal(send?.authorization, 'Bearer tenant-token');

  const missingToken = await app.request('/api/apps/send', {
    method: 'POST',
    body: JSON.stringify({ href: '/semantle', chatId: 'oc_1', as: 'user' }),
  });
  assert.equal(missingToken.status, 400);
  assert.deepEqual(await missingToken.json(), { ok: false, error: '缺少用户授权，请先授权后重试' });

  const asUser = await app.request('/api/apps/send', {
    method: 'POST',
    body: JSON.stringify({ href: '/semantle', chatId: 'oc_2', as: 'user', userAccessToken: 'user-token' }),
  });
  assert.equal(asUser.status, 200);
  const userSend = calls.filter((call) => call.url.includes('/im/v1/messages?')).at(-1);
  assert.equal(userSend?.authorization, 'Bearer user-token');
  assert.deepEqual(userSend?.body, {
    receive_id: 'oc_2',
    msg_type: 'interactive',
    content: JSON.stringify({ schema: '2.0', header: { title: { content: '猜词' } } }),
  });
});

test('加号菜单用调用方提供的卡片，不再请求渲染地址', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/tenant_access_token/internal')) {
      return json({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
    }
    if (url.includes('/im/v1/messages?')) return json({ code: 0, data: { message_id: 'om_local' } });
    return json({ code: 404, msg: url }, 404);
  };
  const card = { schema: '2.0', header: { title: { content: '五子棋' } } };
  const app = createCompanionApp({
    appId: 'cli_test',
    appSecret: 'secret',
    fetchImpl,
    renderCard: async (href) => {
      if (href !== '/gomoku') throw new Error('没有这个应用');
      return JSON.stringify(card);
    },
  });
  const missing = await app.request('/api/apps/send', {
    method: 'POST',
    body: JSON.stringify({ href: '/missing', chatId: 'oc_1' }),
  });
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { ok: false, error: '没有这个应用' });
  const sent = await app.request('/api/apps/send', {
    method: 'POST',
    body: JSON.stringify({ href: '/gomoku', chatId: 'oc_1' }),
  });
  assert.deepEqual(await sent.json(), { ok: true, messageId: 'om_local' });
  assert.equal(calls.some((url) => url.includes('/_larklet/')), false);
});

test('免登申请的权限可以自己定', async () => {
  const app = createCompanionApp({
    appId: 'cli_test',
    appSecret: 'secret',
    scopes: ['im:message', 'im:message.group_msg:get_as_user'],
    sendScopes: ['im:message', 'im:message.send_as_user'],
  });
  const config = await app.request('/api/config');
  assert.deepEqual(await config.json(), {
    ok: true,
    appId: 'cli_test',
    allowDirectMessageId: false,
    title: '飞书应用',
    scopes: ['im:message', 'im:message.group_msg:get_as_user'],
    sendScopes: ['im:message', 'im:message.send_as_user'],
  });
});

test('机器人读不到消息时，让网页去要用户授权', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/tenant_access_token/internal')) {
      return json({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
    }
    // 机器人不在这个会话里，读不到。
    return json({ code: 99991679, msg: '机器人不在群组内' });
  };
  const app = createCompanionApp({ appId: 'cli_test', appSecret: 'secret', fetchImpl });

  const result = await app.request('/api/message', {
    method: 'POST',
    body: JSON.stringify({ messageId: 'om_1' }),
  });
  assert.equal(result.status, 200);
  const payload = (await result.json()) as { ok: boolean; needUserAuth?: boolean; error?: string };
  assert.equal(payload.ok, false);
  assert.equal(payload.needUserAuth, true);
  assert.ok(payload.error);
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
