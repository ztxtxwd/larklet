/**
 * 配套网页的浏览器运行时：飞书 H5 SDK、JSAPI 鉴权、用户身份、消息与会话读取。
 *
 * 这里不依赖 React，也不渲染任何东西。React 开发者用 `larklet-web/react`
 * 的 `useCompanion`；其他框架可以直接用 `CompanionSession` 或这些函数。
 */

import { chatInfoAttempts, type PlusChatType } from './launch.js';

const H5_SDK = 'https://lf1-cdn-tos.bytegoofy.com/goofy/lark/op/h5-js-sdk-1.5.40.js';

/**
 * 网页应用免登申请的权限。
 *
 * 读消息只要 `im:message`；以用户身份发消息还要 `im:message.send_as_user`。
 * 申请了应用没开通的用户身份权限，飞书会直接报错（20027），授权整个中断，
 * 所以读消息那条路不去申请发消息的权限。
 */
export const USER_READ_SCOPES = ['im:message'];
export const USER_SEND_SCOPES = ['im:message', 'im:message.send_as_user'];

/** 以谁的身份发送：用户本人，或机器人。 */
export type SendAs = 'user' | 'bot';
/** 发到哪里：当前打开本页的会话，或让用户再选一个。 */
export type SendTarget = 'current' | 'picked';

/** `/api/config` 返回的配置。 */
export interface CompanionConfig {
  appId: string;
  allowDirectMessageId: boolean;
  title: string;
  /** 免登时申请的权限。 */
  scopes: string[];
  sendScopes: string[];
  /** 开发时的 Larklet 预览根地址。 */
  previewUrl?: string;
  /** 开发时在浏览器里直接打开页面。 */
  localPreview?: boolean;
}

/** 机器人目录里的一个应用。 */
export interface ListedApp {
  href: string;
  title: string;
  description: string;
  intro?: string;
}

export interface ChatPick {
  chatId: string;
  name: string;
}

/** 读消息的结果。读不到不算异常，错误文案交给页面显示。 */
export interface MessageRead {
  ok: boolean;
  msgType: string;
  error: string;
}

export interface UserAuth {
  accessToken: string;
  expiresAt: number;
  /** 这个 token 授权时申请的权限。空的表示只要了用户身份。 */
  scopes?: string[];
  openId?: string;
  name?: string;
  avatarUrl?: string;
}

export interface SendResult {
  ok: boolean;
  error: string;
  messageId?: string;
}

/** 飞书消息类型。快捷操作对所有类型都开放，这里只把类型翻成人话。 */
export const MESSAGE_TYPES: Record<string, string> = {
  text: '文本消息',
  image: '图片消息',
  post: '富文本消息',
  media: '视频消息',
  file: '文件消息',
  audio: '音频消息',
  sticker: '表情消息',
  interactive: '卡片消息',
  merge_forward: '合并转发消息',
  system: '系统消息',
  unsupport: '暂不支持的消息类型',
};

export function messageTypeLabel(messageType?: string): string {
  if (!messageType) return '未知消息类型';
  return MESSAGE_TYPES[messageType] || messageType;
}

/** UA 像不像飞书。还要配合 H5 SDK 的全局对象一起判断。 */
export function isFeishuUserAgent(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /Lark|Feishu/i.test(userAgent);
}

let sdkLoading: Promise<void> | null = null;

/**
 * 加载飞书 H5 SDK。
 *
 * 不在飞书里就完全不加载：这段脚本会无条件往 window 上挂 tt / h5sdk，
 * 会让环境判定失真。
 */
export function loadH5Sdk(userAgent?: string): Promise<void> {
  if (!isFeishuUserAgent(userAgent)) return Promise.resolve();
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.h5sdk && window.tt) return Promise.resolve();
  if (sdkLoading) return sdkLoading;
  sdkLoading = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = H5_SDK;
    script.onload = () => resolve();
    script.onerror = () => {
      sdkLoading = null;
      reject(new Error('飞书 JSSDK 加载失败'));
    };
    document.head.appendChild(script);
  });
  return sdkLoading;
}

let jsapiReady: Promise<void> | null = null;

/** 用服务端签名配置 JSAPI。`pageUrl` 必须是不带 hash 的当前地址。 */
export function configJsapi(pageUrl: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (jsapiReady) return jsapiReady;
  const ready = fetchJson<{
    ok: boolean;
    error?: string;
    appId?: string;
    timestamp?: number;
    nonceStr?: string;
    signature?: string;
  }>('/api/jsapi-signature', { url: pageUrl }, fetchImpl).then((cfg) => {
    if (!cfg.ok || !cfg.appId || !cfg.signature || cfg.timestamp == null || !cfg.nonceStr) {
      throw new Error(cfg.error || '鉴权参数获取失败');
    }
    const h5sdk = typeof window === 'undefined' ? undefined : window.h5sdk;
    if (!h5sdk) throw new Error('未检测到飞书 JSSDK');
    return new Promise<void>((resolve, reject) => {
      h5sdk.error((err) => reject(new Error(`h5sdk 鉴权失败：${formatAccessError(err)}`)));
      h5sdk.config({
        appId: cfg.appId,
        timestamp: cfg.timestamp,
        nonceStr: cfg.nonceStr,
        signature: cfg.signature,
        jsApiList: [
          'getBlockActionSourceDetail',
          'getTriggerContext',
          'getChatInfo',
          'requestAccess',
          'requestAuthCode',
          'chooseChat',
        ],
        onSuccess: () => h5sdk.ready(() => resolve()),
        onFail: (err: unknown) => reject(new Error(`config 失败：${formatAccessError(err)}`)),
      });
    });
  });
  jsapiReady = ready.catch((error: unknown) => {
    jsapiReady = null;
    throw error;
  });
  return jsapiReady;
}

/** 来源消息。快捷操作对所有消息类型都开放，不只卡片。 */
export function sourceMessageId(triggerCode: string): Promise<string> {
  const tt = window.tt;
  if (!tt?.getBlockActionSourceDetail) return Promise.reject(new Error('当前环境不能读取来源消息'));
  return new Promise((resolve, reject) => {
    tt.getBlockActionSourceDetail?.({
      triggerCode,
      success: (res: { content?: { messages?: Array<{ messageType?: string; openMessageId?: string }> } }) => {
        const message = res?.content?.messages?.[0];
        if (!message) {
          reject(new Error('未取到来源消息'));
          return;
        }
        if (!message.openMessageId) {
          reject(new Error('来源消息缺少 openMessageId'));
          return;
        }
        resolve(message.openMessageId);
      },
      fail: (err: unknown) => reject(new Error(`获取消息失败：${formatAccessError(err)}`)),
    });
  });
}

/** 加号菜单当前会话。 */
export function currentChatId(triggerCode: string): Promise<string> {
  const tt = window.tt;
  if (!tt?.getTriggerContext) return Promise.reject(new Error('当前环境不能读取会话'));
  return new Promise((resolve, reject) => {
    tt.getTriggerContext?.({
      triggerCode,
      success: (res: { openChatId?: string }) => {
        if (!res?.openChatId) {
          reject(new Error('未取到当前会话'));
          return;
        }
        resolve(res.openChatId);
      },
      fail: (err: unknown) => reject(new Error(`获取会话失败：${formatAccessError(err)}`)),
    });
  });
}

/**
 * 当前会话的名称。读不到就抛错，调用方自己决定要不要显示。
 *
 * 单聊要带 userType，群聊不用。PC 能从 `from` 看出是哪种会话，
 * 移动端看不出来，就群聊、单聊各试一次。
 */
export async function chatNameOf(openChatId: string, chatType: PlusChatType): Promise<string> {
  const tt = window.tt;
  if (!tt?.getChatInfo) throw new Error('当前环境不能读取会话信息');
  let lastError: unknown;
  for (const [type, user] of chatInfoAttempts(chatType)) {
    try {
      const info = await readChatInfo(openChatId, type, user);
      if (info.name) return info.name;
      lastError = new Error('没有读到会话名称');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('读取会话信息失败');
}

function readChatInfo(openChatId: string, chatType: 0 | 1, userType: 0 | 1): Promise<{ name: string }> {
  const tt = window.tt;
  const getChatInfo = tt?.getChatInfo;
  if (!getChatInfo) return Promise.reject(new Error('当前环境不能读取会话信息'));
  return new Promise((resolve, reject) => {
    getChatInfo.call(tt, {
      openChatId,
      chatType,
      userType,
      success: (res: { name?: string; i18nNames?: { zh_cn?: string } }) => {
        resolve({ name: res?.name || res?.i18nNames?.zh_cn || '' });
      },
      fail: (err: unknown) => reject(new Error(`获取会话信息失败：${formatAccessError(err)}`)),
    });
  });
}

/**
 * 网页应用免登：拿授权码换 user_access_token，顺带取回当前用户。
 * 授权过且没过期就复用缓存。
 *
 * `scopes` 是这次要的权限。缓存里的 token 没覆盖到，就重新授权一次：
 * 加号菜单只拿用户身份（空列表），读消息要 `im:message`，两者的 token 不能混用。
 */
export function ensureUserToken(
  appId: string,
  current: UserAuth | null,
  save: (auth: UserAuth) => void,
  scopes: string[] = USER_READ_SCOPES,
  fetchImpl: typeof fetch = fetch,
): Promise<UserAuth> {
  if (
    current &&
    current.accessToken &&
    Date.now() < current.expiresAt - 60_000 &&
    coversScopes(current.scopes, scopes)
  ) {
    return Promise.resolve(current);
  }
  return new Promise((resolve, reject) => {
    const tt = typeof window === 'undefined' ? undefined : window.tt;
    const request = tt?.requestAccess || tt?.requestAuthCode;
    if (!request) {
      reject(new Error('请在飞书客户端内授权'));
      return;
    }
    if (!appId) {
      reject(new Error('缺少应用 appId'));
      return;
    }
    request.call(tt, {
      appID: appId,
      appId,
      scopeList: scopes.slice(),
      success: (res: { code?: string; authCode?: string }) => {
        const code = res?.code || res?.authCode;
        if (!code) {
          reject(new Error('未返回授权码'));
          return;
        }
        void fetchJson<{
          ok: boolean;
          error?: string;
          accessToken?: string;
          expiresIn?: number;
          openId?: string;
          name?: string;
          avatarUrl?: string;
        }>('/api/auth/callback', { code }, fetchImpl)
          .then((user) => {
            if (!user.ok || !user.accessToken) {
              reject(new Error(user.error || '换取用户凭证失败'));
              return;
            }
            const expiresIn = user.expiresIn && user.expiresIn > 0 ? user.expiresIn : 7200;
            const auth: UserAuth = {
              accessToken: user.accessToken,
              expiresAt: Date.now() + expiresIn * 1000,
              scopes: scopes.slice(),
              ...(user.openId ? { openId: user.openId } : {}),
              ...(user.name ? { name: user.name } : {}),
              ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
            };
            save(auth);
            resolve(auth);
          })
          .catch((error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
      },
      fail: (err: unknown) => reject(new Error(formatAccessError(err))),
    });
  });
}

/** 缓存的 token 能不能覆盖这次要的权限。 */
export function coversScopes(have: string[] | undefined, want: string[]): boolean {
  if (!want.length) return true;
  const owned = new Set(have ?? []);
  return want.every((scope) => owned.has(scope));
}

/** 弹出飞书选会话。用户取消时返回 null。 */
export function chooseChat(confirmText: string): Promise<ChatPick | null> {
  const tt = window.tt;
  if (!tt?.chooseChat) return Promise.reject(new Error('请在飞书客户端内选择会话'));
  return configJsapi(currentPageUrl()).then(
    () =>
      new Promise((resolve, reject) => {
        tt.chooseChat?.({
          multiSelect: false,
          allowCreateGroup: false,
          selectType: 0,
          externalChat: true,
          confirmTitle: '发送卡片',
          confirmText,
          success: (res: { data?: Array<{ id?: string; name?: string; i18nNames?: { zh_cn?: string } }> }) => {
            const chat = res?.data?.[0];
            if (!chat?.id) {
              resolve(null);
              return;
            }
            resolve({ chatId: chat.id, name: chat.name || chat.i18nNames?.zh_cn || '' });
          },
          fail: (err: unknown) => {
            const detail = err as JsapiError;
            const errno = detail?.errno ?? detail?.errCode;
            const text = detail?.errMsg || detail?.errString || '';
            if (errno === 10 || /cancel/i.test(text)) {
              resolve(null);
              return;
            }
            reject(new Error(`选择会话失败：${formatAccessError(err)}`));
          },
        });
      }),
  );
}

/** `/api/config`。 */
export async function fetchConfig(fetchImpl: typeof fetch = fetch): Promise<CompanionConfig> {
  const cfg = await fetchJson<CompanionConfig & { ok: boolean; error?: string }>('/api/config', undefined, fetchImpl);
  if (!cfg.ok) throw new Error(cfg.error || '配置读取失败');
  return cfg;
}

/** `/api/apps`：机器人的应用目录。 */
export async function loadApps(fetchImpl: typeof fetch = fetch): Promise<ListedApp[]> {
  const result = await fetchJson<{ ok: boolean; error?: string; apps?: ListedApp[] }>(
    '/api/apps',
    undefined,
    fetchImpl,
  );
  if (!result.ok) throw new Error(result.error || '读取应用列表失败');
  return Array.isArray(result.apps) ? result.apps : [];
}

/**
 * 读消息类型。
 *
 * `userAccessToken` 传空串就是让服务端用机器人身份读：机器人在会话里的话，
 * 不用用户授权就能读到。
 */
export async function readMessage(
  messageId: string,
  userAccessToken = '',
  fetchImpl: typeof fetch = fetch,
): Promise<MessageRead> {
  const result = await fetchJson<{ ok: boolean; error?: string; msgType?: string }>(
    '/api/message',
    { messageId, userAccessToken },
    fetchImpl,
  );
  if (!result.ok) return { ok: false, msgType: '', error: result.error || '读取消息失败' };
  return { ok: true, msgType: result.msgType || '', error: '' };
}

/** 按应用路径渲染一张新卡片并发到会话。 */
export async function sendAppRequest(
  input: { href: string; chatId: string; as: SendAs; userAccessToken?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  const result = await fetchJson<{ ok: boolean; error?: string; messageId?: string }>(
    '/api/apps/send',
    input,
    fetchImpl,
  );
  return {
    ok: result.ok,
    error: result.ok ? '' : result.error || '发送失败',
    ...(result.messageId ? { messageId: result.messageId } : {}),
  };
}

/** 开发时把卡片投进本地模拟群。 */
export async function deliverPreview(href: string, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  const result = await fetchJson<{ ok: boolean; error?: string; messageId?: string }>(
    '/api/preview/deliver',
    { href, kind: 'chat' },
    fetchImpl,
  );
  return {
    ok: result.ok,
    error: result.ok ? '' : result.error || '发送失败',
    ...(result.messageId ? { messageId: result.messageId } : {}),
  };
}

/** 当前页面地址，不带 hash。 */
export function currentPageUrl(): string {
  return window.location.origin + window.location.pathname + window.location.search;
}

export function formatAccessError(err: unknown): string {
  if (!err) return '授权失败';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  const detail = err as JsapiError;
  const errno = detail.errno ?? detail.errCode;
  const text = detail.errString || detail.errMsg || detail.errorMessage || detail.msg || '';
  if (text) return text.replace(/^requestAccess\s*fail[:\s]*/i, '') || '授权失败';
  if (errno != null) return `授权失败（errno ${errno}）`;
  return '授权失败';
}

export async function fetchJson<T>(url: string, body?: object, fetchImpl: typeof fetch = fetch): Promise<T> {
  const response = await fetchImpl(
    url,
    body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : undefined,
  );
  return response.json() as Promise<T>;
}

interface JsapiError {
  errno?: number;
  errCode?: number;
  errString?: string;
  errMsg?: string;
  errorMessage?: string;
  msg?: string;
}

declare global {
  interface Window {
    h5sdk?: {
      config: (opts: Record<string, unknown>) => void;
      ready: (cb: () => void) => void;
      error: (cb: (err: unknown) => void) => void;
    };
    tt?: {
      requestAccess?: (opts: Record<string, unknown>) => void;
      requestAuthCode?: (opts: Record<string, unknown>) => void;
      chooseChat?: (opts: Record<string, unknown>) => void;
      getBlockActionSourceDetail?: (opts: Record<string, unknown>) => void;
      getTriggerContext?: (opts: Record<string, unknown>) => void;
      getChatInfo?: (opts: Record<string, unknown>) => void;
    };
  }
}

