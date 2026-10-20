import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readCardState } from '@open-feishu-card/store';

import { putPreviewImage, resetPreviewContext } from '../src/preview-context.js';
import { listen } from '../src/server.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture');

test('预览页在同一标签页里打开多个用户', async () => {
  resetPreviewContext();
  const running = await listen({ dir: fixture, dev: true, port: 0, host: '127.0.0.1' });
  try {
    const html = await fetch(running.url).then((r) => r.text());
    assert.match(html, /再打开同一路径会加入这个会话/);
    assert.match(html, /if \(embed\) \{\s*const roomSource = new EventSource/);
    assert.match(html, /加一位留言者/);
    const apps = await fetch(`${running.url}/_larklet/apps`).then((r) => r.json());
    assert.deepEqual(apps, { apps: [] });
  } finally {
    await running.close();
  }
});

test('预览渲染与回调返回卡片和路径', async () => {
  resetPreviewContext();
  const running = await listen({ dir: fixture, dev: true, port: 0, host: '127.0.0.1' });
  try {
    const base = running.url;
    const home = await fetch(
      `${base}/_larklet/render?path=/&open_id=ou_a&name=${encodeURIComponent('阿明')}&open_message_id=om_dm_ou_a`,
    ).then((r) => r.json());
    assert.equal(home.path, '/');
    assert.ok(home.html || home.card);
    assert.equal(home.seq, undefined);

    const go = (home.actions as Array<{ label?: string; value: Record<string, unknown> }>).find(
      (control) => control.label === '去详情',
    );
    assert.ok(go);

    const eventRes = await fetch(`${base}/_larklet/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: '2.0',
        header: { event_type: 'card.action.trigger', token: 'dev' },
        event: {
          operator: { open_id: 'ou_a', name: '阿明' },
          context: { open_message_id: 'om_dm_ou_a', open_chat_id: 'oc_dm_ou_a' },
          action: { tag: 'button', value: go.value },
        },
      }),
    }).then((r) => r.json());

    assert.match(JSON.stringify(eventRes.card), /单号 42 来自 home/);
    assert.equal(eventRes.path, '/item/42?from=home');
    assert.equal(eventRes.seq, undefined);
  } finally {
    await running.close();
  }
});

test('按封印状态重新渲染可发送的卡片', async () => {
  resetPreviewContext();
  const running = await listen({ dir: fixture, dev: true, port: 0, host: '127.0.0.1' });
  try {
    const response = await fetch(`${running.url}/_larklet/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        href: '/',
        userState: { play: { n: 1 } },
        searchParams: {},
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { card?: Record<string, unknown> };
    assert.ok(body.card);
    const envelope = readCardState(body.card) as { state?: { play?: { n?: number } } } | null;
    assert.equal(envelope?.state?.play?.n, 1);
  } finally {
    await running.close();
  }
});

test('模拟群接收网页投递的卡片，点击后写回同一条消息', async () => {
  resetPreviewContext();
  const running = await listen({ dir: fixture, dev: true, port: 0, host: '127.0.0.1' });
  try {
    const room = (await fetch(`${running.url}/_larklet/preview/room?id=dev`).then((r) => r.json())) as {
      chatId: string;
      users: Array<{ openId: string; role: string; name: string }>;
    };
    assert.equal(room.chatId, 'oc_larklet_dev');
    assert.equal(room.users.filter((user) => user.role === 'seller').length, 1);
    assert.equal(room.users.filter((user) => user.role === 'buyer').length, 2);

    const delivered = (await fetch(`${running.url}/_larklet/preview/deliver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: 'dev', kind: 'chat', href: '/', userState: { n: 0 } }),
    }).then((r) => r.json())) as {
      ok: boolean;
      messageId: string;
      chatId: string;
      actions: Array<{ label?: string; value: Record<string, unknown> }>;
    };
    assert.equal(delivered.ok, true);
    assert.equal(delivered.chatId, room.chatId);
    const inc = delivered.actions.find((control) => control.label === '加一');
    assert.ok(inc);

    const seller = room.users.find((user) => user.role === 'seller');
    assert.ok(seller);
    const ephemeral = (await fetch(`${running.url}/_larklet/preview/deliver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        room: 'dev',
        kind: 'ephemeral',
        href: '/',
        openId: seller.openId,
        userState: { n: 0 },
      }),
    }).then((r) => r.json())) as { ok: boolean; messageId: string };
    assert.equal(ephemeral.ok, true);

    const clicked = await fetch(`${running.url}/_larklet/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: '2.0',
        header: { event_type: 'card.action.trigger', token: 'dev' },
        event: {
          operator: { open_id: room.users.find((user) => user.role === 'buyer')?.openId, name: '小林' },
          context: { open_message_id: delivered.messageId, open_chat_id: delivered.chatId },
          action: { tag: 'button', value: inc.value },
        },
      }),
    });
    assert.equal(clicked.status, 200);

    const snap = await readSnapshot(running.url, (body) =>
      body.messages.some((message) => message.messageId === delivered.messageId && message.html.includes('计数 1')),
    );
    const chat = snap.messages.find((message) => message.messageId === delivered.messageId);
    assert.equal(chat?.kind, 'chat');
    assert.equal(snap.messages.some((message) => message.messageId === ephemeral.messageId && message.kind === 'ephemeral'), true);

    const added = (await fetch(`${running.url}/_larklet/preview/room`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'dev', action: 'add-user' }),
    }).then((r) => r.json())) as { users: Array<{ role: string }> };
    assert.equal(added.users.filter((user) => user.role === 'buyer').length, 3);
  } finally {
    await running.close();
  }
});

test('预览场景只在打开该路径时铺开，首页不带上', async () => {
  resetPreviewContext();
  const running = await listen({ dir: fixture, dev: true, port: 0, host: '127.0.0.1' });
  try {
    const home = (await fetch(`${running.url}/_larklet/preview/scene?path=/`).then((r) => r.json())) as { scene: unknown };
    assert.equal(home.scene, null);

    const meta = (await fetch(
      `${running.url}/_larklet/preview/scene?path=${encodeURIComponent('/preview-scene')}`,
    ).then((r) => r.json())) as { scene: { users: Array<{ name: string; role?: string }> } };
    assert.equal(meta.scene.users[0]?.name, '阿明');
    assert.equal(meta.scene.users[0]?.role, 'seller');

    const rendered = (await fetch(
      `${running.url}/_larklet/render?path=${encodeURIComponent('/preview-scene')}`,
    ).then((r) => r.json())) as { html: string; scene: { aside?: { html: string; role?: string } } };
    assert.match(rendered.html, /群里的卡片/);
    assert.equal(rendered.scene.aside?.role, 'seller');
    assert.match(rendered.scene.aside?.html ?? '', /仅卖家/);
  } finally {
    await running.close();
  }
});

test('非开发模式不开放模拟群', async () => {
  resetPreviewContext();
  const running = await listen({ dir: fixture, dev: false, port: 0, host: '127.0.0.1' });
  try {
    const response = await fetch(`${running.url}/_larklet/preview/room?id=dev`);
    assert.equal(response.status, 404);
  } finally {
    await running.close();
  }
});

async function readSnapshot(
  base: string,
  ready: (body: { messages: Array<{ messageId: string; kind: string; html: string }> }) => boolean,
): Promise<{ messages: Array<{ messageId: string; kind: string; html: string }> }> {
  const response = await fetch(`${base}/_larklet/preview/stream?room=dev`);
  assert.equal(response.status, 200);
  const reader = response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let buf = '';
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((item) => item.startsWith('data: '));
      if (!line) continue;
      const body = JSON.parse(line.slice(6)) as { messages: Array<{ messageId: string; kind: string; html: string }> };
      if (ready(body)) {
        await reader.cancel();
        return body;
      }
    }
  }
  await reader.cancel();
  throw new Error('模拟群没有在时限内更新');
}

test('预览人员表与图片解析注入到 HTML', async () => {
  resetPreviewContext();
  putPreviewImage('img_preview_demo', 'data:image/gif;base64,R0lGODlhAQABAAAAACw=');

  const running = await listen({
    dir: fixture,
    dev: true,
    port: 0,
    host: '127.0.0.1',
  });
  try {
    const avatar = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const qs = new URLSearchParams({
      path: '/person-preview',
      open_id: 'ou_xiaoli',
      name: '小李',
      avatar,
      open_message_id: 'om_dm_ou_xiaoli',
    });
    const res = await fetch(`${running.url}/_larklet/render?${qs}`).then((r) => r.json());
    assert.match(String(res.html), /小李/);
    assert.doesNotMatch(String(res.html), /赵天雄/);
    assert.match(String(res.html), /data:image\/gif;base64/);
    assert.doesNotMatch(String(res.html), /\[图片\]/);
  } finally {
    await running.close();
  }
});
