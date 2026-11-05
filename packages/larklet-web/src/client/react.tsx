import { useEffect, useState, useSyncExternalStore } from 'react';

import { CompanionSession, type Companion, type CompanionOptions } from './session.js';

export * from './index.js';

/**
 * 订阅配套网页的上下文。组件挂载时自动初始化一次。
 *
 * `options` 只在首次挂载时读取；换地址、换 UA 一般只出现在测试里。
 */
export function useCompanion(options: CompanionOptions = {}): Companion {
  const [session] = useState(() => new CompanionSession(options));
  const state = useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => session.getState(),
    () => session.getState(),
  );
  useEffect(() => {
    void session.start();
  }, [session]);
  return { ...state, ...session.actions };
}
