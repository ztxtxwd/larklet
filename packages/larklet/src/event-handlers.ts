import { existsSync } from 'node:fs';
import path from 'node:path';

import type { LarkletEvent } from './events.js';
import { importModule } from './router.js';

/**
 * 一个事件处理函数。返回 `undefined` 表示放行：继续下一个处理函数，
 * 最后回到卡片回调 / 菜单 / 斜杠命令的默认分发。
 */
export type LarkletEventHandler = (event: LarkletEvent) => unknown | Promise<unknown>;

/** 事件类型到处理函数，保留文件里的声明顺序。 */
export type LarkletEventHandlers = ReadonlyMap<string, LarkletEventHandler>;

const EVENT_FILES = ['events.ts', 'events.tsx', 'events.jsx', 'events.js'] as const;

/**
 * 读取 `app/events.*`。
 *
 * ```ts
 * export const events = {
 *   'im.message.receive_v1': async (event) => { ... },
 *   'im.chat.*': async (event) => { ... }, // 按前缀匹配
 *   '*': async (event) => { ... },         // 兜底
 * };
 * ```
 *
 * 也可以默认导出一个函数，等价于 `'*': fn`。
 */
export async function loadEventHandlers(appDir: string): Promise<LarkletEventHandlers> {
  const file = EVENT_FILES.map((name) => path.join(appDir, name)).find((candidate) => existsSync(candidate));
  if (!file) return new Map();

  const mod = await importModule(file);
  const raw = mod.events ?? mod.default;
  if (raw === undefined) throw new Error(`${file} 需要导出 events 对象或默认处理函数`);

  const handlers = new Map<string, LarkletEventHandler>();
  if (typeof raw === 'function') {
    handlers.set('*', raw as LarkletEventHandler);
    return handlers;
  }
  if (!isRecord(raw)) throw new Error(`${file} 的 events 需要是对象`);
  for (const [eventType, handler] of Object.entries(raw)) {
    if (!eventType.trim()) throw new Error(`${file} 里有空的事件类型`);
    if (typeof handler !== 'function') throw new Error(`${file} 的事件处理 ${eventType} 需要是函数`);
    handlers.set(eventType, handler as LarkletEventHandler);
  }
  return handlers;
}

/**
 * 一个事件可能命中多个处理函数：精确匹配先跑，通配按声明顺序跟上。
 * 前一个返回 `undefined` 才会轮到下一个。
 */
export function handlersForEvent(
  handlers: LarkletEventHandlers,
  eventType: string,
): LarkletEventHandler[] {
  const matched: LarkletEventHandler[] = [];
  const exact = handlers.get(eventType);
  if (exact) matched.push(exact);
  for (const [pattern, handler] of handlers) {
    if (pattern === eventType) continue;
    if (matchesEventPattern(pattern, eventType)) matched.push(handler);
  }
  return matched;
}

/**
 * `*` 单独出现匹配所有事件；`im.chat.*` 匹配 `im.chat.` 开头的所有事件；
 * 中间的 `*` 只匹配一个段，例如 `im.*.updated_v1`。
 */
function matchesEventPattern(pattern: string, eventType: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1);
    return eventType.startsWith(prefix) && eventType.length > prefix.length;
  }
  const expected = pattern.split('.');
  const actual = eventType.split('.');
  if (expected.length !== actual.length) return false;
  return expected.every((segment, index) => segment === '*' || segment === actual[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
