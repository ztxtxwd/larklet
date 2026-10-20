/**
 * 本地预览上下文：虚拟用户人员表 + 图片解析缓存。
 * 真机回调不走这里；仅 /_larklet/render 与 /_larklet/event 预览用。
 */

import { resolveOpenApiBase } from './feishu.js';
import type { Operator } from './request.js';

export interface PreviewPersonInfo {
  person_id?: string;
  content?: string;
  avatar_key?: string;
  avatar_url?: string;
}

/** open_id → 姓名/头像。进程内共享，多 pane 群聊预览共用一张表。 */
const persons = new Map<string, PreviewPersonInfo>();

/** img_key → data URI / URL。避免同一 key 反复拉取。 */
const imageCache = new Map<string, string>();

export type ResolvePreviewImage = (imgKey: string) => string | null | undefined | Promise<string | null | undefined>;

let resolvePreviewImageHook: ResolvePreviewImage | undefined;

export function setResolvePreviewImage(hook: ResolvePreviewImage | undefined): void {
  resolvePreviewImageHook = hook;
}

/** 登记 / 更新虚拟用户（render query、event operator）。只补缺，不覆盖已有姓名头像。 */
export function rememberPreviewPerson(operator: Operator | undefined): void {
  const openId = operator?.openId;
  if (!openId) return;
  const prev = persons.get(openId);
  const content = operator.name?.trim() || prev?.content;
  const avatar_url = operator.avatar || prev?.avatar_url;
  if (!content && !avatar_url && !prev) {
    persons.set(openId, { person_id: openId });
    return;
  }
  persons.set(openId, {
    person_id: openId,
    content: content || prev?.content,
    avatar_url: avatar_url || prev?.avatar_url,
    avatar_key: prev?.avatar_key,
  });
}

export function previewPersonsTable(): Record<string, PreviewPersonInfo> {
  const out: Record<string, PreviewPersonInfo> = {};
  for (const [id, info] of persons) out[id] = { ...info };
  return out;
}

export function cachedPreviewImage(imgKey: string): string | undefined {
  return imageCache.get(imgKey);
}

export function putPreviewImage(imgKey: string, src: string): void {
  if (imgKey && src) imageCache.set(imgKey, src);
}

/** 从卡片 DSL 里收集 img_key / imageID。 */
export function collectImgKeys(node: unknown, acc: Set<string> = new Set()): Set<string> {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectImgKeys(item, acc);
    return acc;
  }
  const record = node as Record<string, unknown>;
  const key = record.img_key ?? record.imgKey ?? record.imageID ?? record.image_key;
  if (typeof key === 'string' && key) acc.add(key);
  for (const value of Object.values(record)) collectImgKeys(value, acc);
  return acc;
}

/**
 * 解析单个 img_key：内存缓存 → 业务钩子 →（可选）飞书 image/v4/get。
 * 失败返回 null，渲染器会显示「[图片]」占位。
 */
export async function resolvePreviewImageSrc(
  imgKey: string,
  opts: { accessToken?: string | (() => Promise<string | undefined>) } = {},
): Promise<string | null> {
  if (!imgKey) return null;
  const hit = imageCache.get(imgKey);
  if (hit) return hit;

  if (resolvePreviewImageHook) {
    try {
      const fromHook = await resolvePreviewImageHook(imgKey);
      if (fromHook) {
        imageCache.set(imgKey, fromHook);
        return fromHook;
      }
    } catch (error) {
      console.warn('[larklet] resolvePreviewImage 钩子失败：', error);
    }
  }

  const token =
    typeof opts.accessToken === 'function' ? await opts.accessToken() : opts.accessToken;
  if (!token) return null;

  try {
    const url =
      resolveOpenApiBase() + '/open-apis/image/v4/get?image_key=' + encodeURIComponent(imgKey);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.warn(`[larklet] 拉取图片失败 HTTP ${res.status} key=${imgKey}`);
      return null;
    }
    const contentType = res.headers.get('content-type') || 'image/png';
    // 部分错误仍返回 JSON
    if (contentType.includes('application/json')) {
      const body = (await res.json()) as { code?: number; msg?: string };
      console.warn(`[larklet] 拉取图片失败 code=${body.code} msg=${body.msg} key=${imgKey}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const dataUri = `data:${contentType};base64,${buf.toString('base64')}`;
    imageCache.set(imgKey, dataUri);
    return dataUri;
  } catch (error) {
    console.warn(`[larklet] 拉取图片异常 key=${imgKey}：`, error);
    return null;
  }
}

/** 预取卡片用到的图片，返回 key→src 表。 */
export async function prefetchPreviewImages(
  card: unknown,
  opts: { accessToken?: string | (() => Promise<string | undefined>) } = {},
): Promise<Record<string, string>> {
  const keys = [...collectImgKeys(card)];
  const out: Record<string, string> = {};
  await Promise.all(
    keys.map(async (key) => {
      const src = await resolvePreviewImageSrc(key, opts);
      if (src) out[key] = src;
    }),
  );
  return out;
}

const resetHooks: Array<() => void> = [];

/** 预览房间等附属状态在清空时一起复位。 */
export function onResetPreviewContext(hook: () => void): void {
  resetHooks.push(hook);
}

/** 测试用：清空人员表与图片缓存。 */
export function resetPreviewContext(): void {
  persons.clear();
  imageCache.clear();
  for (const hook of resetHooks) hook();
}
