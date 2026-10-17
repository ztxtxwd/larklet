import { Button, Column, ColumnSet, Hr, Markdown, bindAction } from 'flick/card';
import { getCardState, redirect, setCardState, toast } from 'flick';

import { CHANNELS, ROLES, guideStep, type AppState, type GuideState, type GuideStep } from '../state.js';

const TRAIL = ['认识收件箱', '选择角色', '设置提醒', '开始处理'];

export const aliases = ['指引'];

export default function GuidePage() {
  const state = getCardState<AppState>();
  const guide = state?.guide;
  const step = guideStep(state);
  return (
    <>
      <Markdown content={trail(step)} />
      <Hr />
      {step === 1 ? <Welcome /> : null}
      {step === 2 ? <Role value={guide?.role} /> : null}
      {step === 3 ? <Channel value={guide?.channel} /> : null}
      {step === 4 ? <Done guide={guide} /> : null}
      {step > 1 ? <Button action={prevStep}>上一步</Button> : null}
      {step < 4 ? (
        <Button type="primary" action={nextStep}>
          下一步
        </Button>
      ) : (
        <Button type="primary" action={finishGuide}>
          进入收件箱
        </Button>
      )}
    </>
  );
}

function Welcome() {
  return (
    <Markdown content="这张卡片是审批收件箱。待办列在首页，点「处理」打开单据，备注写回同一张卡片，下次打开还在。" />
  );
}

function Role({ value }: { value?: string }) {
  return (
    <>
      <Markdown content="你主要用它做什么？点一下选中，再走下一步。" />
      <ColumnSet flexMode="bisect">
        <Column width="weighted" weight={1}>
          <Button
            width="fill"
            type={value === 'approver' ? 'primary' : 'default'}
            action={bindAction(pick, 'role', 'approver')}
          >
            审批人
          </Button>
        </Column>
        <Column width="weighted" weight={1}>
          <Button
            width="fill"
            type={value === 'finance' ? 'primary' : 'default'}
            action={bindAction(pick, 'role', 'finance')}
          >
            财务
          </Button>
        </Column>
      </ColumnSet>
      <Markdown content={value ? `已选：${ROLES[value] ?? value}` : '尚未选择'} />
    </>
  );
}

function Channel({ value }: { value?: string }) {
  return (
    <>
      <Markdown content="新单据来了，希望怎么提醒你？" />
      <ColumnSet flexMode="bisect">
        <Column width="weighted" weight={1}>
          <Button width="fill" type={value === 'chat' ? 'primary' : 'default'} action={bindAction(pick, 'channel', 'chat')}>
            群消息
          </Button>
        </Column>
        <Column width="weighted" weight={1}>
          <Button width="fill" type={value === 'mail' ? 'primary' : 'default'} action={bindAction(pick, 'channel', 'mail')}>
            邮件
          </Button>
        </Column>
      </ColumnSet>
      <Markdown content={value ? `已选：${CHANNELS[value] ?? value}` : '尚未选择'} />
    </>
  );
}

function Done({ guide }: { guide?: GuideState }) {
  const role = ROLES[guide?.role ?? ''] ?? '未选角色';
  const channel = CHANNELS[guide?.channel ?? ''] ?? '未选提醒';
  return (
    <Markdown
      content={`可以开始了。你是${role}，提醒走${channel}。\n回到收件箱后，点「处理」就能给单据写备注。`}
    />
  );
}

function trail(step: GuideStep): string {
  return TRAIL.map((title, index) => {
    const n = index + 1;
    return n === step ? `**${n} ${title}**` : `${n} ${title}`;
  }).join('  ·  ');
}

function writeGuide(next: GuideState) {
  const prev = getCardState<AppState>() ?? {};
  setCardState({ ...prev, guide: next });
}

export async function pick(field: string, value: string) {
  'use server';
  if (field !== 'role' && field !== 'channel') return;
  const prev = getCardState<AppState>() ?? {};
  const guide = prev.guide ?? { step: guideStep(prev) };
  writeGuide({ ...guide, [field]: value });
}

export async function nextStep() {
  'use server';
  const prev = getCardState<AppState>() ?? {};
  const guide = prev.guide ?? { step: 1 as GuideStep };
  const step = guideStep(prev);
  if (step === 2 && !guide.role) {
    toast('先选一个角色', 'warning');
    return;
  }
  if (step === 3 && !guide.channel) {
    toast('先选一种提醒方式', 'warning');
    return;
  }
  if (step >= 4) return;
  writeGuide({ ...guide, step: (step + 1) as GuideStep });
}

export async function prevStep() {
  'use server';
  const prev = getCardState<AppState>() ?? {};
  const guide = prev.guide ?? { step: 1 as GuideStep };
  const step = guideStep(prev);
  if (step <= 1) return;
  writeGuide({ ...guide, step: (step - 1) as GuideStep });
}

export async function finishGuide() {
  'use server';
  toast('指引完成，去处理第一张单据吧', 'success');
  redirect('/');
}
