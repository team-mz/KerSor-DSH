/**
 * Client-safe KerSor launcher types: configured task identities, active
 * process receipts, and the forwarded active-launch frame.
 * @module @deepseek-ai/dsh-kersor/types
 */
import type { Branded } from '@deepseek-ai/dsh-brand';
import type { CallId } from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
/** Opaque identity of one Mission registered in the plugin config. */
export type KersorTaskId = Branded<'KersorTaskId'>;
/** Opaque KerSor autonomous run identity generated for one launch. */
export type KersorRunId = Branded<'KersorRunId'>;
/** Stable identity of one KerSor experiment bound to a dsh conversation. */
export type KersorExperimentId = Branded<'KersorExperimentId'>;
/** Immutable typed launch inputs for one KerSor experiment. */
export interface KersorLaunchContract {
    readonly backend: 'cuda' | 'rocm' | 'triton' | 'python' | 'metal' | 'metax' | 'ascend' | 'sycl';
    readonly language: 'cuda' | 'rocm' | 'triton' | 'python_reference' | 'metal' | 'metax' | 'ascendc' | 'sycl' | 'cutlass';
    readonly integration_pattern: string;
    readonly target_speedup: number;
    readonly max_workflows: number;
    readonly mode: 'auto' | 'guided' | 'explore';
    readonly workflow_authoring_budget: number;
    readonly retrieval_mode: 'on' | 'off';
    readonly transfer_mode: 'full' | 'measured-only' | 'off';
    readonly experience_mode: 'on' | 'off';
    readonly kernelwiki_experience_export_mode: 'on' | 'off';
    readonly correctness_command: string;
    readonly benchmark_command: string;
}
/**
 * Serialize a lossless JSON value with recursively sorted object keys.
 * Arrays retain their source order. Host authority hashes use these exact UTF-8
 * bytes so producers and invariant replay cannot diverge on property insertion
 * order.
 * @param value - Lossless JSON value to serialize canonically.
 * @returns Canonical JSON text with recursively sorted object keys.
 */
export declare function canonicalKersorJson(value: unknown): string;
/**
 * Validate and copy one launch contract into canonical field order.
 * @param value - candidate plain JSON value.
 * @param label - error-path prefix.
 * @returns the validated contract without normalizing strings or numbers.
 */
export declare function parseKersorLaunchContract(value: unknown, label?: string): KersorLaunchContract;
/** Durable lifecycle projected into the owning dsh conversation. */
export type KersorExperimentStatus = 'provisioning' | 'running' | 'waiting' | 'blocked' | 'completed' | 'cancelled';
/** One artifact-derived KerSor stage rendered in the conversation. */
export interface KersorExperimentStep {
    readonly id: string;
    readonly status: 'pending' | 'active' | 'completed' | 'failed';
}
/** Immutable start of one conversation-owned KerSor experiment. */
export interface KersorExperimentStartEventData {
    readonly experimentId: KersorExperimentId;
    readonly childSessionId: SessionId;
    readonly origin: 'created' | 'attached';
    readonly objective: string;
    readonly freshSession: boolean;
    /** Immutable typed launch authority for every created or attached binding. */
    readonly launch: KersorLaunchContract;
    /** Durable parent Session containing the created origin for an attached binding. */
    readonly originSessionId?: SessionId;
    /** Crash-recoverable source authority reserved before an attached child exists. */
    readonly authorityIntent?: KersorSessionAuthorityIntent;
    readonly turn: number;
    readonly step: number;
}
/** Durable parent-side reservation used to complete an attached authority transfer. */
export interface KersorSessionAuthorityIntent {
    readonly attach_call_id: string;
    readonly workspace: string;
    readonly session_dir: string;
    readonly source_parent_session_id: SessionId;
    readonly source_controller_session_id: SessionId;
    readonly pre_transfer_event_watermark: number;
    readonly pre_transfer_event_sha256: string;
    readonly source_setup_receipt: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly source_state: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly source_workflow_catalog: {
        readonly path: string;
        readonly sha256: string;
    };
}
/** Replayable latest-value checkpoint for one conversation-owned experiment. */
export interface KersorExperimentCheckpointEventData {
    readonly experimentId: KersorExperimentId;
    readonly childSessionId: SessionId;
    /** Monotonic latest-value revision within this experiment. */
    readonly revision: number;
    readonly status: KersorExperimentStatus;
    readonly kersorSessionId?: string;
    readonly phase?: string;
    readonly currentRound?: number;
    readonly maxWorkflows?: number;
    readonly workflow?: string;
    readonly bestSpeedup?: number;
    readonly targetSpeedup?: number;
    readonly nextAction?: string;
    readonly steps: readonly KersorExperimentStep[];
}
/** Host-sealed receipt for one fresh KerSor Session setup boundary. */
export interface KersorSessionInitializedEventData {
    readonly schema_version: 1;
    readonly contract: 'dsh_session_initialization_v1';
    readonly authority: 'dsh_host';
    readonly experiment_id: KersorExperimentId;
    readonly workspace: string;
    readonly session_dir: string;
    readonly controller_session_id: SessionId;
    readonly setup_call_id: string;
    readonly setup_command: string;
    readonly kersor_python: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly launch: KersorLaunchContract;
    readonly session_config: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly state: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly workflow_catalog: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly adapter: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly kernel: {
        readonly path: string;
        readonly sha256: string;
    };
}
/** Host-sealed transfer that permanently retires a created source controller. */
export interface KersorSessionAuthorityTransferredEventData {
    readonly schema_version: 1;
    readonly contract: 'dsh_session_authority_transfer_v1';
    readonly authority: 'dsh_host';
    readonly experiment_id: KersorExperimentId;
    readonly workspace: string;
    readonly session_dir: string;
    readonly source_parent_session_id: SessionId;
    readonly source_controller_session_id: SessionId;
    readonly target_parent_session_id: SessionId;
    readonly target_controller_session_id: SessionId;
    readonly attach_call_id: string;
    readonly launch: KersorLaunchContract;
    readonly pre_transfer_event_watermark: number;
    readonly pre_transfer_event_sha256: string;
    readonly source_setup_receipt: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly source_state: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly source_workflow_catalog: {
        readonly path: string;
        readonly sha256: string;
    };
}
/** Host-sealed import of an existing Session's setup authority into one attached controller. */
export interface KersorSessionAuthorityImportedEventData {
    readonly schema_version: 1;
    readonly contract: 'dsh_session_authority_import_v1';
    readonly authority: 'dsh_host';
    readonly experiment_id: KersorExperimentId;
    readonly workspace: string;
    readonly session_dir: string;
    readonly controller_session_id: SessionId;
    readonly attached_parent_session_id: SessionId;
    readonly attach_call_id: string;
    readonly launch: KersorLaunchContract;
    readonly source_parent_session_id: SessionId;
    readonly source_controller_session_id: SessionId;
    readonly source_event_watermark: number;
    readonly source_event_sha256: string;
    readonly source_setup_receipt: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly source_transfer_receipt: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly source_state: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly source_workflow_catalog: {
        readonly path: string;
        readonly sha256: string;
    };
}
/** Host binding from one author protocol call to its completed foreground child. */
export interface KersorAuthorProducedEventData {
    readonly schema_version: 1;
    readonly contract: 'dsh_author_producer_v1';
    readonly authority: 'dsh_host';
    readonly session_dir: string;
    readonly controller_session_id: SessionId;
    readonly author_call_id: CallId;
    readonly author_session_id: SessionId;
    readonly author_context: {
        readonly path: string;
        readonly sha256: string;
    };
}
/** Host seal of the opaque KerSor Core handoff receipt. */
export interface KersorAuthorHandoffSealedEventData {
    readonly schema_version: 1;
    readonly contract: 'dsh_author_handoff_seal_v2';
    readonly authority: 'dsh_host';
    readonly session_dir: string;
    readonly controller_session_id: SessionId;
    readonly author_call_id: CallId;
    readonly author_session_id: SessionId;
    readonly seal_call_id: CallId;
    readonly handoff: {
        readonly path: string;
        readonly sha256: string;
    };
}
/** Durable pre-execution consumption of the sole canonical authored Proposal save. */
export interface KersorAuthorSaveAttemptedEventData {
    readonly schema_version: 1;
    readonly contract: 'dsh_author_save_attempt_v2';
    readonly authority: 'dsh_host';
    readonly session_dir: string;
    readonly controller_session_id: SessionId;
    readonly save_call_id: CallId;
    readonly seal_call_id: CallId;
    readonly handoff: {
        readonly path: string;
        readonly sha256: string;
    };
}
/** One Host-minted binding from a foreground dispatch synthesizer to its exact bytes. */
export interface KersorDispatchArgsProducedEventData {
    readonly schema_version: 1;
    readonly contract: 'dsh_dispatch_args_producer_v1';
    readonly authority: 'dsh_host';
    readonly session_dir: string;
    readonly run_dir: string;
    readonly round: number;
    readonly workflow_name: string;
    readonly controller_session_id: string;
    readonly producer_session_id: string;
    readonly producer_call_id: string;
    readonly dispatch_args: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly dispatch_args_provenance: {
        readonly path: string;
        readonly sha256: string;
    };
}
/** Host-minted second custody link for the producer-triggered runtime-control pass. */
export interface KersorDispatchArgsTransformedEventData {
    readonly schema_version: 1;
    readonly contract: 'dsh_dispatch_args_transformation_v1';
    readonly authority: 'dsh_host';
    readonly transformer: 'inject-runtime-controls';
    readonly session_dir: string;
    readonly run_dir: string;
    readonly round: number;
    readonly workflow_name: string;
    readonly controller_session_id: string;
    /** Producer call whose durable success triggered the Host-owned transformation. */
    readonly transformation_call_id: string;
    readonly producer_receipt: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly input: {
        readonly dispatch_args: {
            readonly path: string;
            readonly sha256: string;
        };
        readonly dispatch_args_provenance: {
            readonly path: string;
            readonly sha256: string;
        };
    };
    readonly output: {
        readonly dispatch_args: {
            readonly path: string;
            readonly sha256: string;
        };
        readonly dispatch_args_provenance: {
            readonly path: string;
            readonly sha256: string;
        };
    };
    readonly changed: boolean;
    readonly authorized_fields: {
        readonly dispatch_args: readonly string[];
        readonly dispatch_args_provenance: readonly string[];
    };
}
/** Host authority for one exact canonical candidate-ownership seal call and file. */
export interface KersorCandidateOwnershipSealedEventData {
    readonly schema_version: 1;
    readonly contract: 'dsh_candidate_ownership_seal_v1';
    readonly authority: 'dsh_host';
    readonly session_dir: string;
    readonly run_dir: string;
    readonly round: number;
    readonly controller_session_id: string;
    readonly seal_call_id: string;
    readonly seal: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly state: {
        readonly path: string;
        readonly sha256: string;
    };
}
/** One bounded execution summary independently validated and sealed by the Host. */
export interface KersorBaselineExecutionEventData {
    readonly kind: 'correctness' | 'benchmark';
    readonly command: string;
    readonly exit_code: number;
    readonly timed_out: boolean;
    readonly stdout_sha256: string;
    readonly stderr_sha256: string;
}
interface KersorBaselineAuthorityEventData {
    readonly schema_version: 1;
    readonly authority: 'dsh_host';
    readonly launch: KersorLaunchContract;
    readonly workspace: string;
    readonly session_dir: string;
    readonly controller_session_id: string;
    readonly call_id: string;
    readonly session_config: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly task_dir: string;
    readonly kernel: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly test_method: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly commands: {
        readonly correctness: string;
        readonly benchmark: string;
    };
}
/** Host authority for the exact typed-launch baseline initializer call. */
export interface KersorBaselineInitializedEventData extends KersorBaselineAuthorityEventData {
    readonly contract: 'dsh_baseline_initialized_v1';
}
/** Host authority for the exact baseline recorder call and its execution witness. */
export interface KersorBaselineRecordedEventData extends KersorBaselineAuthorityEventData {
    readonly contract: 'dsh_baseline_recorded_v1';
    readonly initialization_receipt: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly witness: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly executions: readonly KersorBaselineExecutionEventData[];
}
/** Host authority for the exact final baseline verifier call and current bytes. */
export interface KersorBaselineVerifiedEventData extends KersorBaselineAuthorityEventData {
    readonly contract: 'dsh_baseline_verified_v1';
    readonly recording_receipt: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly witness: {
        readonly path: string;
        readonly sha256: string;
    };
    readonly executions: readonly KersorBaselineExecutionEventData[];
    readonly protected_files: Readonly<Record<string, string>>;
    readonly worktree: Readonly<Record<string, unknown>>;
    readonly verdict: 'pass';
}
/** Browser-safe description of one configured Mission. */
export interface KersorTaskRef {
    readonly id: KersorTaskId;
    readonly label: string;
}
/** One launcher process that dsh still owns. */
export interface KersorActiveLaunch {
    readonly taskId: KersorTaskId;
    readonly runId: KersorRunId;
    readonly runDir: string;
    readonly startedTs: string;
    readonly pid: number;
}
/** Replaced active-launch inventory pushed to browser consumers. */
export interface KersorActiveFrame {
    readonly kind: 'active';
    readonly launches: KersorActiveLaunch[];
}
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * Current KerSor processes owned by the launcher.
         * @param frame - complete replacement of the active-launch inventory.
         * @mode emit
         */
        'kersor/active'(frame: KersorActiveFrame): void;
    }
}
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        /**
         * Binds one KerSor experiment and its continuable dsh child to this
         * conversation before child materialization begins.
         * @param data - stable identities, frozen request, and Chat location.
         */
        'kersor/experiment-start': KersorExperimentStartEventData;
        /**
         * Replaces the visible lifecycle projection for one earlier experiment
         * binding. Revisions increase by one and remain a projection of KerSor's
         * canonical files rather than a second experiment state authority.
         * @param data - latest controller-owned checkpoint for the experiment.
         */
        'kersor/experiment-checkpoint': KersorExperimentCheckpointEventData;
        /** Durable Host authority for one freshly initialized KerSor Session. */
        'kersor/session-initialized': KersorSessionInitializedEventData;
        /** Durable Host retirement of a created controller before attached import. */
        'kersor/session-authority-transferred': KersorSessionAuthorityTransferredEventData;
        /** Durable Host authority imported into one attached controller. */
        'kersor/session-authority-imported': KersorSessionAuthorityImportedEventData;
        /** Host binding from one author protocol call to its foreground child. */
        'kersor/author-produced': KersorAuthorProducedEventData;
        /** Host seal of the opaque KerSor Core handoff receipt. */
        'kersor/author-handoff-sealed': KersorAuthorHandoffSealedEventData;
        /** Durable consumption of the sole canonical authored Proposal save attempt. */
        'kersor/author-save-attempted': KersorAuthorSaveAttemptedEventData;
        /** Durable Host authority for one exact foreground dispatch producer. */
        'kersor/dispatch-args-produced': KersorDispatchArgsProducedEventData;
        /** Durable Host authority for one deterministic post-producer transform. */
        'kersor/dispatch-args-transformed': KersorDispatchArgsTransformedEventData;
        /** Durable Host authority for one canonical candidate-ownership seal. */
        'kersor/candidate-ownership-sealed': KersorCandidateOwnershipSealedEventData;
        /** Durable Host authority for one exact typed-launch baseline initializer. */
        'kersor/baseline-initialized': KersorBaselineInitializedEventData;
        /** Durable Host authority for one exact baseline execution recorder. */
        'kersor/baseline-recorded': KersorBaselineRecordedEventData;
        /** Durable Host authority for one exact baseline verification boundary. */
        'kersor/baseline-verified': KersorBaselineVerifiedEventData;
    }
}
export {};
//# sourceMappingURL=types.d.ts.map