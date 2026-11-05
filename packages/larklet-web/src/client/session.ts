import { plusChatType, readTriggerCode, sceneOf, type Scene } from './launch.js';
import {
  USER_READ_SCOPES,
  USER_SEND_SCOPES,
  chatNameOf,
  chooseChat as chooseChatWithFeishu,
  configJsapi,
  coversScopes,
  currentChatId,
  deliverPreview,
  ensureUserToken,
  fetchConfig,
  formatAccessError,
  isFeishuUserAgent,
  loadApps,
  loadH5Sdk,
  readMessage,
  sendAppRequest,
  sourceMessageId,
  type ChatPick,
  type CompanionConfig,
  type ListedApp,
  type SendAs,
  type SendResult,
  type SendTarget,
  type UserAuth,
} from './runtime.js';

/** 当前用户。飞书里登录的那个人。 */
export interface CompanionUser {
  /** 有没有拿到 user_access_token。 */
  authorized: boolean;
  /** 正在授权。 */
  authorizing: boolean;
  accessToken?: string;
  openId?: string;
  name?: string;
  avatarUrl?: string;
  scopes?: string[];
  error: string;
}

/** 消息快捷操作里读到的来源消息。 */
export interface CompanionMessage {
  messageId: string;
  msgType: string;
  reading: boolean;
  error: string;
  /** 机器人读不到，需要用户授权后再读。 */
  needUserAuth: boolean;
}

/** 加号菜单里的当前会话。 */
export interface CompanionChat {
  chatId: string;
  name: string;
  reading: boolean;
  error: string;
}

/** 会话的全部状态。任何一项变化都会触发订阅。 */
export interface CompanionState {
  /** 初始化流程跑完了。 */
  ready: boolean;
  /** 初始化流程正在进行。 */
  loading: boolean;
  scene: Scene;
  /** 确认在飞书客户端里（UA、H5 SDK、JSAPI 鉴权都通过）。 */
  inFeishu: boolean;
  /** 不在飞书里，但配置了本地预览。 */
  preview: boolean;
  config: CompanionConfig | null;
  /** 初始化失败。`message` / `chat` 自己的错误不放在这里。 */
  error: string;
  user: CompanionUser;
  message: CompanionMessage;
  chat: CompanionChat;
  /** 机器人的应用目录。 */
  apps: ListedApp[];
  appsLoading: boolean;
  appsError: string;
  /** 正在发送的应用路径，空串表示没有。 */
  sendingHref: string;
}

export interface SendAppOptions {
  as: SendAs;
  target: SendTarget;
}

export interface CompanionActions {
  /** 拿当前用户信息。只登录，不申请增量权限。 */
  authorizeUser: () => Promise<void>;
  /** 授权读消息，然后重读来源消息。 */
  authorizeMessage: () => Promise<void>;
  /** 重新读应用目录。 */
  reloadApps: () => Promise<ListedApp[]>;
  /** 按应用路径发一张新卡片。 */
  sendApp: (app: ListedApp | string, options: SendAppOptions) => Promise<SendResult>;
  /** 弹出飞书选会话。用户取消时返回 null。 */
  chooseChat: (confirmText?: string) => Promise<ChatPick | null>;
  /** 以当前用户身份发送需要的 user_access_token。必要时会弹出授权。 */
  requestUserToken: () => Promise<string>;
}

export interface Companion extends CompanionState, CompanionActions {}

export interface CompanionOptions {
  /** 自定义 fetch，主要给测试。 */
  fetchImpl?: typeof fetch;
  /** 覆盖当前地址，主要给测试/非浏览器环境。 */
  url?: URL;
  /** 覆盖 UA 判定，主要给测试。 */
  userAgent?: string;
}

/**
 * 配套网页的会话。
 *
 * 负责判断场景、配置 JSAPI、拿用户身份、读来源消息或当前会话。
 * 不渲染任何东西，也不依赖 React；`useCompanion` 只是它的一层订阅。
 */
export class CompanionSession {
  private readonly fetchImpl: typeof fetch;
  private readonly url: URL;
  private readonly userAgent: string;
  private readonly listeners = new Set<() => void>();
  private started = false;
  private auth: UserAuth | null = null;
  private state: CompanionState = {
    ready: false,
    loading: false,
    scene: '',
    inFeishu: false,
    preview: false,
    config: null,
    error: '',
    user: { authorized: false, authorizing: false, error: '' },
    message: { messageId: '', msgType: '', reading: false, error: '', needUserAuth: false },
    chat: { chatId: '', name: '', reading: false, error: '' },
    apps: [],
    appsLoading: false,
    appsError: '',
    sendingHref: '',
  };

  readonly actions: CompanionActions = {
    authorizeUser: () => this.authorizeUser(),
    authorizeMessage: () => this.authorizeMessage(),
    reloadApps: () => this.reloadApps(),
    sendApp: (app, options) => this.sendApp(app, options),
    chooseChat: (confirmText) => this.chooseChat(confirmText),
    requestUserToken: () => this.requestUserToken(),
  };

  constructor(options: CompanionOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.url = options.url ?? defaultUrl();
    this.userAgent = options.userAgent ?? defaultUserAgent();
  }

  getState(): CompanionState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 初始化。重复调用只会跑一次。 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.update({ loading: true });
    const params = this.url.searchParams;
    const scene = sceneOf(params, this.url.pathname);
    this.update({ scene });
    try {
      const config = await fetchConfig(this.fetchImpl);
      this.update({ config });

      if (!isFeishuUserAgent(this.userAgent)) {
        await this.outside(params, config);
        return;
      }

      try {
        await loadH5Sdk(this.userAgent);
      } catch {
        // JSSDK 加载失败按不在飞书里处理，页面还能走本地预览。
      }
      if (typeof window === 'undefined' || !window.h5sdk || !window.tt) {
        await this.outside(params, config);
        return;
      }

      const jsapiOk = await configJsapi(this.pageUrl(), this.fetchImpl).then(
        () => true,
        () => false,
      );
      if (!jsapiOk) {
        await this.outside(params, config);
        return;
      }
      this.update({ inFeishu: true });

      if (scene === 'plus') {
        await this.initPlus(params);
      } else if (scene === 'message') {
        await this.initMessage(params, config);
      } else {
        await this.initUnknown(params, config);
      }
    } catch (error) {
      this.update({ error: messageOf(error) });
    } finally {
      this.update({ loading: false, ready: true });
    }
  }

  /** 拿当前用户信息。只登录，不申请增量权限。 */
  async authorizeUser(): Promise<void> {
    try {
      await this.ensureToken([]);
    } catch (error) {
      this.setUser({ error: messageOf(error) });
    }
  }

  /** 授权读消息，然后重读来源消息。 */
  async authorizeMessage(): Promise<void> {
    const scopes = this.state.config?.scopes ?? USER_READ_SCOPES;
    try {
      await this.ensureToken(scopes);
    } catch (error) {
      this.setUser({ error: messageOf(error) });
      return;
    }
    if (this.state.message.messageId) {
      await this.readSourceMessage(this.state.message.messageId, scopes);
    }
  }

  /** 重新读应用目录。 */
  async reloadApps(): Promise<ListedApp[]> {
    this.update({ appsLoading: true, appsError: '' });
    try {
      const apps = await loadApps(this.fetchImpl);
      this.update({ apps, appsLoading: false });
      return apps;
    } catch (error) {
      const message = messageOf(error);
      this.update({ appsLoading: false, appsError: message });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  /** 按应用路径发一张新卡片。 */
  async sendApp(app: ListedApp | string, options: SendAppOptions): Promise<SendResult> {
    const href = typeof app === 'string' ? app : app.href;
    if (this.state.sendingHref) return { ok: false, error: '正在发送，请稍候' };

    if (this.state.preview) {
      if (options.as !== 'bot' || options.target !== 'current') {
        return { ok: false, error: '本地预览只能以机器人身份发到模拟群' };
      }
      this.update({ sendingHref: href });
      try {
        return await deliverPreview(href, this.fetchImpl);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      } finally {
        this.update({ sendingHref: '' });
      }
    }

    if (!this.state.inFeishu) {
      return { ok: false, error: '请从飞书聊天框的加号菜单打开后再发送' };
    }

    let chatId = this.state.chat.chatId;
    if (options.target === 'picked') {
      try {
        const chat = await this.chooseChat(options.as === 'user' ? '以我的身份发送' : '以机器人身份发送');
        if (!chat) return { ok: false, error: '已取消' };
        chatId = chat.chatId;
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    }
    if (!chatId) return { ok: false, error: '没有当前会话，无法发送' };

    this.update({ sendingHref: href });
    try {
      const userAccessToken = options.as === 'user' ? await this.requestUserToken() : undefined;
      return await sendAppRequest(
        {
          href,
          chatId,
          as: options.as,
          ...(userAccessToken ? { userAccessToken } : {}),
        },
        this.fetchImpl,
      );
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    } finally {
      this.update({ sendingHref: '' });
    }
  }

  /** 弹出飞书选会话。用户取消时返回 null。 */
  async chooseChat(confirmText = '发送'): Promise<ChatPick | null> {
    if (!this.state.inFeishu || typeof window === 'undefined' || !window.tt?.chooseChat) {
      throw new Error('请在飞书客户端内选择会话');
    }
    return chooseChatWithFeishu(confirmText);
  }

  /** 以当前用户身份发送需要的 user_access_token。必要时会弹出授权。 */
  async requestUserToken(): Promise<string> {
    if (!this.state.inFeishu) throw new Error('请在飞书客户端内授权');
    const scopes = this.state.config?.sendScopes ?? USER_SEND_SCOPES;
    const auth = await this.ensureToken(scopes);
    return auth.accessToken;
  }

  private async initPlus(params: URLSearchParams): Promise<void> {
    const triggerCode = readTriggerCode(params);
    if (!triggerCode) {
      this.update({ error: '未拿到会话触发参数，请从聊天框的加号菜单进入。' });
      return;
    }
    this.setChat({ reading: true, error: '' });
    try {
      const chatId = await currentChatId(triggerCode);
      this.setChat({ chatId });
      // 会话名读不到就算了，chat ID 才是要紧的。
      const name = await chatNameOf(chatId, plusChatType(params)).catch(() => '');
      this.setChat({ chatId, name, reading: false });
    } catch (error) {
      this.setChat({ reading: false, error: formatAccessError(error) });
    }
    await this.authorizeUser();
    await this.reloadApps().catch(() => []);
  }

  private async initMessage(params: URLSearchParams, config: CompanionConfig): Promise<void> {
    const directId = (params.get('message_id') || '').trim();
    if (directId && config.allowDirectMessageId) {
      this.setMessage({ messageId: directId });
      await this.authorizeUser();
      await this.readSourceMessage(directId, config.scopes);
      return;
    }
    const triggerCode = readTriggerCode(params);
    if (!triggerCode) {
      this.update({ error: '未拿到消息触发参数，请从消息的快捷应用进入。' });
      return;
    }
    let source = '';
    try {
      source = await sourceMessageId(triggerCode);
    } catch (error) {
      this.update({ error: messageOf(error) });
    }
    if (!source) return;
    this.setMessage({ messageId: source });
    // 当前用户：只要登录信息，不需要任何权限，也不会弹授权。
    await this.authorizeUser();
    await this.readSourceMessage(source, config.scopes);
  }

  private async initUnknown(params: URLSearchParams, config: CompanionConfig): Promise<void> {
    const directId = (params.get('message_id') || '').trim();
    if (directId && config.allowDirectMessageId) {
      this.setMessage({ messageId: directId });
      await this.authorizeUser();
      await this.readSourceMessage(directId, config.scopes);
      return;
    }
    await this.reloadApps().catch(() => []);
  }

  /** 不在飞书里：开发时可以带 `?message_id=`，否则只把应用目录读出来。 */
  private async outside(params: URLSearchParams, config: CompanionConfig): Promise<void> {
    this.update({ inFeishu: false });
    const directId = (params.get('message_id') || '').trim();
    if (directId && config.allowDirectMessageId) {
      this.setMessage({ messageId: directId });
      await this.readSourceMessage(directId, config.scopes);
      return;
    }
    if (this.state.scene === 'plus' || config.previewUrl || config.localPreview) {
      await this.reloadApps().catch(() => []);
    }
  }

  /**
   * 读这条消息的类型。
   *
   * 先让服务端用机器人身份读：机器人在这条消息的会话里的话，不用麻烦用户授权。
   * 机器人读不到（多半是机器人不在群里），才让用户授权，用用户身份再读一次。
   */
  private async readSourceMessage(messageId: string, scopes: string[]): Promise<void> {
    this.setMessage({ reading: true, error: '', needUserAuth: false });
    // 用户已经授权过并且覆盖得住这次要的权限，就直接用，不用再问机器人。
    if (!coversScopes(this.auth?.scopes, scopes)) {
      const asBot = await readMessage(messageId, '', this.fetchImpl).catch(() => null);
      if (asBot?.ok) {
        this.setMessage({ reading: false, msgType: asBot.msgType });
        return;
      }
    }
    let auth: UserAuth;
    try {
      auth = await this.ensureToken(scopes);
    } catch (error) {
      this.setUser({ error: messageOf(error) });
      this.setMessage({ reading: false, needUserAuth: true });
      return;
    }
    try {
      const info = await readMessage(messageId, auth.accessToken, this.fetchImpl);
      if (info.ok) {
        this.setMessage({ reading: false, msgType: info.msgType, error: '' });
      } else {
        this.setMessage({ reading: false, error: info.error });
      }
    } catch (error) {
      this.setMessage({ reading: false, error: messageOf(error) });
    }
  }

  private async ensureToken(scopes: string[]): Promise<UserAuth> {
    this.setUser({ authorizing: true, error: '' });
    try {
      const auth = await ensureUserToken(
        this.state.config?.appId ?? '',
        this.auth,
        (value) => this.saveAuth(value),
        scopes,
        this.fetchImpl,
      );
      this.saveAuth(auth);
      return auth;
    } finally {
      this.setUser({ authorizing: false });
    }
  }

  private saveAuth(auth: UserAuth): void {
    this.auth = auth;
    this.setUser({
      authorized: true,
      accessToken: auth.accessToken,
      scopes: auth.scopes ?? [],
      ...(auth.openId ? { openId: auth.openId } : {}),
      ...(auth.name ? { name: auth.name } : {}),
      ...(auth.avatarUrl ? { avatarUrl: auth.avatarUrl } : {}),
      error: '',
    });
  }

  private setUser(patch: Partial<CompanionUser>): void {
    this.update({ user: { ...this.state.user, ...patch } });
  }

  private setMessage(patch: Partial<CompanionMessage>): void {
    this.update({ message: { ...this.state.message, ...patch } });
  }

  private setChat(patch: Partial<CompanionChat>): void {
    this.update({ chat: { ...this.state.chat, ...patch } });
  }

  private update(patch: Partial<CompanionState>): void {
    const next = { ...this.state, ...patch };
    next.preview = !next.inFeishu && Boolean(next.config?.previewUrl || next.config?.localPreview);
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private pageUrl(): string {
    return this.url.origin + this.url.pathname + this.url.search;
  }
}

function defaultUrl(): URL {
  if (typeof window !== 'undefined') return new URL(window.location.href);
  return new URL('http://localhost/');
}

function defaultUserAgent(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
