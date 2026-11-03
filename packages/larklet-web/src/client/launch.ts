/**
 * 飞书打开配套网页时带的启动参数。
 *
 * 消息快捷操作与聊天框「+」菜单都用 `bdp_launch_query` 带一个 triggerCode，
 * 网页靠它换出来源消息或当前会话。这里只做解析，不碰 DOM，方便单测。
 */

export interface LaunchQuery {
  /** triggerCode。加号菜单用它换当前会话。 */
  __trigger_id__?: string;
  /** 打开应用的能力：消息快捷操作是 `message_action`，加号菜单是 `chat_action`。 */
  required_launch_ability?: string;
}

/** 加号菜单打开时的会话类型。移动端看不出来，未知时是空串。 */
export type PlusChatType = 'p2p' | 'group' | '';

/** 网页当前是哪个场景。 */
export type Scene = 'message' | 'plus' | '';

/** `bdp_launch_query` 里的启动参数。解析不出来就当没有。 */
export function launchQuery(params: URLSearchParams): LaunchQuery {
  const raw = params.get('bdp_launch_query');
  if (!raw) return {};
  return parseLaunchQuery(raw) ?? {};
}

/**
 * 是否从聊天框的「+」菜单打开。
 *
 * PC 看 `from`（`plus_menu_p2p` / `plus_menu_group`），
 * 移动端看 `required_launch_ability` 是 `chat_action`。
 */
export function isPlusMenu(params: URLSearchParams): boolean {
  const from = params.get('from') || '';
  if (from === 'plus_menu_p2p' || from === 'plus_menu_group') return true;
  const ability = params.get('required_launch_ability') || launchQuery(params).required_launch_ability || '';
  return ability === 'chat_action';
}

/** 「+」菜单打开时的会话类型。PC 能从 `from` 看出来，移动端看不出来。 */
export function plusChatType(params: URLSearchParams): PlusChatType {
  const from = params.get('from') || '';
  if (from === 'plus_menu_p2p') return 'p2p';
  if (from === 'plus_menu_group') return 'group';
  return '';
}

/** triggerCode。加号菜单用它换当前会话。 */
export function readTriggerCode(params: URLSearchParams): string {
  return launchQuery(params).__trigger_id__ || '';
}

/**
 * 是否从消息的快捷操作打开。
 *
 * PC 看 `from`（`message_action`），移动端看 `required_launch_ability`。
 */
export function isMessageAction(params: URLSearchParams): boolean {
  const from = params.get('from') || '';
  if (from === 'message_action') return true;
  const ability = params.get('required_launch_ability') || launchQuery(params).required_launch_ability || '';
  return ability === 'message_action';
}

/**
 * 从路径看场景。
 *
 * 飞书后台给两个场景配不同路径时用：消息快捷操作 `path=/message`，
 * 加号菜单 `path=/plus`。
 */
export function sceneFromPath(pathname: string): Scene {
  const last = pathname.replace(/\/+$/, '').split('/').pop() ?? '';
  if (last === 'message') return 'message';
  if (last === 'plus') return 'plus';
  return '';
}

/**
 * 当前是哪个场景。
 *
 * 路径优先：飞书客户端会复用同一个侧边栏页面，`reload=false`（默认值）时
 * 两个场景都指向同一个路径的话，页面会留着上一次的启动参数，
 * 消息快捷操作就会看成加号菜单。配不同路径就没这个毛病。
 *
 * 没有路径标记时，退回看飞书自动加的参数。
 */
export function sceneOf(params: URLSearchParams, pathname: string): Scene {
  const byPath = sceneFromPath(pathname);
  if (byPath) return byPath;
  if (isPlusMenu(params)) return 'plus';
  if (isMessageAction(params)) return 'message';
  return '';
}

/**
 * 读会话信息时该按什么顺序试。
 *
 * `getChatInfo` 要会话类型：0 是单聊，1 是群聊；单聊还要 userType（0 用户、1 机器人）。
 * PC 能从 `from` 看出是哪种会话，移动端看不出来，就群聊、单聊各试一次。
 */
export function chatInfoAttempts(chatType: PlusChatType): Array<[0 | 1, 0 | 1]> {
  if (chatType === 'p2p') return [[0, 0], [0, 1]];
  if (chatType === 'group') return [[1, 0]];
  return [[1, 0], [0, 0], [0, 1]];
}

/** 有些客户端会把 launchQuery 再编码一层，解不出来就再解一次。 */
function parseLaunchQuery(raw: string): LaunchQuery | undefined {
  for (const text of [raw, safeDecode(raw)]) {
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as LaunchQuery;
    } catch {
      // 不是 JSON，换一种解法。
    }
  }
  return undefined;
}

function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}
