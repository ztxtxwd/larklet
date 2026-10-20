import { ACTION_ID_KEY } from '@open-feishu-card/components';
import { decodeStateUrl, encodeStateUrl, readCardState, sealCardState } from '@open-feishu-card/store';

import type { LarkletStore, SearchParams } from './request.js';

/** 写进每个回调 value 的路由与用户状态。回调不回传整张卡片，所以不能只靠封印宿主。 */
export const LARKLET_STATE_KEY = '__larklet';

export interface LarkletEnvelope {
  v: 1;
  pattern: string;
  pathname: string;
  params: Record<string, string | string[]>;
  search: SearchParams;
  state: unknown;
}

export interface InteractiveControl {
  tag: string;
  label: string;
  value: Record<string, unknown>;
}

export function envelopeFromStore(store: LarkletStore): LarkletEnvelope {
  return {
    v: 1,
    pattern: store.pattern,
    pathname: store.pathname,
    params: store.params,
    search: store.searchParams,
    state: store.userState,
  };
}

export function isEnvelope(value: unknown): value is LarkletEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<LarkletEnvelope>;
  return record.v === 1 && typeof record.pathname === 'string' && typeof record.pattern === 'string';
}

/**
 * 把路由和 card state 写进每个带 `__action_id` 的 value，并封印进卡片宿主。
 * value 与 behaviors 往往共用同一个对象，盖一次即可。
 */
export function attachLarkletState(card: object, envelope: LarkletEnvelope): InteractiveControl[] {
  const token = encodeStateUrl(envelope);
  const fragment = token.slice(token.indexOf('#') + 1);
  const controls: InteractiveControl[] = [];
  const record = card as Record<string, unknown>;
  walk(record, fragment, controls, new Set());
  sealCardState(record, envelope);
  return controls;
}

export function readEnvelope(
  actionValue: Record<string, unknown> | undefined,
  card?: unknown,
): LarkletEnvelope | null {
  const token = actionValue?.[LARKLET_STATE_KEY];
  if (typeof token === 'string') {
    const decoded = decodeStateUrl(token);
    if (isEnvelope(decoded)) return decoded;
  }
  if (isRecord(card)) {
    const sealed = readCardState(card);
    if (isEnvelope(sealed)) return sealed;
  }
  return null;
}

function walk(
  node: unknown,
  token: string,
  controls: InteractiveControl[],
  seen: Set<object>,
): void {
  if (typeof node !== 'object' || node === null) return;
  if (seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const item of node) walk(item, token, controls, seen);
    return;
  }

  const record = node as Record<string, unknown>;
  if (typeof record[ACTION_ID_KEY] === 'string') {
    record[LARKLET_STATE_KEY] = token;
  }

  if (typeof record.tag === 'string' && isRecord(record.value) && typeof record.value[ACTION_ID_KEY] === 'string') {
    controls.push({
      tag: record.tag,
      label: labelOf(record),
      value: record.value,
    });
  }

  for (const value of Object.values(record)) walk(value, token, controls, seen);
}

function labelOf(record: Record<string, unknown>): string {
  const text = record.text;
  if (isRecord(text) && typeof text.content === 'string') return text.content;
  if (isRecord(record.placeholder) && typeof record.placeholder.content === 'string') {
    return record.placeholder.content;
  }
  if (typeof record.name === 'string') return record.name;
  return String(record.tag);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
