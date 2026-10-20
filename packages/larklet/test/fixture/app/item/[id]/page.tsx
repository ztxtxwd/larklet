import { Markdown } from '@open-feishu-card/components';

export const aliases = ['单号', '单据/[id]'];

import { getCardState } from '../../../../../src/index.js';
import type { SearchParams } from '../../../../../src/index.js';

export default function ItemPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: SearchParams;
}) {
  const note = getCardState<{ note?: string }>()?.note ?? '';
  const from = typeof searchParams.from === 'string' ? searchParams.from : '';
  return <Markdown content={`单号 ${params.id} 来自 ${from} 备注 ${note}`} />;
}
