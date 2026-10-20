import { parseHref } from './href.js';
import { readStore, useStore, type Toast } from './request.js';

export class RedirectError extends Error {
  readonly href: string;

  constructor(href: string) {
    super(`REDIRECT ${href}`);
    this.name = 'RedirectError';
    this.href = href;
  }
}

export class NotFoundError extends Error {
  constructor() {
    super('LARKLET_NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export function isRedirectError(error: unknown): error is RedirectError {
  return error instanceof RedirectError;
}

export function isNotFoundError(error: unknown): error is NotFoundError {
  return error instanceof NotFoundError;
}

/**
 * 结束当前渲染或 Action，改渲染另一张卡片。
 * 回调响应里会换成目标路由的卡片 JSON（更新当前消息上的卡片）。
 */
export function redirect(href: string): never {
  if (!href.startsWith('/')) {
    throw new Error('redirect 只接受站内路径，例如 redirect("/item/42")');
  }
  const store = readStore();
  if (store) {
    const next = parseHref(href);
    store.pathname = next.pathname;
    store.searchParams = next.searchParams;
    store.hops += 1;
    if (store.hops > 8) {
      throw new Error(`redirect 次数过多：${href}`);
    }
  }
  throw new RedirectError(href);
}

/** 改渲染 app/not-found.tsx。 */
export function notFound(): never {
  throw new NotFoundError();
}

/** 随本次回调一起返回的 toast。后写的覆盖先写的。 */
export function toast(content: string, type: Toast['type'] = 'info'): void {
  useStore().toast = { type, content };
}

/** 这次点击不更新当前卡片。飞书只弹出 toast，原卡片保持不动。 */
export function leaveCard(): void {
  useStore().leaveCard = true;
}
