import path from 'node:path';

import { ACTION_ID_KEY, ACTION_PARAMS_KEY, getRegisteredAction } from '@open-feishu-card/components';
import type { FeishuCardJson } from '@open-feishu-card/components';

import { decryptBody, normalizeIncoming, readEvent, type CardAction, type LarkletEvent, type MenuEvent } from './events.js';
import {
  handlersForEvent,
  loadEventHandlers,
  type LarkletEventHandler,
  type LarkletEventHandlers,
} from './event-handlers.js';
import { isNotFoundError, isRedirectError } from './navigation.js';
import { renderCard, type RenderedCard } from './render.js';
import {
  larkletStorage,
  type EphemeralDelivery,
  type LarkletStore,
  type MessageDelivery,
  type Operator,
  type RouteRenderInit,
  type SearchParams,
  type Toast,
} from './request.js';
import { loadRoutes, matchRoute, type PreviewScene, type Route } from './router.js';
import { readEnvelope } from './state.js';
import { parseHref } from './href.js';

export class LarkletError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'LarkletError';
    this.status = status;
  }
}

export interface CreateLarkletOptions {
  /** 应用根目录，下面要有 `app/`。默认 `process.cwd()`。 */
  dir?: string;
  /** 为 true 时每次渲染重新扫描 `app/`。 */
  dev?: boolean;
  verificationToken?: string;
  encryptKey?: string;
  /** 飞书应用 App ID，与 `appSecret` 成对配置。 */
  appId?: string;
  /** 飞书应用 App Secret，与 `appId` 成对配置。 */
  appSecret?: string;
  /**
   * 先于默认分发处理飞书事件。可以传一个函数（收到所有事件），
   * 也可以传 `{ 事件类型: 处理函数 }`；键支持 `im.chat.*` 前缀通配和 `*` 兜底。
   * 处理函数返回 `undefined` 表示放行，继续后面的处理函数，最后走默认分发。
   */
  onEvent?: LarkletEventHandler | Record<string, LarkletEventHandler>;
}

export type { LarkletEvent, LarkletEventHandler, LarkletEventHandlers };

export interface RenderInit {
  searchParams?: SearchParams;
  userState?: unknown;
  operator?: LarkletStore['operator'];
  message?: LarkletStore['message'];
}

export interface HandleOptions {
  /**
   * 为 true 时，`sendEphemeral` / `deleteEphemeral` / `sendCard` / `updateCard` 不请求飞书，
   * 结果留在 `LarkletHandled.ephemeral` / `deletedEphemeral` / `messages`。本地预览使用。
   */
  captureEphemeral?: boolean;
  /**
   * 事件已经由传输层验明身份（长连接用 app_id / app_secret 握手，或本地预览）。
   * 为 true 时不再比对 verification token。只在你自己实现了等价鉴权的通道上传。
   */
  trustedTransport?: boolean;
  /** 事件来自哪里，会原样交给 `onEvent`。 */
  transport?: LarkletEvent['transport'];
  /**
   * 为 true 时这个 body 是调用方自己拼的（本地预览），不算飞书事件，
   * 不交给 `onEvent` / `app/events.*`，只走卡片回调与菜单的默认分发。
   */
  synthetic?: boolean;
}

/** 业务自己接管的事件。`response` 原样作为回调响应回传给飞书。 */
export interface LarkletRawHandled {
  type: 'raw';
  eventType: string;
  response: unknown;
}

export type LarkletHandled =
  | { type: 'challenge'; challenge: string }
  | LarkletRawHandled
  | {
      type: 'card';
      toast?: Toast;
      /** 为 true 时回调响应不带 card，飞书保持原卡片。 */
      leaveCard?: boolean;
      card: FeishuCardJson;
      controls: RenderedCard['controls'];
      /** 本次 Action 发出的、仅特定人可见的卡片。 */
      ephemeral: EphemeralDelivery[];
      /** 本次 Action 删除的私卡 message id。 */
      deletedEphemeral: string[];
      /** 本次 Action 发出或更新的会话卡片。 */
      messages: MessageDelivery[];
    }
  | {
      type: 'menu';
      eventKey: string;
      operator: Operator;
      /** 群聊斜杠命令时有值，投递目标为该群。 */
      chatId?: string;
      chatType?: string;
      card: FeishuCardJson;
      controls: RenderedCard['controls'];
    }
  | { type: 'empty' };

export interface LarkletApp {
  readonly dir: string;
  /** 已配置的飞书 App ID。 */
  readonly appId?: string;
  /** 已配置的飞书 App Secret。 */
  readonly appSecret?: string;
  render(href?: string, init?: RenderInit): Promise<RenderedCard>;
  handle(body: unknown, options?: HandleOptions): Promise<LarkletHandled>;
  /** 开发预览用。页面导出 `previewScene` 时返回它。 */
  previewScene(href?: string): Promise<PreviewScene | undefined>;
}

export async function createLarklet(options: CreateLarkletOptions = {}): Promise<LarkletApp> {
  const dir = path.resolve(options.dir ?? process.cwd());
  const appDir = path.join(dir, 'app');
  const { appId, appSecret } = resolveAppCredentials(options.appId, options.appSecret);
  let routes = await loadRoutes(appDir);
  // 显式传入的 `onEvent` 与 `app/events.*` 按声明顺序各跑一遍。
  const inlineHandlers = normalizeOnEvent(options.onEvent);
  let fileHandlers = await loadEventHandlers(appDir);

  async function currentRoutes(): Promise<Route[]> {
    if (!options.dev) return routes;
    routes = await loadRoutes(appDir);
    return routes;
  }

  async function dispatchEvent(event: LarkletEvent): Promise<unknown> {
    if (options.dev) fileHandlers = await loadEventHandlers(appDir);
    // 显式传入的 `onEvent` 先跑，`app/events.*` 后跑；各自内部精确匹配先于通配。
    const handlers = [
      ...handlersForEvent(inlineHandlers, event.eventType),
      ...handlersForEvent(fileHandlers, event.eventType),
    ];
    for (const handler of handlers) {
      const response = await handler(event);
      if (response !== undefined) return response;
    }
    return undefined;
  }

  async function renderRoute(href: string, init?: RouteRenderInit): Promise<FeishuCardJson> {
    const rendered = await render(href, init);
    return rendered.card;
  }

  async function render(href = '/', init: RenderInit = {}): Promise<RenderedCard> {
    const parsed = parseHref(href);
    const active = await currentRoutes();
    const store = createStore({
      pathname: parsed.pathname,
      searchParams: init.searchParams ?? parsed.searchParams,
      userState: init.userState,
      operator: init.operator,
      message: init.message ?? {},
      appId,
      appSecret,
      renderRoute,
    });
    return larkletStorage.run(store, () => renderCard(active, store));
  }

  async function handle(body: unknown, handleOptions: HandleOptions = {}): Promise<LarkletHandled> {
    const decoded = decryptBody(body, options.encryptKey);
    const assertToken = (actual: string | undefined): void => {
      assertVerificationToken(options.verificationToken, actual, handleOptions.trustedTransport);
    };

    // 业务入口先看所有事件；返回 undefined 才走卡片回调 / 菜单的默认分发。
    // 本地预览自己拼的卡片回调没有 event_id，不算业务事件。
    const event = readEvent(decoded, {
      transport: handleOptions.transport,
      synthetic: handleOptions.synthetic,
    });
    if (event) {
      assertToken(event.token);
      const response = await dispatchEvent(event);
      if (response !== undefined) return { type: 'raw', eventType: event.eventType, response };
    }

    const incoming = normalizeIncoming(decoded);
    if (incoming.kind === 'ignore') return { type: 'empty' };
    if (incoming.kind === 'challenge') {
      assertToken(incoming.token);
      return { type: 'challenge', challenge: incoming.challenge };
    }
    if (incoming.kind === 'menu') {
      assertToken(incoming.menu.verificationToken);
      const rendered = await dispatchMenu(await currentRoutes(), incoming.menu, {
        appId,
        appSecret,
        renderRoute,
        captureEphemeral: handleOptions.captureEphemeral,
      });
      return {
        type: 'menu',
        eventKey: incoming.menu.eventKey,
        operator: incoming.menu.operator,
        chatId: incoming.menu.chatId,
        chatType: incoming.menu.chatType,
        card: rendered.card,
        controls: rendered.controls,
      };
    }
    assertToken(incoming.action.verificationToken);
    const rendered = await dispatchAction(await currentRoutes(), incoming.action, {
      appId,
      appSecret,
      renderRoute,
      captureEphemeral: handleOptions.captureEphemeral,
    });
    return {
      type: 'card',
      toast: rendered.toast,
      leaveCard: rendered.leaveCard,
      card: rendered.card,
      controls: rendered.controls,
      ephemeral: rendered.ephemeral,
      deletedEphemeral: rendered.deletedEphemeral,
      messages: rendered.messages,
    };
  }

  async function previewScene(href = '/'): Promise<PreviewScene | undefined> {
    const parsed = parseHref(href);
    const active = await currentRoutes();
    return matchRoute(active, parsed.pathname)?.route.previewScene;
  }

  return { dir, appId, appSecret, render, handle, previewScene };
}

/** 飞书回调要求的响应体。`leaveCard` 时不带 card，客户端保持原卡片。 */
export function toCallbackResponse(result: { card: FeishuCardJson; toast?: Toast; leaveCard?: boolean }): {
  toast?: Toast;
  card?: { type: 'raw'; data: FeishuCardJson };
} {
  if (result.leaveCard) return result.toast ? { toast: result.toast } : {};
  return {
    toast: result.toast,
    card: { type: 'raw', data: result.card },
  };
}

interface DispatchContext {
  appId?: string;
  appSecret?: string;
  captureEphemeral?: boolean;
  renderRoute: (href: string, init?: RouteRenderInit) => Promise<FeishuCardJson>;
}

async function dispatchMenu(
  routes: Route[],
  menu: MenuEvent,
  credentials: DispatchContext,
): Promise<RenderedCard> {
  const eventKey = menu.eventKey.trim();
  if (!eventKey) throw new LarkletError('菜单事件缺少 event_key');
  const parsed = parseHref(eventKey);
  const store = createStore({
    pathname: parsed.pathname,
    searchParams: parsed.searchParams,
    operator: menu.operator,
    message: {
      openMessageId: menu.messageId,
      openChatId: menu.chatId,
    },
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    captureEphemeral: credentials.captureEphemeral,
    renderRoute: credentials.renderRoute,
  });
  return larkletStorage.run(store, () => renderCard(routes, store));
}

async function dispatchAction(
  routes: Route[],
  action: CardAction,
  credentials: DispatchContext,
): Promise<
  RenderedCard & {
    toast?: Toast;
    leaveCard?: boolean;
    ephemeral: EphemeralDelivery[];
    deletedEphemeral: string[];
    messages: MessageDelivery[];
  }
> {
  const envelope = readEnvelope(action.value, action.card);
  if (!envelope) {
    throw new LarkletError('回调里没有 Larklet 路由状态。请使用本框架渲染出的卡片。');
  }

  const store = createStore({
    phase: 'action',
    pattern: envelope.pattern,
    pathname: envelope.pathname,
    params: envelope.params,
    searchParams: envelope.search,
    userState: envelope.state,
    operator: action.operator,
    message: action.message,
    formValue: action.formValue,
    actionValue: action.value,
    actionOption: action.option,
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    captureEphemeral: credentials.captureEphemeral,
    renderRoute: credentials.renderRoute,
  });

  return larkletStorage.run(store, async () => {
    try {
      await invokeAction(store);
    } catch (error) {
      if (isRedirectError(error)) {
        // redirect() 已经改写 pathname / searchParams
      } else if (isNotFoundError(error)) {
        store.forceNotFound = true;
      } else {
        throw error;
      }
    }
    store.phase = 'render';
    const rendered = await renderCard(routes, store);
    return {
      ...rendered,
      toast: store.toast,
      leaveCard: store.leaveCard,
      ephemeral: store.ephemeralSent,
      deletedEphemeral: store.ephemeralDeleted,
      messages: store.messagesSent,
    };
  });
}

async function invokeAction(store: LarkletStore): Promise<void> {
  const value = store.actionValue ?? {};
  const id = value[ACTION_ID_KEY];
  if (typeof id !== 'string' || !id) {
    throw new LarkletError('回调 value 缺少 __action_id');
  }
  const fn =
    getRegisteredAction(id) ??
    getRegisteredAction(`${store.pattern}#${id}`) ??
    getRegisteredAction(`${store.pattern}#${id.split('#').pop()}`);
  if (!fn) {
    throw new LarkletError(`找不到 Server Action：${id}`);
  }
  const params = Array.isArray(value[ACTION_PARAMS_KEY]) ? value[ACTION_PARAMS_KEY] : [];
  await (fn as (...args: unknown[]) => unknown)(...params);
}

function resolveAppCredentials(appId: string | undefined, appSecret: string | undefined): { appId?: string; appSecret?: string } {
  const id = appId?.trim() || undefined;
  const secret = appSecret?.trim() || undefined;
  if (Boolean(id) !== Boolean(secret)) {
    throw new LarkletError('app_id 与 app_secret 需要同时配置');
  }
  return { appId: id, appSecret: secret };
}

/**
 * 配置了 verification token 时，HTTP 等未鉴权通道必须带上它。
 * 长连接和本地预览由 `trustedTransport` 放行 —— 它们分别靠 app 凭证握手和 dev 开关把关。
 */
function assertVerificationToken(expected: string | undefined, actual: string | undefined, trusted = false): void {
  if (!expected || trusted) return;
  if (!actual) throw new LarkletError('请求缺少 verification token', 401);
  if (expected !== actual) throw new LarkletError('verification token 不匹配', 401);
}

/** `onEvent` 可以是一个函数，也可以是 `{ 事件类型: 处理函数 }`。 */
function normalizeOnEvent(
  onEvent: CreateLarkletOptions['onEvent'],
): LarkletEventHandlers {
  if (!onEvent) return new Map();
  if (typeof onEvent === 'function') return new Map([['*', onEvent]]);
  return new Map(Object.entries(onEvent));
}

function createStore(partial: Partial<LarkletStore> & { pathname: string }): LarkletStore {
  return {
    phase: partial.phase ?? 'render',
    pattern: partial.pattern ?? '/',
    pathname: partial.pathname,
    params: partial.params ?? {},
    searchParams: partial.searchParams ?? {},
    userState: partial.userState,
    toast: partial.toast,
    operator: partial.operator,
    message: partial.message ?? {},
    formValue: partial.formValue,
    actionValue: partial.actionValue,
    actionOption: partial.actionOption,
    appId: partial.appId,
    appSecret: partial.appSecret,
    captureEphemeral: partial.captureEphemeral ?? false,
    renderRoute: partial.renderRoute,
    ephemeralSent: [],
    ephemeralDeleted: [],
    messagesSent: [],
    hops: partial.hops ?? 0,
    forceNotFound: partial.forceNotFound,
  };
}
