import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveOpenApiBase } from '../src/feishu.js';

test('LARK_DOMAIN 作为开放平台根地址', () => {
  const previous = process.env.LARK_DOMAIN;
  try {
    delete process.env.LARK_DOMAIN;
    assert.equal(resolveOpenApiBase(), 'https://open.feishu.cn');
    assert.equal(resolveOpenApiBase('Feishu'), 'https://open.feishu.cn');
    assert.equal(resolveOpenApiBase('Lark'), 'https://open.larksuite.com');
    assert.equal(resolveOpenApiBase('http://tencent:18787/e/dev/'), 'http://tencent:18787/e/dev');
    process.env.LARK_DOMAIN = 'http://tencent:18787/e/dev';
    assert.equal(resolveOpenApiBase(), 'http://tencent:18787/e/dev');
    assert.equal(resolveOpenApiBase('Lark'), 'https://open.larksuite.com');
  } finally {
    if (previous === undefined) delete process.env.LARK_DOMAIN;
    else process.env.LARK_DOMAIN = previous;
  }
});
