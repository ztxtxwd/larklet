import { Markdown } from '@open-feishu-card/components';

import { getCardState } from '../../../../../src/index.js';

export default function Note() {
  const label = getCardState<{ label?: string }>()?.label ?? '';
  return <Markdown content={label} />;
}
