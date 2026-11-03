import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chatInfoAttempts,
  isMessageAction,
  isPlusMenu,
  launchQuery,
  plusChatType,
  readTriggerCode,
  sceneFromPath,
  sceneOf,
} from '../src/client/launch.js';

function params(search: string): URLSearchParams {
  return new URLSearchParams(search);
}

function launchQueryParam(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value));
}

test('PC 从 from 参数认出加号菜单', () => {
  assert.equal(isPlusMenu(params('from=plus_menu_p2p')), true);
  assert.equal(isPlusMenu(params('from=plus_menu_group')), true);
  assert.equal(isPlusMenu(params('from=message_action')), false);
  assert.equal(isPlusMenu(params('')), false);
});

test('移动端从 required_launch_ability 认出加号菜单', () => {
  assert.equal(isPlusMenu(params('required_launch_ability=chat_action')), true);
  assert.equal(isPlusMenu(params('required_launch_ability=message_action')), false);
  // 启动参数里也带着同一个字段。
  const query = launchQueryParam({ __trigger_id__: 't1', required_launch_ability: 'chat_action' });
  assert.equal(isPlusMenu(params(`bdp_launch_query=${query}`)), true);
});

test('triggerCode 在 bdp_launch_query 里', () => {
  const query = launchQueryParam({ __trigger_id__: 'trigger-1' });
  assert.equal(readTriggerCode(params(`bdp_launch_query=${query}`)), 'trigger-1');
  assert.equal(launchQuery(params(`bdp_launch_query=${query}`)).__trigger_id__, 'trigger-1');
  // 有些客户端会再编码一层，解不出来就再解一次。
  const twice = encodeURIComponent(encodeURIComponent(JSON.stringify({ __trigger_id__: 'trigger-2' })));
  assert.equal(readTriggerCode(params(`bdp_launch_query=${twice}`)), 'trigger-2');
  // 没有、或者不是 JSON，就当没有。
  assert.equal(readTriggerCode(params('')), '');
  assert.equal(readTriggerCode(params('bdp_launch_query=not-json')), '');
  assert.deepEqual(launchQuery(params('bdp_launch_query=123')), {});
});

test('会话类型只有 PC 能看出来', () => {
  assert.equal(plusChatType(params('from=plus_menu_p2p')), 'p2p');
  assert.equal(plusChatType(params('from=plus_menu_group')), 'group');
  // 移动端不带 from。
  assert.equal(plusChatType(params('required_launch_ability=chat_action')), '');
});

test('读会话信息时按会话类型试', () => {
  // 群聊不用 userType。
  assert.deepEqual(chatInfoAttempts('group'), [[1, 0]]);
  // 单聊要 userType，用户和机器人各试一次。
  assert.deepEqual(chatInfoAttempts('p2p'), [[0, 0], [0, 1]]);
  // 移动端看不出是哪种会话，群聊、单聊都试。
  assert.deepEqual(chatInfoAttempts(''), [[1, 0], [0, 0], [0, 1]]);
});

test('消息快捷操作看 from 与 required_launch_ability', () => {
  assert.equal(isMessageAction(params('from=message_action')), true);
  assert.equal(isMessageAction(params('from=plus_menu_group')), false);
  assert.equal(isMessageAction(params('required_launch_ability=message_action')), true);
  const query = launchQueryParam({ __trigger_id__: 't1', required_launch_ability: 'message_action' });
  assert.equal(isMessageAction(params(`bdp_launch_query=${query}`)), true);
});

test('路径能认出场景', () => {
  assert.equal(sceneFromPath('/message'), 'message');
  assert.equal(sceneFromPath('/plus'), 'plus');
  assert.equal(sceneFromPath('/plus/'), 'plus');
  assert.equal(sceneFromPath('/'), '');
  assert.equal(sceneFromPath('/apps/ticket'), '');
});

test('场景以路径为准，路径没标记才看启动参数', () => {
  // 路径说是消息快捷操作，就算参数是上一次的加号菜单，也按消息快捷操作来。
  assert.equal(sceneOf(params('from=plus_menu_group'), '/message'), 'message');
  assert.equal(sceneOf(params('from=message_action'), '/plus'), 'plus');
  // 没有路径标记时看参数。
  assert.equal(sceneOf(params('from=plus_menu_group'), '/'), 'plus');
  assert.equal(sceneOf(params('from=message_action'), '/'), 'message');
  assert.equal(sceneOf(params('required_launch_ability=chat_action'), '/'), 'plus');
  assert.equal(sceneOf(params(''), '/'), '');
});
