import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLarklet } from '../src/index.js';
import { LarkletError } from '../src/app.js';
import { readEvent } from '../src/events.js';
import { openBot, openChat, openLink } from '../src/links.js';
import { listen } from '../src/server.js';
import { envelopeFromSocket } from '../src/socket.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixture');

const EVENT_ID = 'evt_1';

test('配置 verification token 后，HTTP 必须带对 token', async () => {
  const app = await createLarklet({ dir: fixture, verificationToken: 'tok' });

  await assert.rejects(
    () => app.handle(menuBody({})),
    (error: unknown) => error instanceof LarkletError && error.status === 401 && /缺少/.test(error.message),
  );
  await assert.rejects(
    () => app.handle(menuBody({ token: 'wrong' })),
    (error: unknown) => error instanceof LarkletError && error.status === 401 && /不匹配/.test(error.message),
  );

  const ok = await app.handle(menuBody({ token: 'tok' }));
  assert.equal(ok.type, 'menu');

  // 传输层已经鉴权的通道不受影响。
  const trusted = await app.handle(menuBody({}), { trustedTransport: true });
  assert.equal(trusted.type, 'menu');
});

test('长连接事件保留 header 并作为可信通道通过', async () => {
  const app = await createLarklet({ dir: fixture, verificationToken: 'tok' });
  const envelope = envelopeFromSocket(
    'im.message.receive_v1',
    {
      token: 'vtoken',
      tenant_key: 'tk_1',
      app_id: 'cli_0123456789abcdef',
      sender: { sender_id: { open_id: 'ou_slash' }, sender_type: 'user' },
      message: {
        message_id: 'om',
        chat_id: 'oc',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/item/42' }),
      },
    },
    { event_id: EVENT_ID },
  );
  assert.equal(envelope.header.token, 'vtoken');
  assert.equal(envelope.header.tenant_key, 'tk_1');
  assert.equal(envelope.header.event_id, EVENT_ID);

  const handled = await app.handle(envelope, { trustedTransport: true });
  assert.equal(handled.type, 'menu');
  if (handled.type !== 'menu') return;
  assert.equal(handled.operator.tenantKey, 'tk_1');
});

test('onEvent 先于默认分发，接管后不再渲染卡片', async () => {
  const seen: Array<{ eventType: string; token?: string; text?: string; transport: string }> = [];
  const app = await createLarklet({
    dir: fixture,
    onEvent: (event) => {
      const message = event.event.message as { content?: string } | undefined;
      seen.push({
        eventType: event.eventType,
        token: event.token,
        text: message?.content,
        transport: event.transport,
      });
      return event.eventType === 'im.message.receive_v1' ? { code: 0 } : undefined;
    },
  });

  // 群消息：接管，返回自己的响应，不渲染卡片。
  const handled = await app.handle(
    {
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1', event_id: EVENT_ID, token: 'vt' },
      event: {
        sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'user' },
        message: {
          message_id: 'om_1',
          chat_id: 'oc_1',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
        },
      },
    },
    { transport: 'webhook' },
  );
  assert.deepEqual(handled, { type: 'raw', eventType: 'im.message.receive_v1', response: { code: 0 } });
  assert.deepEqual(seen, [
    { eventType: 'im.message.receive_v1', token: 'vt', text: JSON.stringify({ text: 'hello' }), transport: 'webhook' },
  ]);
});

test('onEvent 也先拿到卡片回调，返回 undefined 再默认分发', async () => {
  const seen: string[] = [];
  const app = await createLarklet({
    dir: fixture,
    onEvent: (event) => {
      seen.push(event.eventType);
      return undefined;
    },
  });
  const home = await app.render('/');
  const inc = home.controls.find((control) => control.label === '加一');
  assert.ok(inc);
  const handled = await app.handle({
    schema: '2.0',
    header: { event_type: 'card.action.trigger', event_id: EVENT_ID, token: 'dev' },
    event: { operator: { open_id: 'ou_1' }, context: {}, action: { tag: 'button', value: inc.value } },
  });
  assert.equal(handled.type, 'card');
  assert.deepEqual(seen, ['card.action.trigger']);
});

test('onEvent 返回 undefined 时继续默认分发', async () => {
  const app = await createLarklet({ dir: fixture, onEvent: () => undefined });
  const home = await app.render('/');
  const inc = home.controls.find((control) => control.label === '加一');
  assert.ok(inc);
  const handled = await app.handle({
    schema: '2.0',
    header: { event_type: 'card.action.trigger', event_id: EVENT_ID, token: 'dev' },
    event: { operator: { open_id: 'ou_1' }, context: {}, action: { tag: 'button', value: inc.value } },
  });
  assert.equal(handled.type, 'card');
});

test('onEvent 不接管没有 event_id 的 body', async () => {
  const app = await createLarklet({ dir: fixture, onEvent: () => ({ handled: true }) });
  const ping = await app.handle({ type: 'application.bot.menu_v6', event: { event_key: '/', operator: {} } });
  assert.equal(ping.type, 'menu');
});

test('1.0 事件（event_callback + uuid）也能交给 onEvent', async () => {
  const seen: Array<{ eventType: string; eventId?: string; version: string }> = [];
  const app = await createLarklet({
    dir: fixture,
    onEvent: {
      'p2p_chat_create': (event) => {
        seen.push({ eventType: event.eventType, eventId: event.eventId, version: event.version });
        return { code: 0 };
      },
    },
  });
  const handled = await app.handle({
    ts: '1502199207.7171419',
    uuid: 'bc447199585340d1f3728d26b1c0297a',
    token: 'tok',
    type: 'event_callback',
    event: {
      type: 'p2p_chat_create',
      app_id: 'cli_9c8609450f78d102',
      chat_id: 'oc_26b66a5eb603162b849f91bcd8815b20',
      tenant_key: 'tk_legacy',
      user: { open_id: 'ou_7dede290d6a27698b969a7fd70ca53da' },
    },
  });
  assert.deepEqual(handled, { type: 'raw', eventType: 'p2p_chat_create', response: { code: 0 } });
  assert.deepEqual(seen, [
    { eventType: 'p2p_chat_create', eventId: 'bc447199585340d1f3728d26b1c0297a', version: '1.0' },
  ]);
});

test('app/events.ts 按事件类型注册，支持前缀通配与兜底', async () => {
  const root = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'larklet-events-'));
  try {
    await fs.mkdir(path.join(root, 'app'), { recursive: true });
    await fs.writeFile(path.join(root, 'app', 'page.tsx'), 'export default function Page() { return null; }\n');
    await fs.writeFile(
      path.join(root, 'app', 'events.ts'),
      [
        'export const events = {',
        "  'im.chat.member.user.added_v1': async () => ({ exact: true }),",
        "  'im.chat.*': async (event) => ({ wildcard: event.eventType }),",
        "  '*': async (event) => ({ fallback: event.eventType }),",
        '};',
        '',
      ].join('\n'),
    );
    const app = await createLarklet({ dir: root, dev: true });
    const exact = await app.handle(eventBody('im.chat.member.user.added_v1'));
    assert.deepEqual(exact, { type: 'raw', eventType: 'im.chat.member.user.added_v1', response: { exact: true } });
    const prefix = await app.handle(eventBody('im.chat.updated_v1'));
    assert.deepEqual(prefix, { type: 'raw', eventType: 'im.chat.updated_v1', response: { wildcard: 'im.chat.updated_v1' } });
    const fallback = await app.handle(eventBody('contact.user.deleted_v3'));
    assert.deepEqual(fallback, { type: 'raw', eventType: 'contact.user.deleted_v3', response: { fallback: 'contact.user.deleted_v3' } });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('本地预览自拼的卡片回调不经过 onEvent', async () => {
  const seen: string[] = [];
  const app = await createLarklet({
    dir: fixture,
    onEvent: (event) => {
      seen.push(event.eventType);
      return { handled: true };
    },
  });
  const home = await app.render('/');
  const inc = home.controls.find((control) => control.label === '加一');
  assert.ok(inc);
  const handled = await app.handle(
    {
      schema: '2.0',
      header: { event_type: 'card.action.trigger', token: 'dev' },
      event: { operator: { open_id: 'ou_1' }, context: {}, action: { tag: 'button', value: inc.value } },
    },
    { synthetic: true, trustedTransport: true, transport: 'http' },
  );
  assert.equal(handled.type, 'card');
  assert.deepEqual(seen, []);
});

test('readEvent 认 2.0 / 1.0，忽略 url_verification 与 1.0 里没有 id 的 body', () => {
  assert.equal(readEvent({ type: 'url_verification', challenge: 'x' }), undefined);
  // 1.0 没有 uuid 视为手写 body；菜单默认分发继续处理。
  assert.equal(readEvent({ type: 'application.bot.menu_v6', event: { event_key: '/' } }), undefined);
  const modern = readEvent(eventBody('im.message.receive_v1'));
  assert.equal(modern?.version, '2.0');
  assert.equal(modern?.eventId, EVENT_ID);
  assert.equal(modern?.transport, 'webhook');
  // 2.0 只凭 event_type 就成立；event_id 缺失不影响（预览用 synthetic 排除）。
  const noId = readEvent({ schema: '2.0', header: { event_type: 'im.chat.updated_v1' }, event: {} });
  assert.equal(noId?.eventType, 'im.chat.updated_v1');
  assert.equal(noId?.eventId, undefined);
  const legacy = readEvent({
    uuid: 'u1',
    token: 'tok',
    type: 'event_callback',
    event: { type: 'p2p_chat_create', tenant_key: 'tk' },
  });
  assert.deepEqual(legacy?.header, {
    event_type: 'p2p_chat_create',
    event_id: 'u1',
    token: 'tok',
    tenant_key: 'tk',
  });
  assert.equal(legacy?.eventId, 'u1');
});

test('渲染接口可带 operator 与 message', async () => {
  const running = await listen({ dir: fixture, dev: false, port: 0, host: '127.0.0.1' });
  try {
    const response = await fetch(`${running.url}/_larklet/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        href: '/person-preview',
        operator: { openId: 'ou_x', extra: 1 },
        message: { openMessageId: 'om_x' },
      }),
    });
    const body = (await response.json()) as { card?: unknown };
    assert.match(JSON.stringify(body.card), /ou_x/);
    // 非字符串字段被丢掉，也不会让渲染失败。
    assert.doesNotMatch(JSON.stringify(body.card), /\[object Object\]/);
  } finally {
    await running.close();
  }
});

test('close 可重复调用，onReady 的清理函数只跑一次', async () => {
  let cleaned = 0;
  const first = await listen({
    dir: fixture,
    port: 0,
    host: '127.0.0.1',
    onReady: (app) => {
      assert.equal(typeof app.render, 'function');
      return () => {
        cleaned += 1;
      };
    },
  });
  await Promise.all([first.close(), first.close()]);
  await first.close();
  assert.equal(cleaned, 1);
});

test('onReady 失败时关闭服务器并把错误抛出来', async () => {
  await assert.rejects(
    () =>
      listen({
        dir: fixture,
        port: 0,
        host: '127.0.0.1',
        onReady: () => {
          throw new Error('boom');
        },
      }),
    /boom/,
  );
});

test('app/catalog.tsx 也能被应用列表读到', async () => {
  const root = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'larklet-catalog-'));
  try {
    await fs.mkdir(path.join(root, 'app'), { recursive: true });
    await fs.writeFile(path.join(root, 'app', 'page.tsx'), 'export default function Page() { return null; }\n');
    await fs.writeFile(
      path.join(root, 'app', 'catalog.tsx'),
      `export const apps = [{ href: '/board', title: '看板', description: '一组卡片' }];\n`,
    );
    const running = await listen({ dir: root, port: 0, host: '127.0.0.1' });
    try {
      const body = (await fetch(`${running.url}/_larklet/apps`).then((r) => r.json())) as { apps: unknown[] };
      assert.deepEqual(body.apps, [{ href: '/board', title: '看板', description: '一组卡片' }]);
    } finally {
      await running.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('openLink 生成侧边栏 AppLink', () => {
  const link = openLink('https://bot.example/oauth?from=card');
  assert.equal(
    link,
    'https://applink.feishu.cn/client/web_url/open?mode=sidebar-semi&url=https%3A%2F%2Fbot.example%2Foauth%3Ffrom%3Dcard',
  );
  assert.match(openLink('https://bot.example', { mode: 'window', domain: 'lark' }), /^https:\/\/applink\.larksuite\.com\//);
  assert.match(openLink('https://bot.example', { width: 1200, minWidth: 400 }), /width=1200&min_width=400$/);
  assert.throws(() => openLink('/relative'), /http/);
});

test('openChat / openBot 生成会话 AppLink', () => {
  assert.equal(openChat({ openChatId: 'oc_1' }), 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1');
  assert.equal(openChat({ openId: 'ou_1' }, { domain: 'lark' }), 'https://applink.larksuite.com/client/chat/open?openId=ou_1');
  assert.throws(() => openChat({}), /openChatId/);
  assert.equal(openBot('cli_0123456789abcdef'), 'https://applink.feishu.cn/client/bot/open?appId=cli_0123456789abcdef');
});

function eventBody(eventType: string) {
  return {
    schema: '2.0',
    header: { event_type: eventType, event_id: EVENT_ID, token: 'tok' },
    event: { chat_id: 'oc_1' },
  };
}

function menuBody(header: Record<string, unknown>) {
  return {
    schema: '2.0',
    header: { event_type: 'application.bot.menu_v6', event_id: EVENT_ID, ...header },
    event: { event_key: 'item/42', operator: { operator_id: { open_id: 'ou_1' } } },
  };
}
