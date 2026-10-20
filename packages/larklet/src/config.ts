import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { LarkletError } from './app.js';

export const LARKLET_CONNECTIONS = ['websocket', 'webhook'] as const;

/** 飞书事件与卡片回调的传输方式。 */
export type LarkletConnection = (typeof LARKLET_CONNECTIONS)[number];

export interface LarkletConfig {
  /**
   * 飞书事件与卡片回调怎么进来。
   * `websocket` 用长连接（默认）。`webhook` 用 HTTP `POST /webhook`。
   */
  connection?: LarkletConnection;
}

const CONFIG_FILES = ['larklet.config.js', 'larklet.config.mjs', 'larklet.config.cjs'] as const;

/** 读取应用目录里的 `larklet.config.js`。没有文件时返回空对象，调用方再取默认值。 */
export async function loadLarkletConfig(dir: string): Promise<LarkletConfig> {
  const file = CONFIG_FILES.map((name) => path.join(dir, name)).find((candidate) => fs.existsSync(candidate));
  if (!file) return {};
  const imported = (await import(pathToFileURL(file).href)) as { default?: unknown };
  const raw = imported.default ?? imported;
  return normalizeLarkletConfig(raw, path.basename(file));
}

export function normalizeLarkletConfig(raw: unknown, file = 'larklet.config.js'): LarkletConfig {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LarkletError(`${file} 需要默认导出一个对象`);
  }
  const connection = (raw as { connection?: unknown }).connection;
  if (connection === undefined) return {};
  if (!isConnection(connection)) {
    throw new LarkletError(`${file} 的 connection 只能是 websocket 或 webhook`);
  }
  return { connection };
}

/** 显式参数优先，其次配置文件，都没有则用长连接。 */
export function resolveConnection(explicit: LarkletConnection | undefined, file: LarkletConfig): LarkletConnection {
  return explicit ?? file.connection ?? 'websocket';
}

function isConnection(value: unknown): value is LarkletConnection {
  return value === 'websocket' || value === 'webhook';
}
