/**
 * Type face of the KerSor viewer: the wire frame and the cordis event the
 * Host half emits. Types only — no runtime code.
 * @module @deepseek-ai/dsh-kersor-viewer/types
 */

import type { KersorRunView } from './fold.ts'
import type { KersorClassicSnapshot } from './classic.ts'
import type { KersorDiagnosticIssue } from './diagnostics.ts'
import type { KersorRunRef, KersorScanObservation } from './scanner.ts'

export type {
  KersorCallActivityView,
  KersorCallDetailView,
  KersorCallMessageView,
  KersorCallUsageView,
} from './detail.ts'

// Re-exported here so every `@Remote` boundary type resolves from the public
// `./types` subpath, as the Typert generator's boundary rule requires.
export type {
  KersorCandidateResultView,
  KersorRunStatus,
  KersorCallStatus,
  KersorCallKind,
  KersorCallView,
  KersorPhaseView,
  KersorRunView,
  KersorWorkflowResultView,
} from './fold.ts'
export type {
  KersorBaselineAction,
  KersorClassicArtifact,
  KersorClassicAuthoringDetail,
  KersorClassicCycleLineage,
  KersorClassicDispatchDetail,
  KersorClassicGate,
  KersorClassicHealth,
  KersorClassicLifecycle,
  KersorClassicRound,
  KersorClassicRoundEstimate,
  KersorClassicRoundMeasurement,
  KersorClassicSelectionDetail,
  KersorClassicSession,
  KersorClassicSessionDetail,
  KersorClassicSnapshot,
  KersorClassicSource,
  KersorClassicStatus,
  KersorClassicStopReason,
  KersorClassicStep,
  KersorClassicStepId,
  KersorClassicStepStatus,
  KersorClassicValidationCheck,
  KersorClassicValidationDetail,
  KersorClassicWorkflowDesign,
} from './classic.ts'
export type { KersorDiagnosticCode, KersorDiagnosticIssue, KersorDiagnosticStage } from './diagnostics.ts'
export type {
  KersorRootObservation,
  KersorRootOrigin,
  KersorRunDiscovery,
  KersorRunKind,
  KersorRunRef,
  KersorScanObservation,
} from './scanner.ts'

/** Current ingestion state for one discovered run. */
export interface KersorRunObservation {
  readonly runDir: string
  readonly mode: 'tail' | 'backfill'
  readonly state: 'waiting' | 'healthy' | 'degraded' | 'failed' | 'complete'
  readonly byteOffset: number
  readonly linesRead: number
  readonly linesRejected: number
  readonly lastReadAt?: string
  readonly lastIssue?: KersorDiagnosticIssue
}

/** Single Host snapshot for inventory, classic Sessions, and source health. */
export interface KersorViewerSnapshot {
  readonly asOf: string
  readonly runs: readonly KersorRunRef[]
  readonly classic: KersorClassicSnapshot
  readonly diagnostics: {
    readonly scan: KersorScanObservation
    readonly runs: readonly KersorRunObservation[]
  }
}

/** Inventory or folded-run frame pushed to browser consumers. */
export type KersorViewerFrame =
  | { kind: 'snapshot'; snapshot: KersorViewerSnapshot }
  | { kind: 'run'; run: KersorRunView }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One viewer update: a replaced Host snapshot or one run's folded view.
     * @param frame - Host snapshot or folded run view model.
     * @mode emit
     */
    'kersor/event'(frame: KersorViewerFrame): void
  }
}
