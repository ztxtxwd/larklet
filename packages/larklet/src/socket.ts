import { EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';

import { LarkletError, toCallbackResponse, type LarkletApp } from './app.js';
import { deliverMenuCard, resolveOpenApiBase } from './feishu.js';

const CARD_ACTION = 'card.action.trigger';
const BOT_MENU = 'application.bot.menu_v6';
const MESSAGE_RECEIVE = 'im.message.receive_v1';

const APP_ID = /^cli_[0-9a-fA-F]{16}$/;

export interface FeishuSocket {
  close(): void;
}

/** SDK 把 header 和 event 摊平了。还原成 `handle()` 认识的信封，校验交给 SDK。 */
export function envelopeFromSocket(eventType: string, data: unknown): { header: { event_type: string }; event: unknown } {
  return { header: { event_type: eventType }, event: data };
}

/** 长连接上的一次事件。卡片回调把响应体交回去；菜单 / 斜杠命令由机器人发出（群聊进群，否则私聊）。 */
export async function replyToSocket(app: LarkletApp, eventType: string, data: unknown): Promise<unknown> {
  const handled = await app.handle(envelopeFromSocket(eventType, data));
  if (handled.type === 'card') return toCallbackResponse(handled);
  if (handled.type === 'menu') {
    if (app.appId && app.appSecret) {
      await deliverMenuCard(app.appId, app.appSecret, handled);
    }
    return {};
  }
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
}): FeishuSocket {
  if (!APP_ID.test(options.appId)) {
    throw new LarkletError(`app_id 格式无法建立长连接：${options.appId}`);
  }

  const dispatcher = new EventDispatcher({
    verificationToken: options.verificationToken,
    encryptKey: options.encryptKey,
    loggerLevel: LoggerLevel.info,
  }).register({
    [BOT_MENU]: (data) => replyToSocket(options.app, BOT_MENU, data),
    [MESSAGE_RECEIVE]: (data) => replyToSocket(options.app, MESSAGE_RECEIVE, data),
    [CARD_ACTION]: (data: unknown) => replyToSocket(options.app, CARD_ACTION, data),
  });

  const domain = resolveOpenApiBase(options.domain);
  const client = new WSClient({
    appId: options.appId,
    appSecret: options.appSecret,
    domain,
    loggerLevel: LoggerLevel.info,
  });
  console.log(`[larklet] websocket ${domain}`);
  void client.start({ eventDispatcher: dispatcher });
  return {
    close: () => client.close({ force: true }),
  };
}
