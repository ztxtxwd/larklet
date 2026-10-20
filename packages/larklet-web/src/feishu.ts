import { createHash, randomBytes } from 'node:crypto';

import { rawToDsl } from '@open-feishu-card/adapter';

const DEFAULT_OPEN_API = 'https://open.feishu.cn';

export function resolveOpenApiBase(domain?: string): string {
  const raw = (domain ?? '').trim();
  if (!raw || raw === 'Feishu') return DEFAULT_OPEN_API;
  if (raw === 'Lark') return 'https://open.larksuite.com';
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
  return DEFAULT_OPEN_API;
}

export function interactiveCardTitle(card: unknown): string | undefined {
  if (!card || typeof card !== 'object') return undefined;
  const header = (card as { header?: unknown }).header;
  if (!header || typeof header !== 'object') return undefined;
  const title = (header as { title?: unknown }).title;
  if (typeof title === 'string') return title.trim() || undefined;
  if (title && typeof title === 'object') {
    const content = (title as { content?: unknown }).content;
    if (typeof content === 'string' && content.trim()) return content.trim();
  }
  return undefined;
}

/** 把 `card_msg_content_type=raw_card_content` 的正文转成可发送的公开卡片 JSON。 */
export function dslFromRawContent(content: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('卡片内容不是 JSON');
  }
  const dsl = rawToDsl(parsed);
  if (!isSendableDsl(dsl)) throw new Error('原始卡片无法转成可发送的卡片');
  return dsl;
}

function isSendableDsl(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if ('json_card' in value) return false;
  return 'body' in value || 'header' in value || 'elements' in value;
}

interface Cached {
  value: string;
  expiresAt: number;
}

interface FeishuPayload {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
  /** OAuth v3 token 接口把字段放在顶层。 */
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
  data?: {
    ticket?: string;
    expire_in?: number;
    message_id?: string;
    open_id?: string;
    union_id?: string;
    name?: string;
    avatar_url?: string;
    access_token?: string;
    expires_in?: number;
    items?: MessageItem[];
    image_key?: string;
    file_key?: string;
  };
}

interface MessageItem {
  message_id?: string;
  msg_type?: string;
  body?: { content?: string };
}

export interface CardMessage {
  messageId: string;
  msgType: string;
  title?: string;
  /** 由 raw_card_content 转成的公开卡片 JSON，可直接作为发送接口的 content。 */
  content: string;
}

export interface FeishuUser {
  openId: string;
  unionId?: string;
  name: string;
  avatarUrl: string;
  accessToken: string;
  expiresIn: number;
}

export interface JsapiSignature {
  appId: string;
  timestamp: number;
  nonceStr: string;
  signature: string;
}

export class FeishuApi {
  readonly openApiBase: string;
  private readonly fetchImpl: typeof fetch;
  private tenant?: Cached;
  private ticket?: Cached;

  constructor(private readonly opts: {
    appId: string;
    appSecret: string;
    openApiBase?: string;
    /** OAuth 授权码换 token 的根地址；默认按开放平台域名推成 `accounts.<域名>`。 */
    authBase?: string;
    fetchImpl?: typeof fetch;
  }) {
    this.openApiBase = resolveOpenApiBase(opts.openApiBase);
    // Workers 的 fetch 依赖正确的 this。存成 this.fetchImpl 再调用会报 Illegal invocation。
    const fetchOverride = opts.fetchImpl;
    this.fetchImpl = (input, init) => (fetchOverride ? fetchOverride(input, init) : fetch(input, init));
  }

  async tenantAccessToken(): Promise<string> {
    return this.cached(this.tenant, async () => {
      const data = await this.post('/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: this.opts.appId,
        app_secret: this.opts.appSecret,
      });
      if (!data.tenant_access_token) throw new Error(`获取 tenant_access_token 失败：${data.msg || data.code}`);
      const token = data.tenant_access_token;
      this.tenant = this.remember(token, data.expire);
      return token;
    });
  }

  async jsapiSignature(url: string): Promise<JsapiSignature> {
    const ticket = await this.jsapiTicket();
    const nonceStr = randomBytes(16).toString('hex');
    const timestamp = Date.now();
    const raw = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`;
    const signature = createHash('sha1').update(raw).digest('hex');
    return { appId: this.opts.appId, timestamp, nonceStr, signature };
  }

  /**
   * 用授权码换用户身份。走 OAuth 2.0 的 v3 token 接口（v1 / v2 都已标为历史版本），
   * 再用拿到的 user_access_token 读 `authen/v1/user_info` 补齐 open_id / union_id / 头像。
   */
  async exchangeAuthCode(code: string): Promise<FeishuUser> {
    const token = await this.postAbsolute(
      this.authBase,
      '/oauth/v3/token',
      {
        grant_type: 'authorization_code',
        client_id: this.opts.appId,
        client_secret: this.opts.appSecret,
        code,
      },
    );
    // 成功响应不带 `code`；只有错误响应才带。
    if (!token.access_token || (token.code !== undefined && token.code !== 0)) {
      throw new Error(`换取用户身份失败：${token.error_description || token.error || token.msg || token.code}`);
    }
    const accessToken = token.access_token;
    const expiresIn = token.expires_in ?? 7200;
    const profile = await this.userProfile(accessToken).catch(() => undefined);
    return {
      openId: profile?.openId ?? '',
      ...(profile?.unionId ? { unionId: profile.unionId } : {}),
      name: profile?.name ?? '',
      avatarUrl: profile?.avatarUrl ?? '',
      accessToken,
      expiresIn,
    };
  }

  async cardMessage(messageId: string): Promise<CardMessage> {
    const token = await this.tenantAccessToken();
    const data = await this.get(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}?card_msg_content_type=raw_card_content`,
      token,
    );
    if (data.code !== 0) throw new Error(`读取消息失败：${data.msg || data.code}`);
    const item = data.data?.items?.[0];
    const msgType = item?.msg_type ?? '';
    const content = item?.body?.content ?? '';
    if (msgType !== 'interactive' || !content) {
      throw new Error(msgType ? `该消息不是卡片（${msgType}）` : '没有读到卡片内容');
    }
    const dsl = dslFromRawContent(content);
    return {
      messageId: item?.message_id || messageId,
      msgType,
      title: interactiveCardTitle(dsl),
      content: JSON.stringify(dsl),
    };
  }

  async userProfile(userAccessToken: string): Promise<{ openId: string; unionId?: string; name: string; avatarUrl: string }> {
    const data = await this.get('/open-apis/authen/v1/user_info', userAccessToken);
    const openId = data.data?.open_id;
    if (data.code !== 0 || !openId) throw new Error(`读取用户身份失败：${data.msg || data.code}`);
    return {
      openId,
      ...(data.data?.union_id ? { unionId: data.data.union_id } : {}),
      name: data.data?.name ?? '',
      avatarUrl: data.data?.avatar_url ?? '',
    };
  }

  async uploadMessageImage(file: Blob, filename: string): Promise<string> {
    const form = new FormData();
    form.append('image_type', 'message');
    form.append('image', file, filename);
    const data = await this.postForm('/open-apis/im/v1/images', form, await this.tenantAccessToken());
    const key = data.data?.image_key;
    if (data.code !== 0 || !key) throw new Error(`上传图片失败：${data.msg || data.code}`);
    return key;
  }

  async uploadMessageFile(file: Blob, filename: string, fileType: string): Promise<string> {
    const form = new FormData();
    form.append('file_type', fileType);
    form.append('file_name', filename);
    form.append('file', file, filename);
    const data = await this.postForm('/open-apis/im/v1/files', form, await this.tenantAccessToken());
    const key = data.data?.file_key;
    if (data.code !== 0 || !key) throw new Error(`上传文件失败：${data.msg || data.code}`);
    return key;
  }

  async sendEphemeralCard(opts: { chatId: string; openId: string; card: object }): Promise<{ messageId: string }> {
    const token = await this.tenantAccessToken();
    const data = await this.post('/open-apis/ephemeral/v1/send', {
      chat_id: opts.chatId,
      open_id: opts.openId,
      msg_type: 'interactive',
      card: opts.card,
    }, token);
    const messageId = data.data?.message_id;
    if (data.code !== 0 || !messageId) throw new Error(`发送仅发布者可见的卡片失败：${data.msg || data.code}`);
    return { messageId };
  }

  async sendCard(opts: {
    chatId: string;
    content: string;
    accessToken?: string;
  }): Promise<{ messageId: string }> {
    const token = opts.accessToken || (await this.tenantAccessToken());
    const data = await this.post(
      '/open-apis/im/v1/messages?receive_id_type=chat_id',
      {
        receive_id: opts.chatId,
        msg_type: 'interactive',
        content: opts.content,
      },
      token,
    );
    const messageId = data.data?.message_id;
    if (data.code !== 0 || !messageId) throw new Error(`发送卡片失败：${data.msg || data.code}`);
    return { messageId };
  }

  private async jsapiTicket(): Promise<string> {
    return this.cached(this.ticket, async () => {
      const token = await this.tenantAccessToken();
      const data = await this.post('/open-apis/jssdk/ticket/get', {}, token);
      const ticket = data.data?.ticket;
      if (data.code !== 0 || !ticket) throw new Error(`获取 jsapi_ticket 失败：${data.msg || data.code}`);
      this.ticket = this.remember(ticket, data.data?.expire_in);
      return ticket;
    });
  }

  private async cached(slot: Cached | undefined, load: () => Promise<string>): Promise<string> {
    if (slot && slot.expiresAt > Date.now()) return slot.value;
    return load();
  }

  private remember(value: string, expireSeconds?: number): Cached {
    const ttl = Math.max((expireSeconds ?? 7200) - 60, 30);
    return { value, expiresAt: Date.now() + ttl * 1000 };
  }

  /**
   * OAuth token 接口在 `accounts.<domain>` 上，不在 open-apis 下面。
   * `open.feishu.cn` → `https://accounts.feishu.cn`；自定义根地址沿用其主机名。
   */
  private get authBase(): string {
    const override = this.opts.authBase?.trim();
    if (override) return override.replace(/\/+$/, '');
    try {
      const url = new URL(this.openApiBase);
      const zone = url.hostname.split('.').slice(-2).join('.');
      return `https://accounts.${zone}`;
    } catch {
      return 'https://accounts.feishu.cn';
    }
  }

  private async postAbsolute(base: string, pathname: string, body: object): Promise<FeishuPayload> {
    const response = await this.fetchImpl(`${base}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    return readJson(response);
  }

  private async get(pathname: string, accessToken: string): Promise<FeishuPayload> {
    const response = await this.fetchImpl(`${this.openApiBase}${pathname}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return readJson(response);
  }

  private async postForm(pathname: string, body: FormData, accessToken: string): Promise<FeishuPayload> {
    const response = await this.fetchImpl(`${this.openApiBase}${pathname}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
      body,
    });
    return readJson(response);
  }

  private async post(pathname: string, body: object, accessToken?: string): Promise<FeishuPayload> {
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    const response = await this.fetchImpl(`${this.openApiBase}${pathname}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return readJson(response);
  }
}

async function readJson(response: Response): Promise<FeishuPayload> {
  const text = await response.text();
  if (!text) return { code: response.ok ? 0 : response.status, msg: response.statusText };
  try {
    return JSON.parse(text) as FeishuPayload;
  } catch {
    throw new Error(`飞书接口返回的不是 JSON：${response.status}`);
  }
}
