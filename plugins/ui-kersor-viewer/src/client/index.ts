/**
 * KerSor viewer browser half: one atomic Host snapshot plus optional launcher
 * process ownership, rendered as a first-class conversation view.
 * @module @deepseek-ai/dsh-client-ui-kersor-viewer/client
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-kersor/remote'
import type {} from '@deepseek-ai/dsh-kersor-viewer/remote'
import type { KersorViewerFrame } from '@deepseek-ai/dsh-kersor-viewer/types'
import type { KersorActiveFrame, KersorTaskId } from '@deepseek-ai/dsh-kersor/types'
import { KersorView } from './KersorView.tsx'
import { KersorExperimentNode, type KersorExperimentInjected } from './KersorExperimentNode.tsx'
import { kersorExperimentDefinition } from './experiment-definition.ts'
import { KersorViewerStore } from './store.ts'
import type { KersorViewFace } from './slots.ts'
import { en, NS, zh } from './locales.ts'
import type { KersorViewerKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** KerSor viewer panel copy. */
    kersorViewer: KersorViewerKey
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection extends Record<'kersor/event' | 'kersor/active', true> {}
}

export type { KersorViewFace } from './slots.ts'
export type { KersorViewerState, KersorViewerStore, KersorRunRow } from './store.ts'
export { KersorViewerStore as KersorViewerStoreClass } from './store.ts'
export { NS }
export type { KersorViewerKey } from './locales.ts'

/** Required services: viewer UI seams, assembled Remotes, and Host inventory. */
export const inject = [
  'slots', 'locale', 'remote', 'remote.pluginInventory', 'sessions', 'conversationEvents',
]

/** Mount the KerSor viewer surfaces over the API assembly's Remote namespaces. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'kersor-viewer: dictionaries')
  ctx.conversationEvents.register(kersorExperimentDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'kersor-experiment',
    locale: NS,
    inject: (): KersorExperimentInjected => ({
      openController(childSessionId: SessionId) {
        const parentSessionId = ctx.sessions.list.getSnapshot().current
        if (parentSessionId === undefined) return
        void ctx.sessions.refreshSubagents(parentSessionId).then(() => {
          ctx.sessions.openSubagent({ parentSessionId, childSessionId, mode: 'continuable' })
        })
      },
    }),
  }, KersorExperimentNode))

  const store = new KersorViewerStore()
  const classicDetailRevisions = new Map<string, string>()

  const classicRevision = (sessionDir: string): string | undefined => {
    const session = store.getSnapshot().snapshot?.classic.sessions
      .find(candidate => candidate.session_dir === sessionDir)
    return session === undefined
      ? undefined
      : `${session.last_activity_at ?? ''}:${session.phase ?? ''}:${session.current_round ?? ''}`
  }

  const launcherRemote = (): ClientContext['remote']['kersor'] | undefined =>
    ctx.get('remote.kersor') as ClientContext['remote']['kersor'] | undefined

  const viewerRemote = (): ClientContext['remote']['kersorViewer'] => {
    const remote = ctx.get('remote.kersorViewer') as ClientContext['remote']['kersorViewer'] | undefined
    if (remote === undefined) throw new Error('KerSor viewer Remote is not mounted')
    return remote
  }

  const launcherHostAvailable = async (): Promise<boolean> => {
    const answered = await ctx.remote.pluginInventory.list()
    if (!answered.ok) return false
    return answered.value.entries.some(entry =>
      entry.moduleName === '@deepseek-ai/dsh-kersor'
      && entry.enabled
      && entry.fiberPhase === 'active')
  }

  const refreshViewer = async (): Promise<void> => {
    try {
      const remote = viewerRemote()
      const answered = await remote.snapshot()
      if (!answered.ok) {
        store.setTransportError(`${answered.error.code}: ${answered.error.message}`)
        return
      }
      store.setSnapshot(answered.value)
      const selected = store.selectedRunDir
      if (selected !== undefined) {
        const backlog = await remote.runBacklog(selected)
        if (!backlog.ok) {
          store.setTransportError(`${backlog.error.code}: ${backlog.error.message}`)
          return
        }
        store.setBacklog(selected, backlog.value)
      }
      const selectedClassic = store.selectedClassicSessionDir
      if (selectedClassic !== undefined) await loadClassicIfChanged(selectedClassic)
    } catch (error) {
      store.setTransportError(error instanceof Error ? error.message : String(error))
    }
  }

  const refreshLauncher = async (): Promise<void> => {
    try {
      const launcher = launcherRemote()
      if (!await launcherHostAvailable() || launcher === undefined) {
        store.setLauncherUnavailable()
        return
      }
      const [tasks, active] = await Promise.all([
        launcher.listTasks(),
        launcher.listActive(),
      ])
      if (!tasks.ok || !active.ok) {
        store.setLauncherUnavailable()
        return
      }
      store.setLauncher(tasks.value, active.value)
    } catch {
      // Optional launcher discovery must not disable the read-only viewer.
      store.setLauncherUnavailable()
    }
  }

  const loadRun = async (runDir: string): Promise<void> => {
    try {
      const remote = viewerRemote()
      const [backlog, result] = await Promise.all([
        remote.runBacklog(runDir),
        remote.runResult(runDir),
      ])
      if (!backlog.ok) {
        store.setTransportError(`${backlog.error.code}: ${backlog.error.message}`)
        return
      }
      if (!result.ok) {
        store.setTransportError(`${result.error.code}: ${result.error.message}`)
        return
      }
      store.setBacklog(runDir, backlog.value)
      store.setRunResult(runDir, result.value)
    } catch (error) {
      store.setTransportError(error instanceof Error ? error.message : String(error))
    }
  }

  const loadClassic = async (sessionDir: string): Promise<void> => {
    store.setClassicDetailLoading(sessionDir)
    try {
      const answered = await viewerRemote().classicSessionDetail(sessionDir)
      if (!answered.ok) {
        store.setClassicDetailError(sessionDir, `${answered.error.code}: ${answered.error.message}`)
        return
      }
      store.setClassicDetail(sessionDir, answered.value)
      const revision = classicRevision(sessionDir)
      if (revision !== undefined) classicDetailRevisions.set(sessionDir, revision)
    } catch (error) {
      store.setClassicDetailError(sessionDir, error instanceof Error ? error.message : String(error))
    }
  }

  const loadClassicIfChanged = async (sessionDir: string): Promise<void> => {
    const revision = classicRevision(sessionDir)
    if (revision !== undefined && classicDetailRevisions.get(sessionDir) === revision) return
    await loadClassic(sessionDir)
  }

  const loadCallDetail = async (runDir: string, callId: string): Promise<void> => {
    store.setCallDetailLoading(runDir, callId)
    try {
      const answered = await viewerRemote().runCallDetail(runDir, callId)
      if (!answered.ok) {
        store.setCallDetailError(runDir, callId, `${answered.error.code}: ${answered.error.message}`)
        return
      }
      store.setCallDetail(runDir, callId, answered.value)
    } catch (error) {
      store.setCallDetailError(runDir, callId, error instanceof Error ? error.message : String(error))
    }
  }

  const refresh = async (): Promise<void> => {
    await Promise.all([refreshViewer(), refreshLauncher()])
  }

  const start = async (taskId: KersorTaskId): Promise<void> => {
    try {
      const launcher = launcherRemote()
      if (!await launcherHostAvailable() || launcher === undefined) {
        store.setLauncherUnavailable()
        return
      }
      const answered = await launcher.start(taskId)
      if (!answered.ok) {
        store.setLauncherError(`${answered.error.code}: ${answered.error.message}`)
        return
      }
      await refreshLauncher()
      await refreshViewer()
    } catch (error) {
      store.setLauncherError(error instanceof Error ? error.message : String(error))
    }
  }

  const stop = async (runDir: string): Promise<void> => {
    try {
      const launcher = launcherRemote()
      if (!await launcherHostAvailable() || launcher === undefined) {
        store.setLauncherUnavailable()
        return
      }
      const answered = await launcher.stop(runDir)
      if (!answered.ok) {
        store.setLauncherError(`${answered.error.code}: ${answered.error.message}`)
        return
      }
      await refreshLauncher()
      await refreshViewer()
    } catch (error) {
      store.setLauncherError(error instanceof Error ? error.message : String(error))
    }
  }

  ctx.on('connection/reset', () => {
    store.reset()
    classicDetailRevisions.clear()
    void refresh()
  })
  ctx.remote.$on('kersor/event', (frame: KersorViewerFrame) => {
    store.applyFrame(frame)
    if (frame.kind === 'snapshot' && store.selectedClassicSessionDir !== undefined) {
      void loadClassicIfChanged(store.selectedClassicSessionDir)
    }
  })
  ctx.remote.$on('kersor/active', (frame: KersorActiveFrame) => {
    store.applyActiveFrame(frame)
  })
  void refresh()

  const face = { store, refresh, loadRun, loadCallDetail, loadClassic, start, stop }
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'kersor',
    order: 20,
    locale: NS,
    label: () => t('view.kersor'),
    inject: (sessionId): KersorViewFace => {
      const currentWorkspace = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
      return { ...face, ...(currentWorkspace === undefined ? {} : { currentWorkspace }) }
    },
  }, KersorView))

}
