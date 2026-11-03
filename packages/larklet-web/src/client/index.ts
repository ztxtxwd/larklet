export { CompanionPage, SendMenu, appCatalogMenu, registerAppDetail, registerPlusMenu } from './page.js';
export type {
  AppDetailContext,
  PlusMenuContext,
  PlusMenuRegistration,
  PlusMenuUser,
  SendAs,
  SendMenuProps,
  SendTarget,
} from './page.js';
// 场景判断：配套网页自己按场景渲染时用得上。
export { isMessageAction, isPlusMenu, sceneFromPath, sceneOf } from './launch.js';
export type { LaunchQuery, PlusChatType, Scene } from './launch.js';
