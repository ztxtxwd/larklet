import assert from 'node:assert/strict';
import test from 'node:test';

import { LarkletError } from '../src/app.js';
import { postText, sendText } from '../src/feishu.js';
import { larkletStorage, type LarkletStore } from '../src/request.js';
import { fakeOpenApi, withEnv } from './helpers/fake-open-api.js';

test('sendText 按前缀选 receive_id_type，并用环境变量凭证', async () => {
  const api = await fakeOpenApi();
  try {
    await withEnv(
      {
        LARK_DOMAIN: api.base,
        LARKLET_APP_ID: 'cli_text',
        LARKLET_APP_SECRET: 'secret_text',
        APP_ID: undefined,
        APP_SECRET: undefined,
      },
      async () => {
        const toChat = await sendText('oc_123', '收到');
        assert.equal(toChat.messageId, 'om_1');
        const toUser = await sendText('ou_456', '收到');
        assert.equal(toUser.messageId, 'om_2');

        // 显式 receiveIdType 优先于前缀推断。
        const forced = await sendText('ou_789', '收到', { receiveIdType: 'chat_id' });
        assert.equal(forced.messageId, 'om_3');
      },
    );

    assert.equal(api.calls.length, 3);
    assert.match(api.calls[0].url, /receive_id_type=chat_id/);
    assert.deepEqual(api.calls[0].body, {
      receive_id: 'oc_123',
      msg_type: 'text',
      content: JSON.stringify({ text: '收到' }),
    });
    assert.match(api.calls[1].url, /receive_id_type=open_id/);
    assert.equal((api.calls[1].body as { receive_id: string }).receive_id, 'ou_456');
    assert.match(api.calls[2].url, /receive_id_type=chat_id/);
  } finally {
    await api.close();
  }
});

test('sendText 用当前卡片上下文的凭证', async () => {
  const api = await fakeOpenApi();
  try {
    // 缓存按 `base + appId` 分开，这里换一个 appId，确保 token 真的走上下文。
    const store = { appId: 'cli_ctx', appSecret: 'secret_ctx' } as LarkletStore;
    const sent = await larkletStorage.run(store, () =>
      withEnv({ LARK_DOMAIN: api.base, LARKLET_APP_ID: undefined, LARKLET_APP_SECRET: undefined }, () =>
        sendText('ou_ctx', '上下文'),
      ),
    );
    assert.equal(sent.messageId, 'om_1');
    assert.equal(api.calls.length, 1);
  } finally {
    await api.close();
  }
});

test('sendText 没有凭证时直接报错，不发请求', async () => {
  await withEnv(
    {
      LARK_DOMAIN: 'http://127.0.0.1:9',
      LARKLET_APP_ID: undefined,
      LARKLET_APP_SECRET: undefined,
      APP_ID: undefined,
      APP_SECRET: undefined,
    },
    async () => {
      await assert.rejects(
        () => sendText('ou_none', '你好'),
        (error: unknown) => error instanceof LarkletError && /app_id/.test(error.message),
      );
      await assert.rejects(() => sendText('  ', '你好'), /open_id 或 chat_id/);
      await assert.rejects(() => sendText('ou_none', '   '), /非空文本/);
    },
  );
});

test('postText 用调用方给的 accessToken', async () => {
  const api = await fakeOpenApi();
  try {
    const sent = await postText({
      accessToken: 't_direct',
      receiveId: 'oc_direct',
      text: '直接发',
      openApiBase: api.base,
    });
    assert.equal(sent.messageId, 'om_1');
    assert.equal(api.calls.length, 1);
    assert.match(api.calls[0].url, /receive_id_type=chat_id/);
  } finally {
    await api.close();
  }
});
