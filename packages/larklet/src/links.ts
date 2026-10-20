/**
 * 飞书卡片里的链接。
 *
 * 卡片按钮的 `url` 只写 `default_url`，PC 端会用系统浏览器打开，飞书 JSAPI 全部失效。
 * 要在 PC 客户端内嵌侧边栏打开网页，必须走 AppLink：
 *
 *   https://applink.feishu.cn/client/web_url/open?mode=sidebar-semi&url=<encodeURIComponent(url)>
 *
 * 协议与参数以开放平台「端内 web-view 访问指定 URL」为准：
 * mode 支持 `sidebar-semi`、`window`、`appCenter`（7.5+）；`sidebar` 是网页应用
 * （web_app/open）的模式，不能用在 web_url/open 上。
 *
 * 国际版 Lark 用 `https://applink.larksuite.com`。`openLink` 把这件事包起来，
 * 直接把它的返回值交给 `<Button url>` 或 Markdown 链接即可。
 */

const APPLINK_HOSTS = {
  feishu: 'https://applink.feishu.cn',
  lark: 'https://applink.larksuite.com',
} as const;

/** 端内网页的打开容器。 */
export type OpenLinkMode = 'sidebar-semi' | 'window' | 'appCenter';

export interface OpenLinkOptions {
  /**
   * `sidebar-semi` 侧边栏（默认）；`window` 独立窗口；`appCenter` 导航栏标签页（飞书 7.5+）。
   */
  mode?: OpenLinkMode;
  /** `lark` 用国际版 AppLink 域名，也可以传完整根地址。默认飞书。 */
  domain?: 'feishu' | 'lark' | (string & {});
  /** 独立窗口高度（仅 `window`），最小 480。 */
  height?: number;
  /** 窗口宽度（`sidebar-semi` / `window`），最小 640。 */
  width?: number;
  /** 最小宽度（仅 `sidebar-semi` / `window`，飞书 7.9+），最小 350。 */
  minWidth?: number;
  /** 最大宽度（仅 `sidebar-semi` / `window`，飞书 7.9+），最小 350。 */
  maxWidth?: number;
}

/**
 * 生成在飞书客户端内打开网页的 AppLink。
 * `url` 需要是完整的 http(s) 地址；带查询串或 fragment 也可以，会整体编码。
 */
export function openLink(url: string, options: OpenLinkOptions = {}): string {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('openLink 需要完整的 http(s) 地址');
  }
  const query: Array<[string, string]> = [
    ['mode', options.mode ?? 'sidebar-semi'],
    ['url', url],
  ];
  if (options.height !== undefined) query.push(['height', String(options.height)]);
  if (options.width !== undefined) query.push(['width', String(options.width)]);
  if (options.minWidth !== undefined) query.push(['min_width', String(options.minWidth)]);
  if (options.maxWidth !== undefined) query.push(['max_width', String(options.maxWidth)]);
  return `${applinkHost(options.domain)}/client/web_url/open?${queryString(query)}`;
}

/**
 * 打开聊天页（单聊或群聊）。`openChatId` 与 `openId` 二选一。
 * 典型用法：卡片按钮把用户带回某个会话。
 */
export function openChat(
  target: { openChatId?: string; openId?: string },
  options: { domain?: OpenLinkOptions['domain'] } = {},
): string {
  const query: Array<[string, string]> = target.openChatId
    ? [['openChatId', target.openChatId]]
    : target.openId
      ? [['openId', target.openId]]
      : [];
  if (query.length === 0) throw new Error('openChat 需要 openChatId 或 openId');
  return `${applinkHost(options.domain)}/client/chat/open?${queryString(query)}`;
}

/** 打开与机器人的会话；`appId` 是机器人所属应用的 App ID。 */
export function openBot(
  appId: string,
  options: { domain?: OpenLinkOptions['domain'] } = {},
): string {
  const id = appId.trim();
  if (!id) throw new Error('openBot 需要 appId');
  return `${applinkHost(options.domain)}/client/bot/open?${queryString([['appId', id]])}`;
}

/** 按 AppLink 文档要求，键和值都做 encodeURIComponent（空格是 %20，不是 +）。 */
function queryString(pairs: Array<[string, string]>): string {
  return pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}

function applinkHost(domain: OpenLinkOptions['domain']): string {
  if (!domain || domain === 'feishu') return APPLINK_HOSTS.feishu;
  if (domain === 'lark') return APPLINK_HOSTS.lark;
  if (/^https?:\/\//i.test(domain)) return domain.replace(/\/+$/, '');
  return APPLINK_HOSTS.feishu;
}
