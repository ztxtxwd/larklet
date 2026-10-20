import { EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';

import { LarkletError, toCallbackResponse, type LarkletApp, type LarkletHandled } from './app.js';
import { readEvent } from './events.js';
import { deliverMenuCard, resolveOpenApiBase } from './feishu.js';

const APP_ID = /^cli_[0-9a-fA-F]{16}$/;

/** SDK 摊平事件时放在顶层的 header 字段；还原信封时从这里取回。 */
const HEADER_FIELDS = ['event_id', 'token', 'tenant_key', 'app_id', 'create_time', 'schema'] as const;

export interface FeishuSocket {
  close(): void;
}

/**
 * SDK 把 header 和 event 摊平了。还原成 `handle()` 认识的信封。
 * 保留 header 里的 token / tenant_key / app_id，让长连接事件和 webhook 形状一致。
 */
export function envelopeFromSocket(
  eventType: string,
  data: unknown,
  header: Record<string, unknown> = {},
): { header: Record<string, unknown>; event: unknown } {
  const flattened = isRecord(data) ? data : {};
  const envelopeHeader: Record<string, unknown> = { event_type: eventType };
  for (const field of HEADER_FIELDS) {
    const value = header[field] ?? flattened[field];
    if (value !== undefined) envelopeHeader[field] = value;
  }
  return { header: envelopeHeader, event: data };
}

/**
 * 长连接上的一次事件。卡片回调把响应体交回去；菜单 / 斜杠命令由机器人发出（群聊进群，否则私聊）。
 * 长连接由 app_id / app_secret 握手建立，事件不经过 HTTP，因此标记为可信通道。
 * 业务在 `createLarklet({ onEvent })` 里先拿到事件，没接管的才走这里。
 */
export async function replyToSocket(
  app: LarkletApp,
  eventType: string,
  data: unknown,
  header: Record<string, unknown> = {},
): Promise<unknown> {
  const handled = await app.handle(envelopeFromSocket(eventType, data, header), {
    trustedTransport: true,
    transport: 'socket',
  });
  return socketResponse(app, handled);
}

async function socketResponse(app: LarkletApp, handled: LarkletHandled): Promise<unknown> {
  if (handled.type === 'card') return toCallbackResponse(handled);
  if (handled.type === 'raw') return handled.response;
  if (handled.type === 'menu') {
    if (app.appId && app.appSecret) {
      await deliverMenuCard(app.appId, app.appSecret, handled);
    }
    return {};
  }
  if (handled.type === 'challenge') return { challenge: handled.challenge };
  return {};
}

/** 与飞书建立长连接，接收卡片回调、机器人菜单和斜杠命令消息。 */
export function startFeishuSocket(options: {
  appId: string;
  appSecret: string;
  app: LarkletApp;
  /** `Feishu`、`Lark`，或完整开放平台根地址。默认读 `LARK_DOMAIN`。 */
  domain?: string;
  verificationToken?: string;
  encryptKey?: string;
  /** 长连接可用时回调，用于日志。 */
  onReady?: () => void;
  /** 连接失败、重试耗尽时回调；默认打一条警告。 */
  onError?: (error: Error) => void;
}): FeishuSocket {
  if (!APP_ID.test(options.appId)) {
    throw new LarkletError(`app_id 格式无法建立长连接：${options.appId}`);
  }

  // 不再用 `register`：它只认精确事件名、没有通配符，未注册的事件会被丢掉。
  // 所有事件统一经 `handle()`，业务 hook 和默认分发都能看到。
  const dispatcher = new LarkletEventDispatcher({
    verificationToken: options.verificationToken,
    encryptKey: options.encryptKey,
    loggerLevel: LoggerLevel.info,
    app: options.app,
  });

  const domain = resolveOpenApiBase(options.domain);
  const client = new WSClient({
    appId: options.appId,
    appSecret: options.appSecret,
    domain,
    loggerLevel: LoggerLevel.info,
    onReady: options.onReady,
    onError: options.onError ?? ((error) => console.warn('[larklet] 长连接异常：', error.message)),
  });
  console.log(`[larklet] websocket ${domain}`);
  void client.start({ eventDispatcher: dispatcher });
  return {
    close: () => client.close({ force: true }),
  };
}

/**
 * 长连接把原始事件体交给 `invoke`。2.0 和 1.0 事件都从这里进 `handle()`，
 * 业务 hook、默认分发和未知事件都能看到，未注册事件也不再消失。
 */
class LarkletEventDispatcher extends EventDispatcher {
  private readonly app: LarkletApp;

  constructor(params: ConstructorParameters<typeof EventDispatcher>[0] & { app: LarkletApp }) {
    super(params);
    this.app = params.app;
  }

  override async invoke(data: unknown, params?: { needCheck?: boolean }): Promise<unknown> {
    const event = readEvent(data, { transport: 'socket' });
    // app_ticket 交给 SDK 缓存（ISV 应用换取 app_access_token 时要用）；
    // 认不出来的帧也交回 SDK，保持它原有的行为。
    if (!event || event.eventType === 'app_ticket') return super.invoke(data, params);
    const handled = await this.app.handle(data, { trustedTransport: true, transport: 'socket' });
    return socketResponse(this.app, handled);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
