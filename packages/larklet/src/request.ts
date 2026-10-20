import { AsyncLocalStorage } from 'node:async_hooks';

import type { FeishuCardJson } from '@open-feishu-card/components';

/** 对齐 Next.js 的 searchParams：单值是字符串，重复键是数组。 */
export type SearchParams = Record<string, string | string[] | undefined>;

export interface Operator {
  openId?: string;
  userId?: string;
  unionId?: string;
  tenantKey?: string;
  /** 操作人显示名（菜单事件的 operator_name，或本地预览模拟用户）。 */
  name?: string;
  /** 头像 URL；飞书回调通常不带，本地预览会填。 */
  avatar?: string;
}

export interface MessageContext {
  openMessageId?: string;
  openChatId?: string;
}

export interface Toast {
  type: 'info' | 'success' | 'error' | 'warning';
  content: string;
}

/** 飞书应用凭证。两项都配置后才会出现。 */
export interface FeishuAppConfig {
  appId: string;
  appSecret: string;
}

/** 嵌套渲染另一条路由时带上的上下文。`sendEphemeral` 用它给出指定用户看的卡片。 */
export interface RouteRenderInit {
  searchParams?: SearchParams;
  userState?: unknown;
  operator?: Operator;
  message?: MessageContext;
}

/** 一次发到会话里、大家都能看到的卡片。留在本次回调上，供预览或调用方查看。 */
export interface MessageDelivery {
  kind: 'send' | 'update';
  messageId: string;
  chatId?: string;
  card: FeishuCardJson;
  /** 渲染这张卡片的路径。 */
  path: string;
  /** 预览里要为哪些人打开这张新会话卡片。真机发送不用。 */
  openIds?: string[];
  /** 预览里跟在卡片后面的文字。真机发送不用。 */
  previewText?: string;
}

/** 一次「仅特定人可见」发送的结果，留在本次回调上，供预览或调用方查看。 */
export interface EphemeralDelivery {
  messageId: string;
  openId: string;
  chatId: string;
  card: FeishuCardJson;
  /** 渲染这张私卡的路径。 */
  path: string;
}

export interface LarkletStore {
  phase: 'render' | 'action';
  appId?: string;
  appSecret?: string;
  /**
   * 为 true 时不请求飞书，只把出站卡片记在 `ephemeralSent` / `messagesSent`。
   * 本地预览（`/_larklet/event`）使用。
   */
  captureEphemeral: boolean;
  /** 渲染另一条路由。由 `createLarklet` 装上。 */
  renderRoute?: (href: string, init?: RouteRenderInit) => Promise<FeishuCardJson>;
  ephemeralSent: EphemeralDelivery[];
  ephemeralDeleted: string[];
  /** 本次 Action 发出或更新的会话卡片。 */
  messagesSent: MessageDelivery[];
  /** 命中的路由模式，如 `/item/[id]`。 */
  pattern: string;
  /** 具体路径，如 `/item/42`。 */
  pathname: string;
  params: Record<string, string | string[]>;
  searchParams: SearchParams;
  /** 用户通过 setCardState 保存、随卡片往返的数据。 */
  userState: unknown;
  toast?: Toast;
  /** 为 true 时，回调只回 toast，不把重新渲染的卡片交回飞书。 */
  leaveCard?: boolean;
  operator?: Operator;
  message: MessageContext;
  formValue?: Record<string, unknown>;
  /** 本次点击的原始 value（含协议字段）。 */
  actionValue?: Record<string, unknown>;
  actionOption?: string;
  hops: number;
  forceNotFound?: boolean;
}

export const larkletStorage = new AsyncLocalStorage<LarkletStore>();

export function readStore(): LarkletStore | undefined {
  return larkletStorage.getStore();
}

export function useStore(): LarkletStore {
  const store = larkletStorage.getStore();
  if (!store) {
    throw new Error('只能在卡片渲染或 Server Action 中读取请求上下文');
  }
  return store;
}

export function params<T extends Record<string, string | string[]> = Record<string, string | string[]>>(): T {
  return useStore().params as T;
}

export function searchParams(): SearchParams {
  return useStore().searchParams;
}

export function operator(): Operator | undefined {
  return useStore().operator;
}

export function messageContext(): MessageContext {
  return useStore().message;
}

export function formValue<T extends Record<string, unknown> = Record<string, unknown>>(): T {
  return (useStore().formValue ?? {}) as T;
}

export function actionValue(): Record<string, unknown> {
  return useStore().actionValue ?? {};
}

export function actionOption(): string | undefined {
  return useStore().actionOption;
}

export function getCardState<T>(): T | undefined {
  return useStore().userState as T | undefined;
}

/** 当前应用的飞书凭证。未配置时返回 undefined。 */
export function feishuCredentials(): FeishuAppConfig | undefined {
  const { appId, appSecret } = useStore();
  if (!appId || !appSecret) return undefined;
  return { appId, appSecret };
}

export function setCardState<T>(value: T): void {
  const store = useStore();
  if (store.phase !== 'action') {
    throw new Error('setCardState 只能在 Server Action 里调用');
  }
  store.userState = value;
}
