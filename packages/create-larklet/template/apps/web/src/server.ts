import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createCompanionApp } from 'larklet-web';

import { loadEnv } from './env.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
loadEnv([path.join(dir, '../.env'), path.join(dir, '../../../.env')]);

const app = createCompanionApp({
  appId: process.env.APP_ID ?? process.env.LARKLET_APP_ID,
  appSecret: process.env.APP_SECRET ?? process.env.LARKLET_APP_SECRET,
  openApiBase: process.env.LARK_DOMAIN,
  allowDirectMessageId: process.env.NODE_ENV !== 'production',
  title: '__APP_NAME__',
});

if (process.env.NODE_ENV === 'production') {
  app.use('/assets/*', serveStatic({ root: path.join(dir, '../dist') }));
  app.get('*', serveStatic({ root: path.join(dir, '../dist') }));
}

const port = Number(process.env.PORT ?? 8788);
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
  console.log(`web http://127.0.0.1:${port}`);
});
