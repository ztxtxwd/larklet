import { Markdown } from '@open-feishu-card/components';

import { getCardState, operator } from '../../../../../src/index.js';

export default function Note() {
  const text = getCardState<{ text?: string }>()?.text ?? '';
  const who = operator()?.openId ?? '';
  return <Markdown content={`${text} @${who}`} />;
}
