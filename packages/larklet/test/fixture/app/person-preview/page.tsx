import { Image, Markdown, Person } from '@open-feishu-card/components';

import { operator } from '../../../../src/index.js';

export default function PersonPreviewPage() {
  const openId = operator()?.openId || 'ou_missing';
  return (
    <>
      <Markdown content={`操作人 <at id="${openId}"></at>`} />
      <Person userId={openId} showAvatar showName size="medium" style="capsule" />
      <Image imgKey="img_preview_demo" alt="demo" scaleType="fit_horizontal" />
    </>
  );
}
