import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { rawToDsl } from '@open-feishu-card/adapter';
import { encodeStateUrl } from '@open-feishu-card/store';

import { interactiveCardTitle } from '../src/feishu.js';
import { createCompanionApp } from '../src/server.js';

const rawCard = {
  json_card: JSON.stringify({
    schema: '2.0',
    header: {
      tag: 'card_header',
      property: {
        title: { tag: 'plain_text', property: { content: '请假' } },
      },
    },
    body: { tag: 'body', property: { elements: [] } },
  }),
  json_attachment: {},
  card_schema: 2,
};
const card = rawToDsl(rawCard);

test('从卡片页眉读取标题', () => {
  assert.equal(interactiveCardTitle(card), '请假');
  assert.equal(interactiveCardTitle({ header: { title: '审批' } }), '审批');
  assert.equal(interactiveCardTitle({}), undefined);
});

test('读取卡片并以机器人或用户身份发送', async () => {
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
    if (url.endsWith('/authen/v1/access_token')) {
      return json({
        code: 0,
        data: { open_id: 'ou_1', name: 'Ada', avatar_url: '', access_token: 'user-token', expires_in: 100 },
      });
    }
    if (url.includes('/im/v1/messages/om_1')) {
      return json({
        code: 0,
        data: { items: [{ message_id: 'om_1', msg_type: 'interactive', body: { content: JSON.stringify(rawCard) } }] },
      });
    }
    if (url.includes('/im/v1/messages/om_text')) {
      return json({
        code: 0,
        data: { items: [{ message_id: 'om_text', msg_type: 'text', body: { content: '{}' } }] },
      });
    }
    if (url.includes('/im/v1/messages?')) {
      return json({ code: 0, data: { message_id: 'om_sent' } });
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
  });

  const loaded = await app.request('/api/card', {
    method: 'POST',
    body: JSON.stringify({ messageId: 'om_1' }),
  });
  assert.equal(loaded.status, 200);
  assert.deepEqual(await loaded.json(), { ok: true, messageId: 'om_1', msgType: 'interactive', title: '请假' });

  const asBot = await app.request('/api/card/send', {
    method: 'POST',
    body: JSON.stringify({ messageId: 'om_1', chatId: 'oc_1', as: 'bot' }),
  });
  assert.deepEqual(await asBot.json(), { ok: true, messageId: 'om_sent' });

  const missingUser = await app.request('/api/card/send', {
    method: 'POST',
    body: JSON.stringify({ messageId: 'om_1', chatId: 'oc_1', as: 'user' }),
  });
  assert.equal(missingUser.status, 400);

  const authed = await app.request('/api/auth/callback', {
    method: 'POST',
    body: JSON.stringify({ code: 'auth-code' }),
  });
  assert.equal((await authed.json() as { accessToken: string }).accessToken, 'user-token');

  const asUser = await app.request('/api/card/send', {
    method: 'POST',
    body: JSON.stringify({ messageId: 'om_1', chatId: 'oc_1', as: 'user', userAccessToken: 'user-token' }),
  });
  assert.equal(asUser.status, 200);

  const reads = calls.filter((call) => call.url.includes('/im/v1/messages/om_1'));
  assert.ok(reads.every((call) => call.url.includes('card_msg_content_type=raw_card_content')));

  const sends = calls.filter((call) => call.url.includes('/im/v1/messages?'));
  assert.equal(sends.length, 2);
  assert.equal(sends[0]?.authorization, 'Bearer tenant-token');
  assert.equal(sends[1]?.authorization, 'Bearer user-token');
  assert.deepEqual(sends[0]?.body, {
    receive_id: 'oc_1',
    msg_type: 'interactive',
    content: JSON.stringify(card),
  });

  const signed = await app.request('/api/jsapi-signature', {
    method: 'POST',
    body: JSON.stringify({ url: 'https://bot.example/send?message_id=om_1' }),
  });
  const signature = await signed.json() as { ok: boolean; signature: string; nonceStr: string; timestamp: number };
  assert.equal(signature.ok, true);
  const raw = `jsapi_ticket=ticket-1&noncestr=${signature.nonceStr}&timestamp=${signature.timestamp}&url=https://bot.example/send?message_id=om_1`;
  assert.equal(signature.signature, createHash('sha1').update(raw).digest('hex'));

  const text = await app.request('/api/card', {
    method: 'POST',
    body: JSON.stringify({ messageId: 'om_text' }),
  });
  assert.equal(text.status, 502);
  assert.match((await text.json() as { error: string }).error, /不是卡片/);
});

test('发送时丢掉对局状态，只按应用路径重新开一张卡片', async () => {
  const stateUrl = encodeStateUrl({
    v: 1,
    pattern: '/framed',
    pathname: '/framed',
    params: {},
    search: { from: 'share' },
    state: { play: { status: 'won' } },
  });
  const sealed = {
    json_card: JSON.stringify({
      schema: '2.0',
      body: {
        tag: 'body',
        property: {
          elements: [
            {
              id: 'card_state',
              tag: 'column_set',
              property: {
                actions: [{ type: 'open_url', action: { url: stateUrl } }],
                columns: [{ tag: 'column', property: { width: 'auto', elements: [] } }],
              },
            },
          ],
        },
      },
    }),
    json_attachment: {},
    card_schema: 2,
  };
  const revived = { schema: '2.0', header: { title: { content: '续玩' } }, body: { elements: [] } };
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/tenant_access_token/internal')) {
      return json({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
    }
    if (url.includes('/im/v1/messages/om_sealed')) {
      return json({
        code: 0,
        data: { items: [{ message_id: 'om_sealed', msg_type: 'interactive', body: { content: JSON.stringify(sealed) } }] },
      });
    }
    if (url.endsWith('/_larklet/render')) {
      const body = JSON.parse(String(init?.body)) as { href?: string; userState?: unknown; searchParams?: unknown };
      assert.equal(body.href, '/framed');
      assert.equal(body.userState, undefined);
      assert.equal(body.searchParams, undefined);
      return json({ card: revived });
    }
    if (url.includes('/im/v1/messages?')) {
      const body = JSON.parse(String(init?.body)) as { content?: string };
      assert.equal(body.content, JSON.stringify(revived));
      return json({ code: 0, data: { message_id: 'om_sent' } });
    }
    return json({ code: 404, msg: url }, 404);
  };

  const app = createCompanionApp({
    appId: 'cli_test',
    appSecret: 'secret',
    cardRenderUrl: 'http://larklet.test',
    fetchImpl,
  });
  const sent = await app.request('/api/card/send', {
    method: 'POST',
    body: JSON.stringify({ messageId: 'om_sealed', chatId: 'oc_1', as: 'bot' }),
  });
  assert.equal(sent.status, 200);
  assert.ok(calls.some((url) => url.endsWith('/_larklet/render')));
});

test('加号菜单按应用路径把新卡片发到当前会话', async () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ url, body });
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
