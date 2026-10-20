import { readCardState } from '@open-feishu-card/store';
import { Hono, type Context } from 'hono';

import { FeishuApi } from './feishu.js';

export { FeishuApi };

export interface CompanionOptions {
  appId?: string;
  appSecret?: string;
  /** `Feishu` / `Lark`，或完整的开放平台根地址。 */
  openApiBase?: string;
  /** 开发时允许用 `?message_id=` 打开，不必从消息快捷应用进入。 */
  allowDirectMessageId?: boolean;
  /**
   * Larklet 进程根地址。飞书回读会丢掉按钮回调。
   * 发送时只取来源卡片的应用路径，向该地址渲染一张没有对局状态的新卡片。
   */
  cardRenderUrl?: string;
  /** 页面标题，默认「发送卡片」。 */
  title?: string;
  /**
   * 开发时 Larklet 预览根地址。浏览器不在飞书里时，配套页用它嵌模拟群。
   * 生产环境不要设置。
   */
  previewUrl?: string;
  /**
   * 开发时在浏览器里打开应用页，不嵌机器人预览。
   * 生产环境不要设置。
   */
  localPreview?: boolean;
  fetchImpl?: typeof fetch;
  /**
   * 由网页自己渲染卡片。设置后，加号菜单发卡和回读后重开卡片都不再请求渲染服务。
   * 未知路径应拒绝，错误信息为「没有这个应用」。
   */
  renderCard?: (href: string) => Promise<string>;
}

/**
 * 配套网页的接口。
 *
 * 飞书消息快捷应用打开本页时带上 `bdp_launch_query`。页面用 JSAPI
 * `getBlockActionSourceDetail` 换成 `open_message_id`，再调用这里：
 *
 * - `GET /api/config`
 * - `POST /api/jsapi-signature`
 * - `POST /api/auth/callback` 用 `requestAccess` 的 code 换用户身份
 * - `POST /api/card` 读取来源卡片
 * - `POST /api/card/send` 发到 `chooseChat` 选中的会话，`as` 为 `bot` 或 `user`
 *
 * 从聊天框加号菜单打开时没有来源消息。页面改走：
 *
 * - `GET /api/apps` 读取 Larklet 的 `/_larklet/apps`
 * - `POST /api/apps/send` 按应用路径渲染一张新卡片，发到当前会话
 */
export function createCompanionApp(options: CompanionOptions = {}): Hono {
  const app = new Hono();
  const title = options.title?.trim() || '发送卡片';
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
        name: user.name,
        avatarUrl: user.avatarUrl,
        accessToken: user.accessToken,
        expiresIn: user.expiresIn,
      });
    } catch (error) {
      return fail(c, messageOf(error), 502);
    }
  });

  app.post('/api/card', async (c) => {
    const body = await readBody(c.req.raw);
    const messageId = stringField(body, 'messageId');
    if (!messageId) return fail(c, '缺少 messageId');
    try {
      const card = await api().cardMessage(messageId);
      return c.json({
        ok: true,
        messageId: card.messageId,
        msgType: card.msgType,
        title: card.title ?? '',
      });
    } catch (error) {
      return fail(c, messageOf(error), 502);
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
    if (!href.startsWith('/') || href.startsWith('//')) return fail(c, '应用路径不正确');
    if (!chatId) return fail(c, '缺少当前会话');
    if (!renderCard && !cardRenderUrl) return fail(c, '未配置卡片渲染地址');
    try {
      if (!renderCard) {
        const listed = await fetchImpl(`${cardRenderUrl}/_larklet/apps`);
        const catalog = (await listed.json().catch(() => ({}))) as { apps?: unknown };
        const apps = normalizeApps(catalog.apps);
        if (!apps.some((item) => item.href === href)) return fail(c, '没有这个应用');
      }
      const rendered = await renderFreshCard(href, cardRenderUrl, fetchImpl, renderCard);
      const sent = await api().sendCard({ chatId, content: rendered });
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

  app.post('/api/card/send', async (c) => {
    const body = await readBody(c.req.raw);
    const messageId = stringField(body, 'messageId');
    const chatId = stringField(body, 'chatId');
    const as = stringField(body, 'as');
    const userAccessToken = stringField(body, 'userAccessToken');
    if (!messageId) return fail(c, '缺少 messageId');
    if (!chatId) return fail(c, '缺少 chatId');
    if (as !== 'bot' && as !== 'user') return fail(c, 'as 需要是 bot 或 user');
    if (as === 'user' && !userAccessToken) return fail(c, '缺少用户授权，请先授权后重试');
    try {
      const feishu = api();
      const card = await feishu.cardMessage(messageId);
      const content = await reviveLarkletCard(card.content, cardRenderUrl, fetchImpl, renderCard);
      const sent = await feishu.sendCard({
        chatId,
        content,
        accessToken: as === 'user' ? userAccessToken : undefined,
      });
      return c.json({ ok: true, messageId: sent.messageId });
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

async function reviveLarkletCard(
  content: string,
  cardRenderUrl: string,
  fetchImpl: typeof fetch,
  renderCard?: (href: string) => Promise<string>,
): Promise<string> {
  if (!cardRenderUrl && !renderCard) return content;
  const card = JSON.parse(content) as unknown;
  const envelope = larkletEnvelope(card);
  if (!envelope) return content;
  return renderFreshCard(envelope.pathname, cardRenderUrl, fetchImpl, renderCard);
}

function larkletEnvelope(card: unknown): { pathname: string } | null {
  if (!card || typeof card !== 'object') return null;
  const sealed = readCardState(card as Record<string, unknown>);
  if (!sealed || typeof sealed !== 'object') return null;
  const record = sealed as Record<string, unknown>;
  if (record.v !== 1 || typeof record.pathname !== 'string' || typeof record.pattern !== 'string') return null;
  return { pathname: record.pathname };
}

function fail(c: Context, error: string, status: 400 | 502 = 400) {
  return c.json({ ok: false, error }, status);
}
