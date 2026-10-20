import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { FeishuCardJson } from '@open-feishu-card/components';

import { createLarklet, LarkletError, toCallbackResponse, type LarkletApp, type LarkletHandled, type RenderInit } from './app.js';
import { loadLarkletConfig, resolveConnection, type LarkletConnection } from './config.js';
import { deliverMenuCard, tenantAccessToken } from './feishu.js';
import {
  cachedPreviewImage,
  prefetchPreviewImages,
  putPreviewImage,
  rememberPreviewPerson,
  previewPersonsTable,
  setResolvePreviewImage,
  type ResolvePreviewImage,
} from './preview-context.js';
import {
  addPreviewBuyer,
  deliverPreviewMessage,
  patchPreviewRoom,
  previewRoom,
  previewRoomUser,
  subscribePreviewRoom,
} from './preview-room.js';
import { previewHtml } from './preview.js';
import type { Operator } from './request.js';
import { cardHref } from './state.js';
import { startFeishuSocket, type FeishuSocket } from './socket.js';

export interface ListenOptions {
  port?: number;
  host?: string;
  dev?: boolean;
  dir?: string;
  verificationToken?: string;
  encryptKey?: string;
  appId?: string;
  appSecret?: string;
  /**
   * 开放平台根地址，长连接和 OpenAPI 共用。
   * `Feishu`、`Lark`，或完整根地址。未传时读 `LARK_DOMAIN`。
   */
  domain?: string;
  /** 覆盖 `larklet.config.js` 的 `connection`。 */
  connection?: LarkletConnection;
  /**
   * 本地预览：把卡片里的 img_key 解析成可展示的 src（data URI / URL）。
   * 优先于用 app 凭证去飞书拉图；无 token、无 message 时靠这个看棋盘/卡图。
   */
  resolvePreviewImage?: ResolvePreviewImage;
  /**
   * HTTP 已监听、长连接客户端已构造后调用。参数是装配好的 `app`，可在
   * 业务自己维护的 OAuth 回调、定时任务等入口里直接 `handle()` / `render()`。
   * 返回的清理函数会在 `close()` 时先于服务器关闭执行。
   */
  onReady?: (app: LarkletApp) => Promise<(() => void) | void> | (() => void) | void;
}

export async function listen(options: ListenOptions = {}): Promise<{
  url: string;
  app: LarkletApp;
  connection: LarkletConnection;
  close: () => Promise<void>;
}> {
  const dev = options.dev ?? false;
  const dir = options.dir ?? process.cwd();
  const connection = resolveConnection(options.connection, await loadLarkletConfig(dir));
  const app = await createLarklet({
    dir,
    dev,
    verificationToken: options.verificationToken,
    encryptKey: options.encryptKey,
    appId: options.appId,
    appSecret: options.appSecret,
  });
  setResolvePreviewImage(options.resolvePreviewImage);
  const port = options.port ?? 8787;
  const host = options.host ?? '0.0.0.0';

  const server = createHttpServer(async (req, res) => {
    try {
      await routeRequest(app, dev, dir, req, res);
    } catch (error) {
      const status = error instanceof LarkletError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, status, { msg: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  let socket: FeishuSocket | undefined;
  let cleanup: (() => void) | undefined;
  const shutdown = async (): Promise<void> => {
    try {
      cleanup?.();
    } catch (error) {
      console.warn('[larklet] onReady 清理失败：', error);
    }
    socket?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  try {
    socket = openSocket(connection, app, options);
    const ready = await options.onReady?.(app);
    if (typeof ready === 'function') cleanup = ready;
  } catch (error) {
    await shutdown();
    throw error;
  }

  const bound = server.address();
  const actualPort = typeof bound === 'object' && bound ? bound.port : port;
  const url = `http://127.0.0.1:${actualPort}`;
  let closing: Promise<void> | undefined;
  return {
    url,
    app,
    connection,
    // 重复调用返回同一个 Promise；第一次关闭后不会再向已关闭的 server 发请求。
    close: () => {
      closing ??= shutdown();
      return closing;
    },
  };
}

function openSocket(connection: LarkletConnection, app: LarkletApp, options: ListenOptions): FeishuSocket | undefined {
  if (connection !== 'websocket' || !app.appId || !app.appSecret) return undefined;
  return startFeishuSocket({
    appId: app.appId,
    appSecret: app.appSecret,
    domain: options.domain,
    app,
    verificationToken: options.verificationToken,
    encryptKey: options.encryptKey,
  });
}

async function routeRequest(app: LarkletApp, dev: boolean, dir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://larklet.local');

  if (dev && url.pathname === '/_larklet/preview/stream' && req.method === 'GET') {
    streamPreviewRoom(url.searchParams.get('room') || 'dev', req, res);
    return;
  }

  if (dev && url.pathname === '/_larklet/preview/room' && req.method === 'GET') {
    const room = previewRoom(url.searchParams.get('id') || 'dev');
    sendJson(res, 200, {
      ok: true,
      id: room.id,
      seq: room.seq,
      chatId: room.chatId,
      users: room.users,
    });
    return;
  }

  if (dev && url.pathname === '/_larklet/preview/room' && req.method === 'POST') {
    const body = await readBody(req);
    const record = isRecord(body) ? body : {};
    const id = typeof record.id === 'string' ? record.id : 'dev';
    if (record.action !== 'add-user') {
      sendJson(res, 400, { msg: 'action 需要是 add-user' });
      return;
    }
    sendJson(res, 200, { ok: true, ...addPreviewBuyer(id) });
    return;
  }

  if (dev && url.pathname === '/_larklet/preview/deliver' && req.method === 'POST') {
    await deliverToPreview(app, req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/_larklet/apps') {
    sendJson(res, 200, { apps: await readAppCatalog(dir) });
    return;
  }

  if (dev && req.method === 'GET' && url.pathname === '/') {
    sendHtml(res, 200, previewHtml(await previewToastShells()));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/_larklet/renderer.css') {
    sendText(res, 200, readRendererCss(), 'text/css; charset=utf-8');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/_larklet/render') {
    const body = await readBody(req);
    const record = isRecord(body) ? body : {};
    const href = typeof record.href === 'string' && record.href.trim() ? record.href.trim() : '/';
    const operator = readOperator(record.operator);
    const message = readMessage(record.message);
    const rendered = await app.render(href, {
      userState: record.userState,
      searchParams: isRecord(record.searchParams) ? (record.searchParams as RenderInit['searchParams']) : undefined,
      ...(operator ? { operator } : {}),
      ...(message ? { message } : {}),
    });
    if (record.html !== true) {
      sendJson(res, 200, { card: rendered.card });
      return;
    }
    const html = await cardHtml(app, rendered.card, previewMedia(record.media));
    sendJson(res, 200, { card: rendered.card, html });
    return;
  }

  if (dev && req.method === 'GET' && url.pathname === '/_larklet/preview/scene') {
    const href = url.searchParams.get('path') || '/';
    const scene = await app.previewScene(href);
    sendJson(res, 200, { scene: scene ? { users: scene.users, aside: Boolean(scene.aside) } : null });
    return;
  }

  if (dev && req.method === 'GET' && url.pathname === '/_larklet/render') {
    const href = url.searchParams.get('path') || '/';
    const init = renderInitFromSearch(url.searchParams);
    const scene = await app.previewScene(href);
    if (scene?.userState !== undefined) init.userState = scene.userState;
    rememberPreviewPerson(init.operator);
    const rendered = await app.render(href, init);
    const html = await cardHtml(app, rendered.card);
    const aside = scene?.aside ? await renderPreviewAside(app, scene.aside) : undefined;
    sendJson(res, 200, {
      path: cardHref(rendered.card) ?? href,
      card: rendered.card,
      html,
      actions: rendered.controls,
      ...(scene
        ? {
            scene: {
              users: scene.users,
              ...(aside ? { aside } : {}),
            },
          }
        : {}),
    });
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/webhook' || (dev && url.pathname === '/_larklet/event'))) {
    const body = await readBody(req);
    if (url.pathname === '/_larklet/event') {
      rememberPreviewPerson(operatorFromBody(body));
    }
    const preview = url.pathname === '/_larklet/event';
    const handled = await app.handle(body, {
      captureEphemeral: preview,
      // 预览页自己构造事件，不经过飞书签名；只有 dev 下这个入口才开放。
      trustedTransport: preview,
      // 自己拼的卡片回调没有 event_id，不算飞书事件，不交给 onEvent / app/events.*。
      synthetic: preview,
      transport: preview ? 'http' : 'webhook',
    });
    if (handled.type === 'challenge') {
      sendJson(res, 200, { challenge: handled.challenge });
      return;
    }
    if (handled.type === 'empty') {
      sendJson(res, 200, {});
      return;
    }
    if (handled.type === 'raw') {
      sendJson(res, 200, handled.response ?? {});
      return;
    }
    if (handled.type === 'menu') {
      if (url.pathname !== '/_larklet/event') await deliverMenu(app, handled);
      const payload = toCallbackResponse(handled);
      if (url.pathname === '/_larklet/event') {
        const html = await cardHtml(app, handled.card);
        sendJson(res, 200, {
          ...payload,
          html,
          actions: handled.controls,
        });
        return;
      }
      sendJson(res, 200, {});
      return;
    }
    const payload = toCallbackResponse(handled);
    if (url.pathname === '/_larklet/event') {
      const html = await cardHtml(app, handled.card);
      const ephemeral = await Promise.all(
        handled.ephemeral.map(async (item) => ({
          messageId: item.messageId,
          openId: item.openId,
          chatId: item.chatId,
          path: item.path,
          card: item.card,
          html: await cardHtml(app, item.card),
        })),
      );
      const messages = await Promise.all(
        handled.messages.map(async (item) => ({
          kind: item.kind,
          messageId: item.messageId,
          chatId: item.chatId,
          path: item.path,
          card: item.card,
          html: await cardHtml(app, item.card),
          ...(item.openIds?.length ? { openIds: item.openIds } : {}),
          ...(item.previewText ? { previewText: item.previewText } : {}),
        })),
      );
      const context = messageIdsFromBody(body);
      if (context.chatId) {
        patchPreviewRoom(context.chatId, {
          messageId: context.messageId,
          path: cardHref(handled.card),
          html,
          card: handled.card,
          ephemeral: ephemeral.map((item) => ({
            messageId: item.messageId,
            kind: 'ephemeral' as const,
            path: item.path,
            html: item.html,
            card: item.card,
            openId: item.openId,
          })),
          deletedEphemeral: handled.deletedEphemeral,
        });
      }
      sendJson(res, 200, {
        ...payload,
        card: payload.card ?? { type: 'raw', data: handled.card },
        html,
        actions: handled.controls,
        path: cardHref(handled.card),
        ephemeral,
        deletedEphemeral: handled.deletedEphemeral,
        messages,
      });
      return;
    }
    sendJson(res, 200, payload);
    return;
  }

  sendJson(res, 404, { msg: 'not found' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renderInitFromSearch(params: URLSearchParams): RenderInit {
  const openId = params.get('open_id') || undefined;
  const operator: Operator | undefined = openId
    ? {
        openId,
        userId: params.get('user_id') || undefined,
        unionId: params.get('union_id') || undefined,
        name: params.get('name') || undefined,
        avatar: params.get('avatar') || undefined,
      }
    : undefined;
  const openMessageId = params.get('open_message_id') || undefined;
  const openChatId = params.get('open_chat_id') || undefined;
  return {
    operator,
    message: { openMessageId, openChatId },
  };
}

const OPERATOR_FIELDS = ['openId', 'userId', 'unionId', 'tenantKey', 'name', 'avatar'] as const;

/** 渲染请求里可选的 `operator`。只收字符串字段，其余忽略。 */
function readOperator(value: unknown): Operator | undefined {
  if (!isRecord(value)) return undefined;
  const operator: Operator = {};
  for (const field of OPERATOR_FIELDS) {
    const raw = value[field];
    if (typeof raw === 'string' && raw.trim()) operator[field] = raw.trim();
  }
  return Object.keys(operator).length > 0 ? operator : undefined;
}

/** 渲染请求里可选的 `message`，只认这两个 message id。 */
function readMessage(value: unknown): RenderInit['message'] | undefined {
  if (!isRecord(value)) return undefined;
  const openMessageId = typeof value.openMessageId === 'string' ? value.openMessageId.trim() : '';
  const openChatId = typeof value.openChatId === 'string' ? value.openChatId.trim() : '';
  if (!openMessageId && !openChatId) return undefined;
  return {
    ...(openMessageId ? { openMessageId } : {}),
    ...(openChatId ? { openChatId } : {}),
  };
}

async function deliverMenu(app: LarkletApp, handled: Extract<LarkletHandled, { type: 'menu' }>): Promise<void> {
  if (!app.appId || !app.appSecret) return;
  await deliverMenuCard(app.appId, app.appSecret, handled);
}

async function renderPreviewAside(
  app: LarkletApp,
  aside: { href: string; role?: 'seller' | 'buyer'; userState?: unknown },
): Promise<{ path: string; role?: 'seller' | 'buyer'; html: string; card: FeishuCardJson }> {
  const rendered = await app.render(aside.href, { userState: aside.userState });
  return {
    path: cardHref(rendered.card) ?? aside.href,
    ...(aside.role ? { role: aside.role } : {}),
    html: await cardHtml(app, rendered.card),
    card: rendered.card,
  };
}

function streamPreviewRoom(id: string, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const unsubscribe = subscribePreviewRoom(id, (snapshot) => {
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  });
  req.on('close', unsubscribe);
}

async function deliverToPreview(app: LarkletApp, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const record = isRecord(body) ? body : {};
  const roomId = typeof record.room === 'string' ? record.room : 'dev';
  const href = typeof record.href === 'string' ? record.href.trim() : '';
  const kind = record.kind === 'ephemeral' ? 'ephemeral' : record.kind === 'chat' ? 'chat' : '';
  const openId = typeof record.openId === 'string' ? record.openId.trim() : '';
  if (!href.startsWith('/') || href.startsWith('//')) {
    sendJson(res, 400, { msg: 'href 需要是站内路径' });
    return;
  }
  if (!kind) {
    sendJson(res, 400, { msg: 'kind 需要是 chat 或 ephemeral' });
    return;
  }
  if (kind === 'ephemeral' && !openId) {
    sendJson(res, 400, { msg: '仅特定人可见的卡片需要 openId' });
    return;
  }

  const room = previewRoom(roomId);
  const recipient = kind === 'ephemeral' ? previewRoomUser(room.id, openId) : previewRoomUser(room.id, room.users.find((user) => user.role === 'seller')?.openId ?? '');
  if (kind === 'ephemeral' && !recipient) {
    sendJson(res, 400, { msg: '这个模拟群里没有该收件人' });
    return;
  }
  if (recipient) rememberPreviewPerson(recipient);

  const media = previewMedia(record.media);
  for (const [key, src] of Object.entries(media)) putPreviewImage(key, src);

  const rendered = await app.render(href, {
    userState: record.userState,
    operator: recipient,
    message: { openChatId: room.chatId },
  });
  const html = await cardHtml(app, rendered.card, media);
  const messageId = `om_${randomBytes(8).toString('hex')}`;
  deliverPreviewMessage(room.id, {
    messageId,
    kind,
    path: cardHref(rendered.card) ?? href,
    html,
    card: rendered.card,
    openId: kind === 'ephemeral' ? openId : undefined,
  });
  sendJson(res, 200, {
    ok: true,
    messageId,
    chatId: room.chatId,
    path: cardHref(rendered.card) ?? href,
    actions: rendered.controls,
  });
}

function messageIdsFromBody(body: unknown): { chatId?: string; messageId?: string } {
  if (!isRecord(body)) return {};
  const event = isRecord(body.event) ? body.event : body;
  const context = isRecord(event.context) ? event.context : {};
  const chatId = typeof context.open_chat_id === 'string' ? context.open_chat_id : undefined;
  const messageId = typeof context.open_message_id === 'string' ? context.open_message_id : undefined;
  return { chatId, messageId };
}

function operatorFromBody(body: unknown): Operator | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const root = body as Record<string, unknown>;
  const event = (root.event && typeof root.event === 'object' ? root.event : root) as Record<string, unknown>;
  const operatorRecord =
    event.operator && typeof event.operator === 'object'
      ? (event.operator as Record<string, unknown>)
      : event;
  const openId = typeof operatorRecord.open_id === 'string' ? operatorRecord.open_id : undefined;
  if (!openId) return undefined;
  return {
    openId,
    userId: typeof operatorRecord.user_id === 'string' ? operatorRecord.user_id : undefined,
    unionId: typeof operatorRecord.union_id === 'string' ? operatorRecord.union_id : undefined,
    name:
      (typeof operatorRecord.name === 'string' ? operatorRecord.name : undefined) ||
      (typeof operatorRecord.operator_name === 'string' ? operatorRecord.operator_name : undefined),
    avatar: typeof operatorRecord.avatar === 'string' ? operatorRecord.avatar : undefined,
  };
}

function previewMedia(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const media: Record<string, string> = {};
  for (const [key, src] of Object.entries(value)) {
    if (!/^preview-[\w-]{1,40}$/.test(key)) continue;
    if (typeof src !== 'string' || src.length > 12_000_000) continue;
    if (!src.startsWith('data:') && !/^https?:\/\//i.test(src)) continue;
    media[key] = src;
    if (Object.keys(media).length >= 10) break;
  }
  return media;
}

function mediaKey(property: Record<string, unknown>): string {
  const key = property.img_key ?? property.imageID ?? property.image_key ?? property.file_key ?? property.fileID;
  return typeof key === 'string' ? key : '';
}

async function cardHtml(app: LarkletApp, card: FeishuCardJson, media: Record<string, string> = {}): Promise<string> {
  try {
    const entry = rendererEntry();
    const renderer = await import(entry);
    const render = (
      renderer as {
        renderDslToString?: (
          dsl: unknown,
          options?: {
            interactive?: boolean;
            persons?: Record<string, unknown>;
            resolveImage?: (property: Record<string, unknown>) => string | null | undefined;
            resolveMedia?: (property: Record<string, unknown>, kind: 'video' | 'audio') => string | null | undefined;
          },
        ) => string;
      }
    ).renderDslToString;
    if (!render) {
      console.warn('[larklet] 预览渲染器没有 renderDslToString：', entry);
      return '';
    }

    const persons = previewPersonsTable();
    const imageMap = await prefetchPreviewImages(card, {
      accessToken: async () => {
        if (!app.appId || !app.appSecret) return undefined;
        try {
          return await tenantAccessToken(app.appId, app.appSecret);
        } catch (error) {
          console.warn('[larklet] 预览取 token 失败：', error);
          return undefined;
        }
      },
    });

    return render(card, {
      interactive: true,
      persons: Object.keys(persons).length > 0 ? persons : undefined,
      resolveImage: (property) => {
        const key = mediaKey(property);
        if (key && media[key]) return media[key];
        return key ? imageMap[key] || null : null;
      },
      resolveMedia: (property) => {
        const key = mediaKey(property);
        if (key && media[key]) return media[key];
        return key ? cachedPreviewImage(key) || null : null;
      },
    });
  } catch (error) {
    console.warn('[larklet] 预览渲染失败：', error);
    return '';
  }
}

const TOAST_TYPES = ['info', 'success', 'warning', 'error'] as const;
let toastShellCache: { mtimeMs: number; shells: Record<string, string> } | undefined;

/** 预览 toast 的 DOM 用渲染器 renderToastHTML 现生成，图标和变体类跟 dist 走。 */
async function previewToastShells(): Promise<Record<string, string>> {
  try {
    const file = path.join(rendererPackageDir(), 'dist/index.js');
    const mtimeMs = fs.statSync(file).mtimeMs;
    if (toastShellCache?.mtimeMs === mtimeMs) return toastShellCache.shells;
    const renderer = (await import(pathToFileURL(file).href + '?mtime=' + mtimeMs)) as {
      renderToastHTML?: (type: string, opts: { content: string }) => string;
    };
    if (!renderer.renderToastHTML) return {};
    const shells: Record<string, string> = {};
    for (const type of TOAST_TYPES) {
      shells[type] = renderer.renderToastHTML(type, { content: 'LARKLET_TOAST_CONTENT' });
    }
    toastShellCache = { mtimeMs, shells };
    return shells;
  } catch (error) {
    console.warn('[larklet] 预览 toast 模板加载失败：', error);
    return {};
  }
}

function rendererEntry(): string {
  const entry = path.join(rendererPackageDir(), 'dist/index.js');
  return pathToFileURL(entry).href;
}

/** `app/catalog.*`。`GET /_larklet/apps` 与配套网页的加号菜单都读它。 */
const CATALOG_FILES = ['catalog.ts', 'catalog.tsx', 'catalog.jsx', 'catalog.js'] as const;

function readRendererCss(): string {
  try {
    return fs.readFileSync(path.join(rendererPackageDir(), 'dist/all.css'), 'utf8');
  } catch {
    return '';
  }
}

/**
 * 预览渲染器来自 npm 上的 `@open-feishu-card/renderer`。
 * 正式回调不依赖它。改成别的渲染器时用 LARKLET_RENDERER_DIR 指到包目录。
 */
function rendererPackageDir(): string {
  if (process.env.LARKLET_RENDERER_DIR) return path.resolve(process.env.LARKLET_RENDERER_DIR);

  const entry = createRequire(import.meta.url).resolve('@open-feishu-card/renderer');
  return path.resolve(path.dirname(entry), '..');
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        reject(new LarkletError('请求体不是 JSON', 400));
      }
    });
    req.on('error', reject);
  });
}

async function readAppCatalog(dir: string): Promise<Array<{ href: string; title: string; description: string; intro?: string }>> {
  // 和页面一样接受 .tsx / .ts / .jsx / .js；同时存在多个时按这个顺序取第一个。
  const file = CATALOG_FILES.map((name) => path.join(dir, 'app', name)).find((candidate) => fs.existsSync(candidate));
  if (!file) return [];
  const stamp = fs.statSync(file).mtimeMs;
  const mod = (await import(`${pathToFileURL(file).href}?v=${stamp}`)) as { apps?: unknown };
  if (!Array.isArray(mod.apps)) return [];
  const apps: Array<{ href: string; title: string; description: string; intro?: string }> = [];
  for (const item of mod.apps) {
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  sendText(res, status, html, 'text/html; charset=utf-8');
}

function sendText(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
