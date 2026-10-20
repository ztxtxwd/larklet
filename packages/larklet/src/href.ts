import type { SearchParams } from './request.js';

export interface ParsedHref {
  pathname: string;
  searchParams: SearchParams;
}

/** 把 `/item/42?from=home` 拆成 pathname 与 searchParams。 */
export function parseHref(href: string): ParsedHref {
  const url = new URL(href, 'http://larklet.local');
  const pathname = normalizePathname(url.pathname);
  const searchParams: SearchParams = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    searchParams[key] = all.length > 1 ? all : all[0];
  }
  return { pathname, searchParams };
}

export function normalizePathname(pathname: string): string {
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  pathname = decodePathname(pathname);
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  return pathname;
}

export function pathnameSegments(pathname: string): string[] {
  if (pathname === '/') return [];
  return decodePathname(pathname).split('/').filter(Boolean);
}

/** `URL` 会把中文路径转成百分号编码，匹配前还原成原文。 */
function decodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}
