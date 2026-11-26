export type ProjectStatus =
  | 'creating'
  | 'provisioning'
  | 'starting'
  | 'running'
  | 'freezing'
  | 'frozen'
  | 'stopping'
  | 'stopped'
  | 'resuming'
  | 'archiving'
  | 'archived'
  | 'deleting'
  | 'deleted'
  | 'error';

export type DesiredProjectState = 'running' | 'frozen' | 'stopped' | 'archived' | 'deleted';

export const TRANSITIONAL_STATES: ReadonlySet<ProjectStatus> = new Set([
  'creating',
  'provisioning',
  'starting',
  'freezing',
  'stopping',
  'resuming',
  'archiving',
  'deleting'
]);

export const ATTESTABLE_STATES: ReadonlySet<ProjectStatus> = new Set([
  'provisioning',
  'starting',
  'resuming',
  'running'
]);

const ALLOWED_TRANSITIONS: Record<ProjectStatus, ReadonlyArray<ProjectStatus>> = {
  creating: ['provisioning', 'deleting', 'error'],
  provisioning: ['starting', 'running', 'deleting', 'error'],
  starting: ['running', 'stopped', 'deleting', 'error'],
  running: ['freezing', 'stopping', 'deleting', 'error'],
  freezing: ['frozen', 'running', 'stopping', 'deleting', 'error'],
  frozen: ['resuming', 'stopping', 'deleting', 'error'],
  stopping: ['stopped', 'deleting', 'error'],
  stopped: ['starting', 'archiving', 'deleting', 'error'],
  resuming: ['running', 'frozen', 'starting', 'deleting', 'error'],
  archiving: ['archived', 'stopped', 'deleting', 'error'],
  archived: ['provisioning', 'deleting', 'error'],
  deleting: ['deleted', 'error'],
  deleted: [],
  error: ['provisioning', 'starting', 'resuming', 'stopping', 'deleting']
};

export function canTransitionProject(from: ProjectStatus, to: ProjectStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertValidTransition(from: ProjectStatus, to: ProjectStatus): void {
  if (!canTransitionProject(from, to)) {
    throw new Error(`Invalid project state transition: ${from} -> ${to}`);
  }
}

export function buildWakeIdempotencyKey(projectId: string, stateVersion: number): string {
  return `wake:${projectId}:v${stateVersion}`;
}
