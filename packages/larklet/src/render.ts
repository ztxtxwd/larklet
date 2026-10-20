import {
  Card,
  Markdown,
  createElement,
  renderToCard,
  type FeishuCardJson,
  type VNode,
} from '@open-feishu-card/components';
import { VNODE, isVNode } from '@open-feishu-card/components/jsx-runtime';

import { isNotFoundError, isRedirectError } from './navigation.js';
import type { LarkletStore } from './request.js';
import { canonicalPathname, matchRoute, type PageComponent, type Route } from './router.js';
import { attachLarkletState, envelopeFromStore, type InteractiveControl } from './state.js';

const MAX_DEPTH = 32;

export interface RenderedCard {
  card: FeishuCardJson;
  controls: InteractiveControl[];
}

export async function renderCard(routes: Route[], store: LarkletStore): Promise<RenderedCard> {
  for (;;) {
    try {
      return await renderOnce(routes, store);
    } catch (error) {
      if (isRedirectError(error)) continue;
      if (isNotFoundError(error)) {
        if (store.forceNotFound) throw new Error('not-found 页面不能再调用 notFound()');
        store.forceNotFound = true;
        continue;
      }
      throw error;
    }
  }
}

async function renderOnce(routes: Route[], store: LarkletStore): Promise<RenderedCard> {
  if (store.forceNotFound) return finalize(await composeStatus(routes, store, 'not-found'), store);

  const match = matchRoute(routes, store.pathname);
  if (!match) {
    store.forceNotFound = true;
    return finalize(await composeStatus(routes, store, 'not-found'), store);
  }

  store.pathname = canonicalPathname(match.route, match.params);
  store.pattern = match.route.pattern;
  store.params = match.params;

  try {
    const tree = await compose(match.route, store, 'page');
    return finalize(tree, store);
  } catch (error) {
    if (isRedirectError(error) || isNotFoundError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const tree = await compose(match.route, store, 'error', { message });
    return finalize(tree, store);
  }
}

async function compose(
  route: Route,
  store: LarkletStore,
  kind: 'page' | 'error' | 'not-found',
  error?: { message: string },
): Promise<VNode> {
  const props = { params: store.params, searchParams: store.searchParams, error };
  let tree: unknown;
  if (kind === 'page') tree = await route.component(props);
  else if (kind === 'error') tree = route.error ? await route.error(props) : builtinError(error?.message ?? '未知错误');
  else tree = route.notFound ? await route.notFound(props) : builtinNotFound(store.pathname);

  tree = await resolveTree(tree, 0);
  for (const layout of [...route.layouts].reverse()) {
    tree = await layout.component({ ...props, children: tree });
    tree = await resolveTree(tree, 0);
  }
  return ensureCard(tree);
}

async function composeStatus(routes: Route[], store: LarkletStore, _kind: 'not-found'): Promise<VNode> {
  const donor = routes.find((route) => route.notFound) ?? routes[0];
  if (!donor) return ensureCard(builtinNotFound(store.pathname));
  const props = { params: store.params, searchParams: store.searchParams };
  let tree: unknown = donor.notFound ? await donor.notFound(props) : builtinNotFound(store.pathname);
  tree = await resolveTree(tree, 0);
  const layouts = donor.layouts.filter((layout) => layout.dir === '');
  for (const layout of [...layouts].reverse()) {
    tree = await layout.component({ ...props, children: tree });
    tree = await resolveTree(tree, 0);
  }
  return ensureCard(tree);
}

function finalize(tree: VNode, store: LarkletStore): RenderedCard {
  const card = renderToCard(tree);
  const controls = attachLarkletState(card, envelopeFromStore(store));
  return { card, controls };
}

async function ensureCard(tree: unknown): Promise<VNode> {
  const resolved = await resolveTree(tree, 0);
  if (isVNode(resolved) && resolved.type === 'card') return resolved;
  const wrapped = createElement(Card, { config: { update_multi: true } }, resolved as never);
  const card = await resolveTree(wrapped, 0);
  if (!isVNode(card)) throw new Error('根节点必须是 Card');
  return card;
}

async function resolveTree(node: unknown, depth: number): Promise<unknown> {
  if (depth > MAX_DEPTH) throw new Error('组件展开层数过深');
  if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') {
    return node;
  }
  if (Array.isArray(node)) {
    const out = [];
    for (const item of node) out.push(await resolveTree(item, depth));
    return out;
  }
  if (!isVNode(node)) return node;
  if (typeof node.type === 'function') {
    const rendered = await (node.type as PageComponent)(node.props as never);
    return resolveTree(rendered, depth + 1);
  }
  const props = { ...(node.props as Record<string, unknown>) };
  if ('children' in props) props.children = await resolveTree(props.children, depth + 1);
  if ('extra' in props) props.extra = await resolveTree(props.extra, depth + 1);
  return {
    [VNODE]: true,
    type: node.type,
    props,
    key: node.key,
  };
}

function builtinError(message: string): unknown {
  return createElement(Markdown, { content: `出错了：${message}` });
}

function builtinNotFound(pathname: string): unknown {
  return createElement(Markdown, { content: `找不到卡片 \`${pathname}\`` });
}
