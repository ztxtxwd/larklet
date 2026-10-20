export interface AppState {
  comments?: Record<string, string>;
  guide?: GuideState;
}

export type GuideStep = 1 | 2 | 3 | 4;

export interface GuideState {
  step: GuideStep;
  role?: string;
  channel?: string;
}

export const ROLES: Record<string, string> = {
  approver: '审批人',
  finance: '财务',
};

export const CHANNELS: Record<string, string> = {
  chat: '群消息',
  mail: '邮件',
};

export function guideStep(state: AppState | undefined): GuideStep {
  const step = state?.guide?.step;
  if (step === 2 || step === 3 || step === 4) return step;
  return 1;
}
