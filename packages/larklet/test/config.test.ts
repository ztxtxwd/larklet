import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LarkletError } from '../src/app.js';
import { loadLarkletConfig, normalizeLarkletConfig, resolveConnection } from '../src/config.js';

test('没有配置文件时默认长连接', () => {
  assert.equal(resolveConnection(undefined, {}), 'websocket');
  assert.equal(resolveConnection('webhook', { connection: 'websocket' }), 'webhook');
  assert.equal(resolveConnection(undefined, { connection: 'webhook' }), 'webhook');
});

test('读取 larklet.config.js 的 connection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'larklet-config-'));
  fs.writeFileSync(
    path.join(dir, 'larklet.config.js'),
    'export default { connection: "webhook" };\n',
  );
  assert.deepEqual(await loadLarkletConfig(dir), { connection: 'webhook' });
});

test('非法 connection 启动失败', () => {
  assert.throws(
    () => normalizeLarkletConfig({ connection: 'polling' }),
    (error: unknown) => error instanceof LarkletError && /connection/.test(error.message),
  );
});
