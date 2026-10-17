import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeIncoming } from '../src/events.js';
import { FlickError, createFlick, feishuCredentials } from '../src/index.js';
import { flickStorage, type FlickStore } from '../src/request.js';
import { matchSegments } from '../src/router.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture');

test('动态段与静态段', () => {
  const params = matchSegments(
    [
      { type: 'static', name: 'item' },
      { type: 'dynamic', name: 'id' },
    ],
    ['item', '42'],
  );
  assert.deepEqual(params, { id: '42' });
  assert.equal(
    matchSegments([{ type: 'static', name: 'item' }, { type: 'static', name: 'new' }], ['item', '42']),
    null,
  );
});

test('渲染、状态往返、redirect', async () => {
  const app = await createFlick({ dir: fixture });
  const home = await app.render('/');
  const json = JSON.stringify(home.card);
  assert.match(json, /Flick/);
  assert.match(json, /计数 0/);
  assert.equal(home.controls.length, 2);

  const inc = home.controls.find((control) => control.label === '加一');
  const go = home.controls.find((control) => control.label === '去详情');
  assert.ok(inc);
  assert.ok(go);
  assert.equal(inc.value.__action_id, '/#inc');
  assert.equal(typeof inc.value.__flick, 'string');

  const stepped = await app.handle(actionBody(inc.value));
  assert.equal(stepped.type, 'card');
  if (stepped.type !== 'card') return;
  assert.equal(stepped.toast?.content, '已加一');
  assert.match(JSON.stringify(stepped.card), /计数 1/);

  const again = stepped.controls.find((control) => control.label === '加一');
  assert.ok(again);
  const steppedAgain = await app.handle(actionBody(again.value));
  if (steppedAgain.type !== 'card') return;
  assert.match(JSON.stringify(steppedAgain.card), /计数 2/);

  const jumped = await app.handle(actionBody(go.value));
  assert.equal(jumped.type, 'card');
  if (jumped.type !== 'card') return;
  assert.match(JSON.stringify(jumped.card), /单号 42 来自 home/);
});

test('页面别名打开同一张卡片', async () => {
  const app = await createFlick({ dir: fixture });
  const viaAlias = await app.render('/单号/42?from=alias');
  assert.match(JSON.stringify(viaAlias.card), /单号 42 来自 alias/);

  const viaPattern = await app.render('/单据/7?from=alias');
  assert.match(JSON.stringify(viaPattern.card), /单号 7 来自 alias/);

  const slash = await app.handle({
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1', token: 'tok' },
    event: {
      sender: { sender_id: { open_id: 'ou_alias' }, sender_type: 'user' },
      message: {
        message_id: 'om_alias',
        chat_id: 'oc_alias',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/单号/42?from=menu' }),
        create_time: '1',
      },
    },
  });
  assert.equal(slash.type, 'menu');
  if (slash.type !== 'menu') return;
  assert.match(JSON.stringify(slash.card), /单号 42 来自 menu/);
});

test('别名冲突与写错的动态段会启动失败', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(path.join(tmpdir(), 'flick-alias-'));
  const appDir = path.join(root, 'app');
  await mkdir(path.join(appDir, 'guide'), { recursive: true });
  await mkdir(path.join(appDir, 'help'), { recursive: true });
  await mkdir(path.join(appDir, 'ticket', '[id]'), { recursive: true });
  const page = `export default function Page() { return null; }\n`;
  await writeFile(path.join(appDir, 'guide', 'page.tsx'), `export const aliases = ['指引'];\n${page}`);
  await writeFile(path.join(appDir, 'help', 'page.tsx'), `export const aliases = ['指引'];\n${page}`);
  await assert.rejects(
    () => createFlick({ dir: root }),
    (error: unknown) => error instanceof Error && /指引/.test(error.message),
  );

  await writeFile(
    path.join(appDir, 'ticket', '[id]', 'page.tsx'),
    `export const aliases = ['工单/[no]'];\nexport default function Page() { return null; }\n`,
  );
  await assert.rejects(
    () => createFlick({ dir: root }),
    (error: unknown) => error instanceof Error && /\[id\]/.test(error.message),
  );
  await rm(root, { recursive: true, force: true });
});

test('未匹配路径走 not-found', async () => {
  const app = await createFlick({ dir: fixture });
  const missing = await app.render('/missing');
  assert.match(JSON.stringify(missing.card), /自定义未找到/);
});

test('配置 app_id 与 app_secret', async () => {
  await assert.rejects(
    () => createFlick({ dir: fixture, appId: 'cli_only' }),
    (error: unknown) => error instanceof FlickError && /app_id/.test(error.message),
  );

  const app = await createFlick({ dir: fixture, appId: ' cli_x ', appSecret: ' secret ' });
  assert.equal(app.appId, 'cli_x');
  assert.equal(app.appSecret, 'secret');

  const run = flickStorage.run.bind(flickStorage);
  flickStorage.run = ((store: FlickStore, fn: () => unknown) => {
    assert.equal(store.appId, 'cli_x');
    assert.equal(store.appSecret, 'secret');
    return run(store, () => {
      assert.deepEqual(feishuCredentials(), { appId: 'cli_x', appSecret: 'secret' });
      return fn();
    });
  }) as typeof flickStorage.run;
  try {
    const home = await app.render('/');
    const inc = home.controls.find((control) => control.label === '加一');
    assert.ok(inc);
    const stepped = await app.handle(actionBody(inc.value));
    assert.equal(stepped.type, 'card');
  } finally {
    flickStorage.run = run;
  }
});

test('菜单事件按 event_key 打开端点', async () => {
  const app = await createFlick({ dir: fixture, verificationToken: 'tok' });
  const opened = await app.handle({
    schema: '2.0',
    header: {
      event_type: 'application.bot.menu_v6',
      token: 'tok',
      tenant_key: 't_key',
    },
    event: {
      operator: {
        operator_name: '张三',
        operator_id: { open_id: 'ou_menu', user_id: 'u_menu', union_id: 'on_menu' },
      },
      event_key: 'item/42?from=menu',
      timestamp: 1669364458,
    },
  });
  assert.equal(opened.type, 'menu');
  if (opened.type !== 'menu') return;
  assert.equal(opened.eventKey, 'item/42?from=menu');
  assert.equal(opened.operator.openId, 'ou_menu');
  assert.equal(opened.operator.name, '张三');
  assert.equal(opened.operator.tenantKey, 't_key');
  assert.match(JSON.stringify(opened.card), /单号 42 来自 menu/);

  await assert.rejects(
    () =>
      app.handle({
        header: { event_type: 'application.bot.menu_v6', token: 'tok' },
        event: { operator: { operator_id: { open_id: 'ou' } }, event_key: '   ' },
      }),
    (error: unknown) => error instanceof FlickError && /event_key/.test(error.message),
  );
});

test('斜杠命令消息与菜单 event_key 等价', async () => {
  const app = await createFlick({ dir: fixture, verificationToken: 'tok' });

  const dm = await app.handle({
    schema: '2.0',
    header: {
      event_type: 'im.message.receive_v1',
      token: 'tok',
      tenant_key: 't_key',
    },
    event: {
      sender: {
        sender_id: { open_id: 'ou_slash', user_id: 'u_slash', union_id: 'on_slash' },
        sender_type: 'user',
        tenant_key: 't_key',
      },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_dm',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/item/42?from=menu' }),
        create_time: '1669364458000',
      },
    },
  });
  assert.equal(dm.type, 'menu');
  if (dm.type !== 'menu') return;
  assert.equal(dm.eventKey, 'item/42?from=menu');
  assert.equal(dm.operator.openId, 'ou_slash');
  assert.equal(dm.operator.tenantKey, 't_key');
  assert.equal(dm.chatType, 'p2p');
  assert.equal(dm.chatId, 'oc_dm');
  assert.match(JSON.stringify(dm.card), /单号 42 来自 menu/);

  const group = await app.handle({
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1', token: 'tok' },
    event: {
      sender: {
        sender_id: { open_id: 'ou_group' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_2',
        chat_id: 'oc_group',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 /item/42?from=menu' }),
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Bot', mentioned_type: 'app' }],
        create_time: '1669364458000',
      },
    },
  });
  assert.equal(group.type, 'menu');
  if (group.type !== 'menu') return;
  assert.equal(group.eventKey, 'item/42?from=menu');
  assert.equal(group.operator.openId, 'ou_group');
  assert.equal(group.chatType, 'group');
  assert.equal(group.chatId, 'oc_group');
  assert.match(JSON.stringify(group.card), /单号 42 来自 menu/);

  const plain = await app.handle({
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1', token: 'tok' },
    event: {
      sender: { sender_id: { open_id: 'ou' }, sender_type: 'user' },
      message: {
        message_id: 'om_3',
        chat_id: 'oc',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
        create_time: '1',
      },
    },
  });
  assert.equal(plain.type, 'empty');
});

test('url_verification 与加密回调', async () => {
  const encryptKey = 'test-key';
  const app = await createFlick({ dir: fixture, verificationToken: 'tok', encryptKey });
  const challenge = await app.handle({ type: 'url_verification', challenge: 'abc', token: 'tok' });
  assert.deepEqual(challenge, { type: 'challenge', challenge: 'abc' });

  const home = await app.render('/');
  const inc = home.controls.find((control) => control.label === '加一');
  assert.ok(inc);
  const encrypted = await app.handle({
    encrypt: encryptPayload(
      {
        schema: '2.0',
        header: { event_type: 'card.action.trigger', token: 'tok' },
        event: {
          operator: { open_id: 'ou' },
          context: {},
          action: { tag: 'button', value: inc.value },
        },
      },
      encryptKey,
    ),
  });
  assert.equal(encrypted.type, 'card');
});

test('预览里 sendCard / updateCard 不请求飞书', async () => {
  const app = await createFlick({ dir: fixture });
  const board = await app.render('/board');
  const publish = board.controls.find((control) => control.label === '发到群里');
  const refreshHere = board.controls.find((control) => control.label === '刷新这张');
  const refreshOther = board.controls.find((control) => control.label === '刷新另一张');
  assert.ok(publish);
  assert.ok(refreshHere);
  assert.ok(refreshOther);

  const sent = await app.handle(actionBody(publish.value, { open_message_id: 'om_board', open_chat_id: 'oc_room' }), {
    captureEphemeral: true,
  });
  assert.equal(sent.type, 'card');
  if (sent.type !== 'card') return;
  assert.equal(sent.toast?.content, 'om_board');
  assert.equal(sent.messages.length, 1);
  assert.equal(sent.messages[0]?.kind, 'send');
  assert.equal(sent.messages[0]?.messageId, 'om_board');
  assert.match(JSON.stringify(sent.messages[0]?.card), /新的一局/);

  const here = await app.handle(actionBody(refreshHere.value, { open_message_id: 'om_board', open_chat_id: 'oc_room' }), {
    captureEphemeral: true,
  });
  assert.equal(here.type, 'card');
  if (here.type !== 'card') return;
  assert.equal(here.toast?.content, '已刷新');
  assert.deepEqual(here.messages, []);

  const other = await app.handle(actionBody(refreshOther.value, { open_message_id: 'om_hand', open_chat_id: 'oc_room' }), {
    captureEphemeral: true,
  });
  assert.equal(other.type, 'card');
  if (other.type !== 'card') return;
  assert.equal(other.toast?.content, '已刷新另一张');
  assert.equal(other.messages.length, 1);
  assert.equal(other.messages[0]?.kind, 'update');
  assert.equal(other.messages[0]?.messageId, 'om_other');
  assert.match(JSON.stringify(other.messages[0]?.card), /另一张/);
});

test('卡片回调解析 operator.name 与 avatar', () => {
  const incoming = normalizeIncoming({
    schema: '2.0',
    header: { event_type: 'card.action.trigger', token: 'dev' },
    event: {
      operator: { open_id: 'ou_1', name: '阿明', avatar: 'https://example.com/a.png' },
      context: { open_message_id: 'om_1', open_chat_id: 'oc_1' },
      action: { tag: 'button', value: { x: 1 } },
    },
  });
  assert.equal(incoming.kind, 'action');
  if (incoming.kind !== 'action') return;
  assert.equal(incoming.action.operator.name, '阿明');
  assert.equal(incoming.action.operator.avatar, 'https://example.com/a.png');
  assert.equal(incoming.action.message.openMessageId, 'om_1');
});

function actionBody(
  value: Record<string, unknown>,
  context: { open_message_id?: string; open_chat_id?: string } = {},
) {
  return {
    schema: '2.0',
    header: { event_type: 'card.action.trigger', token: 'tok' },
    event: {
      operator: { open_id: 'ou_dev' },
      context: { open_message_id: 'om_dev', ...context },
      action: { tag: 'button', value },
    },
  };
}

function encryptPayload(payload: unknown, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString('base64');
}
