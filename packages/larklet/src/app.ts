import path from 'node:path';

import { ACTION_ID_KEY, ACTION_PARAMS_KEY, getRegisteredAction } from '@open-feishu-card/components';
import type { FeishuCardJson } from '@open-feishu-card/components';

import { decryptBody, normalizeIncoming, type CardAction, type MenuEvent } from './events.js';
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
}

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
}

export type LarkletHandled =
  | { type: 'challenge'; challenge: string }
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

  async function currentRoutes(): Promise<Route[]> {
    if (!options.dev) return routes;
    routes = await loadRoutes(appDir);
    return routes;
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
    const incoming = normalizeIncoming(decoded);
    if (incoming.kind === 'ignore') return { type: 'empty' };
    if (incoming.kind === 'challenge') {
      assertToken(options.verificationToken, incoming.token);
      return { type: 'challenge', challenge: incoming.challenge };
    }
    if (incoming.kind === 'menu') {
      assertToken(options.verificationToken, incoming.menu.verificationToken);
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
    assertToken(options.verificationToken, incoming.action.verificationToken);
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

function assertToken(expected: string | undefined, actual: string | undefined): void {
  if (!expected || !actual) return;
  if (expected !== actual) throw new LarkletError('verification token 不匹配', 401);
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
