/** Conversation card for one DSH-owned KerSor experiment. */

import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { KersorViewerKey } from './locales.ts'
import css from './KersorExperimentNode.module.css'

/** Navigation injected by the KerSor client plugin. */
export interface KersorExperimentInjected {
  readonly openController: (childSessionId: SessionId) => void
}

/** Complete keyed Chat renderer props. */
export type KersorExperimentNodeProps =
  PropsRuntime<'conversation.chat.node', 'kersor-experiment'>
  & PropsLocale<'kersorViewer'>
  & KersorExperimentInjected

const STATUS_KEYS = {
  provisioning: 'experiment.status.provisioning',
  running: 'experiment.status.running',
  waiting: 'experiment.status.waiting',
  blocked: 'experiment.status.blocked',
  completed: 'experiment.status.completed',
  cancelled: 'experiment.status.cancelled',
} as const satisfies Record<
  KersorExperimentNodeProps['node']['data']['status'],
  KersorViewerKey
>

/** Render one stable experiment summary and its durable child-conversation link. */
export function KersorExperimentNode({ node, openController, t }: KersorExperimentNodeProps) {
  const data = node.data
  const complete = data.steps.filter(step => step.status === 'completed').length
  const progress = data.steps.length === 0 ? 0 : Math.round(complete * 100 / data.steps.length)
  const round = data.currentRound === undefined
    ? null
    : data.maxWorkflows === undefined
      ? t('experiment.roundOpen', { current: data.currentRound })
      : t('experiment.round', { current: data.currentRound, maximum: data.maxWorkflows })
  return (
    <article className={css.card} data-experiment-status={data.status}>
      <header className={css.header}>
        <div>
          <div className={css.eyebrow}>{t('experiment.title')}</div>
          <div className={css.title}>{data.kersorSessionId ?? data.experimentId}</div>
        </div>
        <span className={css.status}>{t(STATUS_KEYS[data.status])}</span>
      </header>
      <p className={css.objective}>{data.objective}</p>
      <div className={css.facts}>
        {data.phase === undefined ? null : <span>{t('experiment.phase', { phase: data.phase })}</span>}
        {round === null ? null : <span>{round}</span>}
        {data.workflow === undefined ? null : <span>{t('experiment.workflow', { workflow: data.workflow })}</span>}
        {data.bestSpeedup === undefined ? null : <span>{t('experiment.best', { speedup: data.bestSpeedup })}</span>}
      </div>
      {data.steps.length === 0 ? null : (
        <div className={css.progress}>
          <div className={css.progressTrack} aria-label={t('experiment.progress', { progress })}>
            <span style={{ width: `${progress}%` }} />
          </div>
          <ol className={css.steps}>
            {data.steps.map(step => (
              <li key={step.id} data-step-status={step.status}>
                <span className={css.dot} />
                <span>{t(`detail.step.${step.id}` as KersorViewerKey)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {data.nextAction === undefined ? null : (
        <p className={css.next}><strong>{t('experiment.next')}</strong> {data.nextAction}</p>
      )}
      <footer className={css.footer}>
        <button
          type="button"
          className={css.open}
          disabled={data.status === 'provisioning'}
          onClick={() => { openController(data.childSessionId as SessionId) }}
        >
          {t('experiment.openController')}
        </button>
        <code>{data.childSessionId}</code>
      </footer>
    </article>
  )
}
