import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLarklet } from '../src/index.js';
import { envelopeFromSocket, replyToSocket } from '../src/socket.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture');

test('长连接事件还原成 handle 认识的信封', async () => {
  const app = await createLarklet({ dir: fixture });
  const handled = await app.handle(
    envelopeFromSocket('application.bot.menu_v6', {
      event_key: 'item/42?from=menu',
      operator: { operator_id: { open_id: 'ou_menu' }, operator_name: '张三' },
    }),
  );
  assert.equal(handled.type, 'menu');
  if (handled.type !== 'menu') return;
  assert.match(JSON.stringify(handled.card), /单号 42/);

  const replied = await replyToSocket(app, 'application.bot.menu_v6', {
    event_key: '/',
    operator: { operator_id: { open_id: 'ou_menu' } },
  });
  assert.deepEqual(replied, {});

  const slash = await app.handle(
    envelopeFromSocket('im.message.receive_v1', {
      sender: { sender_id: { open_id: 'ou_slash' }, sender_type: 'user' },
      message: {
        message_id: 'om',
        chat_id: 'oc',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/item/42?from=menu' }),
        create_time: '1',
      },
    }),
  );
  assert.equal(slash.type, 'menu');
  if (slash.type !== 'menu') return;
  assert.equal(slash.eventKey, 'item/42?from=menu');
  assert.match(JSON.stringify(slash.card), /单号 42/);
});

test('长连接上的卡片回调回传新卡片', async () => {
  const app = await createLarklet({ dir: fixture });
  const home = await app.render('/');
  const inc = home.controls.find((control) => control.label === '加一');
  assert.ok(inc);
  const replied = await replyToSocket(app, 'card.action.trigger', {
    operator: { open_id: 'ou_1' },
    context: { open_message_id: 'om_1' },
    action: { value: inc.value, tag: 'button' },
  });
  assert.equal(typeof replied, 'object');
  const body = replied as { card?: { type?: string; data?: unknown }; toast?: { content?: string } };
  assert.equal(body.card?.type, 'raw');
  assert.equal(body.toast?.content, '已加一');
  assert.match(JSON.stringify(body.card?.data), /计数 1/);
});
