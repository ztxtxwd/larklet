import { Button, Markdown } from '@open-feishu-card/components';

import { deleteEphemeral, sendEphemeral, toast } from '../../../../src/index.js';

export default function Whisper() {
  return (
    <>
      <Markdown content="群里的公开面" />
      <Button action={whisper}>发给对方</Button>
      <Button action={takeBack}>撤回私卡</Button>
    </>
  );
}

export async function whisper() {
  'use server';
  const { messageId } = await sendEphemeral('/whisper/note', 'ou_peer', {
    userState: { text: '只给你看' },
  });
  toast(messageId, 'success');
}

export async function takeBack() {
  'use server';
  await deleteEphemeral('om_private_1');
  toast('已撤回', 'info');
}
