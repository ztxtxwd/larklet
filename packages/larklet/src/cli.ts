import fs from 'node:fs';
import path from 'node:path';

import { listen } from './server.js';

/** 读取应用目录下的 `.env`。已有的进程环境变量优先。 */
function loadEnvFile(file: string): void {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const command = process.argv[2];

if (command !== 'dev' && command !== 'start') {
  console.error('用法: larklet dev|start [--dir .] [--port 8787] [--host 0.0.0.0]');
  process.exit(1);
}

const port = Number(flag('--port') ?? process.env.PORT ?? 8787);
const host = flag('--host') ?? process.env.HOST ?? '0.0.0.0';
const dir = flag('--dir') ?? process.cwd();
const dev = command === 'dev';
loadEnvFile(path.resolve(dir, '.env'));

const running = await listen({
  port,
  host,
  dir,
  dev,
  verificationToken: process.env.LARKLET_VERIFICATION_TOKEN,
  encryptKey: process.env.LARKLET_ENCRYPT_KEY,
  appId: process.env.LARKLET_APP_ID ?? process.env.APP_ID,
  appSecret: process.env.LARKLET_APP_SECRET ?? process.env.APP_SECRET,
  domain: process.env.LARK_DOMAIN,
});

console.log(`Larklet ${dev ? 'dev' : 'start'} ${running.url}`);
if (dev) console.log(`预览 ${running.url}/`);
if (running.connection === 'webhook') {
  console.log(`webhook ${running.url}/webhook`);
} else if (running.app.appId) {
  console.log(`websocket ${running.app.appId}`);
} else {
  console.log('websocket 未连接：配置 APP_ID 与 APP_SECRET 后才会连上飞书');
}
