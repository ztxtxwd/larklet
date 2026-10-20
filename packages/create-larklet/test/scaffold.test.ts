import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { scaffold } from '../src/scaffold.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('生成包含 bot 与 web 的 workspace', () => {
  const dest = path.join(here, '../.tmp-scaffold');
  fs.rmSync(dest, { recursive: true, force: true });
  const rootVersion = JSON.parse(fs.readFileSync(path.join(here, '../package.json'), 'utf8')) as { version: string };
  try {
    const created = scaffold(path.join(dest, 'Inbox Demo'));
    assert.equal(created.name, 'inbox-demo');
    const root = JSON.parse(fs.readFileSync(path.join(created.dest, 'package.json'), 'utf8')) as { name: string };
    assert.equal(root.name, 'inbox-demo');
    const workspace = fs.readFileSync(path.join(created.dest, 'pnpm-workspace.yaml'), 'utf8');
    assert.match(workspace, /apps\/\*/);

    const bot = JSON.parse(fs.readFileSync(path.join(created.dest, 'apps/bot/package.json'), 'utf8')) as {
      dependencies: { larklet: string };
    };
    assert.equal(bot.dependencies.larklet, `^${rootVersion.version}`);

    const web = JSON.parse(fs.readFileSync(path.join(created.dest, 'apps/web/package.json'), 'utf8')) as {
      dependencies: { 'larklet-web': string };
      devDependencies: { '@semi-bot/semi-theme-universedesign': string };
    };
    assert.equal(web.dependencies['larklet-web'], `^${rootVersion.version}`);
    assert.equal(web.devDependencies['@semi-bot/semi-theme-universedesign'], '^1.0.13');

    const vite = fs.readFileSync(path.join(created.dest, 'apps/web/vite.config.ts'), 'utf8');
    assert.match(vite, /@semi-bot\/semi-theme-universedesign/);
    assert.match(fs.readFileSync(path.join(created.dest, '.gitignore'), 'utf8'), /node_modules/);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});
