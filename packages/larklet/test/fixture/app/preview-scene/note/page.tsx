import { Markdown } from '@open-feishu-card/components';

import { getCardState } from '../../../../../src/index.js';

export default function Page() {
  const label = getCardState<{ label?: string }>()?.label ?? '空';
  return <Markdown content={label} />;
}
