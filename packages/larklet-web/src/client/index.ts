export {
  CompanionSession,
  type Companion,
  type CompanionActions,
  type CompanionChat,
  type CompanionMessage,
  type CompanionOptions,
  type CompanionState,
  type CompanionUser,
  type SendAppOptions,
} from './session.js';

export {
  MESSAGE_TYPES,
  USER_READ_SCOPES,
  USER_SEND_SCOPES,
  chatNameOf,
  chooseChat,
  configJsapi,
  coversScopes,
  currentChatId,
  currentPageUrl,
  deliverPreview,
  ensureUserToken,
  fetchConfig,
  fetchJson,
  formatAccessError,
  isFeishuUserAgent,
  loadApps,
  loadH5Sdk,
  messageTypeLabel,
  readMessage,
  sendAppRequest,
  sourceMessageId,
} from './runtime.js';
export type {
  ChatPick,
  CompanionConfig,
  ListedApp,
  MessageRead,
  SendAs,
  SendResult,
  SendTarget,
  UserAuth,
} from './runtime.js';

// 场景判断：路径和启动参数怎么认。
export { isMessageAction, isPlusMenu, plusChatType, readTriggerCode, sceneFromPath, sceneOf } from './launch.js';
export type { LaunchQuery, PlusChatType, Scene } from './launch.js';

// React 在 `larklet-web/react` 里：`useCompanion`。
