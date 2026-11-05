import { Hono, type Context } from 'hono';

import { FeishuApi } from './feishu.js';

export { FeishuApi };

export interface CompanionOptions {
  appId?: string;
  appSecret?: string;
  /** `Feishu` / `Lark`，或完整的开放平台根地址。 */
  openApiBase?: string;
  /** OAuth 授权码换 token 的根地址。默认按开放平台域名推成 `accounts.<域名>`。 */
  authBase?: string;
  /** 开发时允许用 `?message_id=` 打开，不必从消息快捷应用进入。 */
  allowDirectMessageId?: boolean;
  /**
   * Larklet 进程根地址。加号菜单发卡时按应用路径向该地址渲染一张新卡片。
   */
  cardRenderUrl?: string;
  /** 返回给网页的标题，默认「飞书应用」。框架不渲染。 */
  title?: string;
  /**
   * 读消息时申请的权限（用户身份）。默认只要 `im:message`。
   *
   * 机器人在消息所在的会话里时，网页会先用机器人身份读，不需要用户授权；
   * 只有机器人读不到（机器人不在群里），才用用户身份读，这时才要这份权限。
   * 要在群里以用户身份读，还要开 `im:message.group_msg:get_as_user`
   * （单聊是 `im:message.p2p_msg:get_as_user`），并写进这里。
   */
  scopes?: string[];
  /**
   * 以用户身份发消息时申请的权限。默认 `im:message` 与 `im:message.send_as_user`。
   */
  sendScopes?: string[];
  /**
   * 开发时 Larklet 预览根地址。框架把它放进 config，`sendApp` 会投到模拟群。
   * 生产环境不要设置。
   */
  previewUrl?: string;
  /**
   * 开发时在浏览器里直接打开网页。
   * 生产环境不要设置。
   */
  localPreview?: boolean;
  fetchImpl?: typeof fetch;
  /**
   * 由网页自己渲染卡片。设置后，加号菜单发卡不再请求渲染服务。
   * 未知路径应拒绝，错误信息为「没有这个应用」。
   */
  renderCard?: (href: string) => Promise<string>;
}

/**
 * 配套网页的服务端接口。
 *
 * 浏览器端由 `CompanionSession` / `useCompanion` 调用这里：
 *
 * - `GET /api/config` 页面配置
 * - `POST /api/jsapi-signature` JSAPI 签名
 * - `POST /api/auth/callback` 用 `requestAccess` 的 code 换用户身份
 * - `POST /api/message` 读来源消息的类型。先用机器人身份读，机器人读不到才用用户身份
 * - `GET /api/apps` 读取 Larklet 的 `/_larklet/apps`
 * - `POST /api/apps/send` 按应用路径渲染一张新卡片，发到会话
 * - `POST /api/preview/deliver` 开发时把卡片投到模拟群
 *
 * 消息 ID 与当前会话由客户端通过飞书 JSAPI 取得，不经过服务端。
 */
export function createCompanionApp(options: CompanionOptions = {}): Hono {
  const app = new Hono();
  const title = options.title?.trim() || '飞书应用';
  const scopes = options.scopes ?? ['im:message'];
  const sendScopes = options.sendScopes ?? ['im:message', 'im:message.send_as_user'];
  const allowDirectMessageId = options.allowDirectMessageId === true;
  const cardRenderUrl = (options.cardRenderUrl ?? process.env.LARKLET_CARD_RENDER_URL ?? '').replace(/\/+$/, '');
  const previewUrl = (options.previewUrl ?? '').replace(/\/+$/, '');
  const localPreview = options.localPreview === true;
  const larkletBase = cardRenderUrl || previewUrl;
  const fetchOverride = options.fetchImpl;
  const fetchImpl: typeof fetch = (input, init) =>
    fetchOverride ? fetchOverride(input, init) : fetch(input, init);
  const renderCard = options.renderCard;
  let client: FeishuApi | undefined;

  function api(): FeishuApi {
    if (client) return client;
    const appId = (options.appId ?? process.env.LARKLET_APP_ID ?? process.env.APP_ID ?? '').trim();
    const appSecret = (options.appSecret ?? process.env.LARKLET_APP_SECRET ?? process.env.APP_SECRET ?? '').trim();
    if (!appId || !appSecret) throw new Error('需要配置 APP_ID 与 APP_SECRET');
    client = new FeishuApi({
      appId,
      appSecret,
      openApiBase: options.openApiBase ?? process.env.LARK_DOMAIN,
      authBase: options.authBase,
      fetchImpl: options.fetchImpl,
    });
    return client;
  }

  app.get('/api/config', (c) => {
    const appId = (options.appId ?? process.env.LARKLET_APP_ID ?? process.env.APP_ID ?? '').trim();
    return c.json({
      ok: true,
      appId,
      allowDirectMessageId,
      title,
      scopes,
      sendScopes,
      ...(previewUrl ? { previewUrl } : {}),
      ...(localPreview ? { localPreview: true } : {}),
    });
  });

  app.post('/api/jsapi-signature', async (c) => {
    const body = await readBody(c.req.raw);
    const url = stringField(body, 'url');
    if (!url) return fail(c, '缺少 url');
    if (!/^https?:\/\//i.test(url) || url.includes('#')) return fail(c, 'url 需要是不带 hash 的 http(s) 地址');
    try {
      const signature = await api().jsapiSignature(url);
      return c.json({ ok: true, ...signature });
    } catch (error) {
      return fail(c, messageOf(error), 502);
    }
  });

  app.post('/api/auth/callback', async (c) => {
    const body = await readBody(c.req.raw);
    const code = stringField(body, 'code');
    if (!code) return fail(c, '缺少 code');
    try {
      const user = await api().exchangeAuthCode(code);
      return c.json({
        ok: true,
        openId: user.openId,
        ...(user.unionId ? { unionId: user.unionId } : {}),
        name: user.name,
        avatarUrl: user.avatarUrl,
        accessToken: user.accessToken,
        expiresIn: user.expiresIn,
      });
    } catch (error) {
      return fail(c, messageOf(error), 502);
    }
  });

  app.post('/api/message', async (c) => {
    const body = await readBody(c.req.raw);
    const messageId = stringField(body, 'messageId');
    const userAccessToken = stringField(body, 'userAccessToken');
    if (!messageId) return fail(c, '缺少 messageId');
    try {
      // 没给用户身份就用机器人身份读：机器人在这条消息的会话里时，
      // 不用麻烦用户授权就能读到消息类型。
      const token = userAccessToken || (await api().tenantAccessToken());
      const message = await api().messageInfo(messageId, token);
      return c.json({
        ok: true,
        messageId: message.messageId,
        msgType: message.msgType,
      });
    } catch (error) {
      const text = messageOf(error);
      // 机器人读不到（多半是机器人不在这个会话里），让网页去要用户授权。
      if (!userAccessToken) return c.json({ ok: false, needUserAuth: true, error: text });
      return fail(c, text, 502);
    }
  });

  app.get('/api/apps', async (c) => {
    if (!cardRenderUrl) return c.json({ ok: true, apps: [] });
    try {
      const response = await fetchImpl(`${cardRenderUrl}/_larklet/apps`);
      const payload = (await response.json().catch(() => ({}))) as { apps?: unknown; msg?: string };
      if (!response.ok) return fail(c, payload.msg || `读取应用列表失败：${response.status}`, 502);
      return c.json({ ok: true, apps: normalizeApps(payload.apps) });
    } catch (error) {
      return fail(c, messageOf(error), 502);
    }
  });

  app.post('/api/apps/send', async (c) => {
    const body = await readBody(c.req.raw);
    const href = stringField(body, 'href');
    const chatId = stringField(body, 'chatId');
    const as = stringField(body, 'as') || 'bot';
    const userAccessToken = stringField(body, 'userAccessToken');
    if (!href.startsWith('/') || href.startsWith('//')) return fail(c, '应用路径不正确');
    if (!chatId) return fail(c, '缺少当前会话');
    if (as !== 'bot' && as !== 'user') return fail(c, 'as 需要是 bot 或 user');
    if (as === 'user' && !userAccessToken) return fail(c, '缺少用户授权，请先授权后重试');
    if (!renderCard && !cardRenderUrl) return fail(c, '未配置卡片渲染地址');
    try {
      if (!renderCard) {
        const listed = await fetchImpl(`${cardRenderUrl}/_larklet/apps`);
        const catalog = (await listed.json().catch(() => ({}))) as { apps?: unknown };
        const apps = normalizeApps(catalog.apps);
        if (!apps.some((item) => item.href === href)) return fail(c, '没有这个应用');
      }
      const rendered = await renderFreshCard(href, cardRenderUrl, fetchImpl, renderCard);
      const sent = await api().sendCard({
        chatId,
        content: rendered,
        accessToken: as === 'user' ? userAccessToken : undefined,
      });
      return c.json({ ok: true, messageId: sent.messageId });
    } catch (error) {
      const message = messageOf(error);
      return fail(c, message, message === '没有这个应用' ? 400 : 502);
    }
  });

  app.post('/api/preview/deliver', async (c) => {
    if (!larkletBase) return fail(c, '未配置预览地址');
    const body = await readBody(c.req.raw);
    const href = stringField(body, 'href');
    const kind = stringField(body, 'kind') || 'chat';
    const openId = stringField(body, 'openId');
    if (!href.startsWith('/') || href.startsWith('//')) return fail(c, '应用路径不正确');
    if (kind !== 'chat' && kind !== 'ephemeral') return fail(c, 'kind 需要是 chat 或 ephemeral');
    if (kind === 'ephemeral' && !openId) return fail(c, '缺少收件人');
    try {
      const listed = await fetchImpl(`${larkletBase}/_larklet/apps`);
      const catalog = (await listed.json().catch(() => ({}))) as { apps?: unknown };
      const apps = normalizeApps(catalog.apps);
      if (!apps.some((item) => item.href === href)) return fail(c, '没有这个应用');
      const response = await fetchImpl(`${larkletBase}/_larklet/preview/deliver`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room: 'dev', kind, href, ...(openId ? { openId } : {}) }),
      });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; msg?: string; messageId?: string };
      if (!response.ok || !payload.messageId) return fail(c, payload.msg || '发到模拟群失败', 502);
      return c.json({ ok: true, messageId: payload.messageId });
    } catch (error) {
      return fail(c, messageOf(error), 502);
    }
  });

  return app;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value.trim() : '';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ListedApp {
  href: string;
  title: string;
  description: string;
  intro?: string;
}

function normalizeApps(value: unknown): ListedApp[] {
  if (!Array.isArray(value)) return [];
  const apps: ListedApp[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { href?: unknown; title?: unknown; description?: unknown; intro?: unknown };
    if (typeof record.href !== 'string' || !record.href.startsWith('/') || record.href.startsWith('//')) continue;
    if (typeof record.title !== 'string' || !record.title.trim()) continue;
    const intro = typeof record.intro === 'string' ? record.intro.trim() : '';
    apps.push({
      href: record.href,
      title: record.title.trim(),
      description: typeof record.description === 'string' ? record.description.trim() : '',
      ...(intro ? { intro } : {}),
    });
  }
  return apps;
}

async function renderFreshCard(
  href: string,
  cardRenderUrl: string,
  fetchImpl: typeof fetch,
  renderCard?: (href: string) => Promise<string>,
): Promise<string> {
  if (renderCard) return renderCard(href);
  const response = await fetchImpl(`${cardRenderUrl}/_larklet/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ href }),
  });
  const payload = (await response.json().catch(() => ({}))) as { card?: unknown; msg?: string };
  if (!response.ok || !payload.card || typeof payload.card !== 'object') {
    throw new Error(`重新开一张应用卡片失败：${payload.msg || response.status}`);
  }
  return JSON.stringify(payload.card);
}

function fail(c: Context, error: string, status: 400 | 502 = 400) {
  return c.json({ ok: false, error }, status);
}
