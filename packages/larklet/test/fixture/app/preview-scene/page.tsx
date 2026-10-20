import { Markdown } from '@open-feishu-card/components';

import { getCardState } from '../../../../src/index.js';

export const previewScene = {
  userState: { label: '群里的卡片' },
  users: [
    { name: '阿明', role: 'seller' as const },
    { name: '小林', role: 'buyer' as const },
  ],
  aside: { href: '/preview-scene/note', role: 'seller' as const, userState: { label: '仅卖家' } },
};

export default function Page() {
  const label = getCardState<{ label?: string }>()?.label ?? '空';
  return <Markdown content={label} />;
}
