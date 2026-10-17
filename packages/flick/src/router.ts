import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { registerAction } from '@open-feishu-card/components';

import { pathnameSegments } from './href.js';
import type { SearchParams } from './request.js';

export type RouteSegment =
  | { type: 'static'; name: string }
  | { type: 'dynamic'; name: string }
  | { type: 'catchall'; name: string };

export interface LayoutModule {
  dir: string;
  file: string;
  component: PageComponent;
}

export interface Route {
  pattern: string;
  pageDir: string;
  file: string;
  segments: RouteSegment[];
  /** 与 `segments` 同结构的替代路径，例如 `/指引`、`/工单/[id]`。 */
  aliases: RouteSegment[][];
  layouts: LayoutModule[];
  component: PageComponent;
  error?: PageComponent;
  notFound?: PageComponent;
}

export interface PageProps {
  params: Record<string, string | string[]>;
  searchParams: SearchParams;
  children?: unknown;
  error?: { message: string };
}

export type PageComponent = (props: PageProps) => unknown;

interface LayoutRecord {
  dir: string;
  file: string;
  component: PageComponent;
}

const PAGE_FILES = new Set(['page.tsx', 'page.ts', 'page.jsx', 'page.js']);
const LAYOUT_FILES = new Set(['layout.tsx', 'layout.ts', 'layout.jsx', 'layout.js']);
const ERROR_FILES = new Set(['error.tsx', 'error.ts', 'error.jsx', 'error.js']);
const NOT_FOUND_FILES = new Set(['not-found.tsx', 'not-found.ts', 'not-found.jsx', 'not-found.js']);
const ACTION_FILES = new Set(['actions.tsx', 'actions.ts', 'actions.jsx', 'actions.js']);

export async function loadRoutes(appDir: string): Promise<Route[]> {
  const files = await listFiles(appDir);
  const layouts = new Map<string, LayoutRecord>();
  const errors = new Map<string, PageComponent>();
  const notFound = new Map<string, PageComponent>();
  const pages: Array<{ relDir: string; file: string }> = [];

  for (const file of files) {
    const base = path.basename(file);
    const relDir = path.relative(appDir, path.dirname(file)).split(path.sep).join('/');
    const key = relDir === '.' ? '' : relDir;
    if (PAGE_FILES.has(base)) pages.push({ relDir: key, file });
    if (LAYOUT_FILES.has(base) || ERROR_FILES.has(base) || NOT_FOUND_FILES.has(base) || ACTION_FILES.has(base)) {
      const mod = await importModule(file);
      if (LAYOUT_FILES.has(base)) {
        if (typeof mod.default !== 'function') {
          throw new Error(`${file} 需要默认导出布局组件`);
        }
        layouts.set(key, { dir: key, file, component: mod.default as PageComponent });
      }
      if (ERROR_FILES.has(base) && typeof mod.default === 'function') {
        errors.set(key, mod.default as PageComponent);
      }
      if (NOT_FOUND_FILES.has(base) && typeof mod.default === 'function') {
        notFound.set(key, mod.default as PageComponent);
      }
      if (ACTION_FILES.has(base)) registerModuleActions(patternFromDir(key), mod);
    }
  }

  const routes: Route[] = [];
  for (const page of pages) {
    const mod = await importModule(page.file);
    if (typeof mod.default !== 'function') {
      throw new Error(`${page.file} 需要默认导出页面组件`);
    }
    const segments = segmentsFromDir(page.relDir);
    const pattern = patternFromSegments(segments);
    registerModuleActions(pattern, mod);
    routes.push({
      pattern,
      pageDir: page.relDir,
      file: page.file,
      segments,
      aliases: aliasesFromModule(mod, segments, page.file),
      layouts: layoutsFor(page.relDir, layouts),
      component: mod.default as PageComponent,
      error: nearestSpecial(page.relDir, errors),
      notFound: nearestSpecial(page.relDir, notFound),
    });
  }

  assertUniquePatterns(routes);
  return routes;
}

export interface RouteMatch {
  route: Route;
  params: Record<string, string | string[]>;
}

export function matchRoute(routes: Route[], pathname: string): RouteMatch | null {
  const parts = pathnameSegments(pathname);
  const direct = bestMatch(routes, parts, (route) => [route.segments]);
  if (direct) return direct;
  return bestMatch(routes, parts, (route) => route.aliases);
}

function bestMatch(
  routes: Route[],
  parts: string[],
  candidates: (route: Route) => RouteSegment[][],
): RouteMatch | null {
  let best: { match: RouteMatch; score: number } | null = null;

  for (const route of routes) {
    for (const segments of candidates(route)) {
      const params = matchSegments(segments, parts);
      if (!params) continue;
      const score = scoreSegments(segments);
      if (!best || score > best.score) best = { match: { route, params }, score };
    }
  }

  return best?.match ?? null;
}

/** 用页面自己的路径段拼出规范 pathname，别名命中后卡片仍记这条路径。 */
export function canonicalPathname(route: Route, params: Record<string, string | string[]>): string {
  if (route.segments.length === 0) return '/';
  const parts = route.segments.map((segment) => {
    if (segment.type === 'static') return segment.name;
    const value = params[segment.name];
    return Array.isArray(value) ? value.join('/') : (value ?? '');
  });
  return `/${parts.join('/')}`;
}

export function matchSegments(
  segments: RouteSegment[],
  parts: string[],
): Record<string, string | string[]> | null {
  const params: Record<string, string | string[]> = {};
  let index = 0;

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (!segment) return null;
    if (segment.type === 'catchall') {
      if (i !== segments.length - 1) return null;
      if (index >= parts.length) return null;
      params[segment.name] = parts.slice(index);
      return params;
    }
    const part = parts[index];
    if (part === undefined) return null;
    if (segment.type === 'static') {
      if (part !== segment.name) return null;
    } else {
      params[segment.name] = part;
    }
    index += 1;
  }

  return index === parts.length ? params : null;
}

function scoreSegments(segments: RouteSegment[]): number {
  let score = 0;
  for (const segment of segments) {
    if (segment.type === 'static') score += 100;
    else if (segment.type === 'dynamic') score += 10;
    else score += 1;
  }
  return score;
}

function segmentsFromDir(relDir: string): RouteSegment[] {
  if (!relDir) return [];
  const segments: RouteSegment[] = [];
  for (const part of relDir.split('/')) {
    if (!part || part.startsWith('(') || part.startsWith('_') || part.startsWith('@')) continue;
    segments.push(parseSegment(part));
  }
  return segments;
}

function patternFromDir(relDir: string): string {
  return patternFromSegments(segmentsFromDir(relDir));
}

function patternFromSegments(segments: RouteSegment[]): string {
  if (segments.length === 0) return '/';
  return `/${segments
    .map((segment) => {
      if (segment.type === 'dynamic') return `[${segment.name}]`;
      if (segment.type === 'catchall') return `[...${segment.name}]`;
      return segment.name;
    })
    .join('/')}`;
}

function aliasesFromModule(
  mod: Record<string, unknown>,
  segments: RouteSegment[],
  file: string,
): RouteSegment[][] {
  if (mod.aliases === undefined) return [];
  if (!Array.isArray(mod.aliases) || mod.aliases.some((alias) => typeof alias !== 'string')) {
    throw new Error(`${file} 的 aliases 需要是字符串数组`);
  }
  const canonical = patternFromSegments(segments);
  const seen = new Set<string>();
  const aliases: RouteSegment[][] = [];
  for (const alias of mod.aliases) {
    const compiled = compileAlias(alias, segments, file);
    const pattern = patternFromSegments(compiled);
    if (pattern === canonical || seen.has(pattern)) continue;
    seen.add(pattern);
    aliases.push(compiled);
  }
  return aliases;
}

/**
 * 别名与页面路径同形。动态段、捕获段必须沿用原来的参数名。
 * 只写静态前缀时，尾部的动态段会自动补上：`工单` 即 `工单/[id]`。
 */
function compileAlias(alias: string, segments: RouteSegment[], file: string): RouteSegment[] {
  const raw = alias.trim();
  const body = raw.startsWith('/') ? raw.slice(1) : raw;
  if (!body || body.endsWith('/')) {
    throw new Error(`${file} 的别名 \`${alias}\` 不是有效路径`);
  }
  const parts = body.split('/');
  if (parts.some((part) => part.length === 0)) {
    throw new Error(`${file} 的别名 \`${alias}\` 不是有效路径`);
  }
  if (parts.length > segments.length) {
    throw new Error(`${file} 的别名 \`${alias}\` 比页面路径更长`);
  }
  if (parts.length < segments.length) {
    const rest = segments.slice(parts.length);
    if (rest.some((segment) => segment.type === 'static')) {
      throw new Error(
        `${file} 的别名 \`${alias}\` 后面还有静态段，请写完整路径，动态段写成 [参数名]`,
      );
    }
  }

  return segments.map((segment, index) => {
    const part = parts[index];
    if (part === undefined) return segment;
    if (segment.type === 'static') {
      if (part.startsWith('[')) {
        throw new Error(`${file} 的别名 \`${alias}\` 把静态段写成了 ${part}`);
      }
      return { type: 'static', name: part };
    }
    const expected = segment.type === 'dynamic' ? `[${segment.name}]` : `[...${segment.name}]`;
    if (part !== expected) {
      throw new Error(`${file} 的别名 \`${alias}\` 的第 ${index + 1} 段需要写成 ${expected}`);
    }
    return segment;
  });
}

function assertUniquePatterns(routes: Route[]): void {
  const owners = new Map<string, string>();
  for (const route of routes) {
    claimPattern(owners, route.pattern, route.file);
    for (const alias of route.aliases) {
      claimPattern(owners, patternFromSegments(alias), route.file);
    }
  }
}

function claimPattern(owners: Map<string, string>, pattern: string, file: string): void {
  const previous = owners.get(pattern);
  if (previous) {
    throw new Error(`路径 ${pattern} 同时属于 ${previous} 和 ${file}`);
  }
  owners.set(pattern, file);
}

function parseSegment(part: string): RouteSegment {
  const catchall = /^\[\.\.\.([A-Za-z0-9_]+)\]$/.exec(part);
  if (catchall?.[1]) return { type: 'catchall', name: catchall[1] };
  const dynamic = /^\[([A-Za-z0-9_]+)\]$/.exec(part);
  if (dynamic?.[1]) return { type: 'dynamic', name: dynamic[1] };
  return { type: 'static', name: part };
}

function layoutsFor(pageDir: string, layouts: Map<string, LayoutRecord>): LayoutModule[] {
  const parts = pageDir ? pageDir.split('/') : [];
  const found: LayoutModule[] = [];
  for (let i = 0; i <= parts.length; i += 1) {
    const key = parts.slice(0, i).join('/');
    const layout = layouts.get(key);
    if (layout) found.push(layout);
  }
  return found;
}

function nearestSpecial<T>(pageDir: string, map: Map<string, T>): T | undefined {
  const parts = pageDir ? pageDir.split('/') : [];
  for (let i = parts.length; i >= 0; i -= 1) {
    const key = parts.slice(0, i).join('/');
    const found = map.get(key);
    if (found) return found;
  }
  return undefined;
}

const moduleCache = new Map<string, { mtimeMs: number; mod: Record<string, unknown> }>();

export async function importModule(file: string): Promise<Record<string, unknown>> {
  const stat = await fs.stat(file);
  const cached = moduleCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.mod;
  const href = `${pathToFileURL(file).href}?t=${stat.mtimeMs}`;
  const mod = (await import(href)) as Record<string, unknown>;
  moduleCache.set(file, { mtimeMs: stat.mtimeMs, mod });
  return mod;
}

export function clearModuleCache(): void {
  moduleCache.clear();
}

function registerModuleActions(pattern: string, mod: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(mod)) {
    if (name === 'default') continue;
    if (typeof value !== 'function') continue;
    if (!isServerAction(value)) continue;
    registerAction(`${pattern}#${name}`, value as (...args: never[]) => unknown);
  }
}

function isServerAction(fn: Function): boolean {
  if ((fn as { __flickServerAction?: boolean }).__flickServerAction) return true;
  const source = Function.prototype.toString.call(fn);
  return /['"]use server['"]/.test(source);
}

/** 显式标记 Server Action。编译器若剥掉指令，用这个包装。 */
export function serverAction<F extends (...args: never[]) => unknown>(fn: F): F {
  Object.defineProperty(fn, '__flickServerAction', { value: true });
  return fn;
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('_')) continue;
        await walk(full);
        continue;
      }
      out.push(full);
    }
  }
  await walk(dir);
  return out;
}
