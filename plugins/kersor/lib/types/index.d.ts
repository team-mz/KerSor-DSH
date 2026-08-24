/**
 * KerSor autonomous Mission launcher. The service starts only configured
 * Mission files through KerSor's Session-binding runner and delegates all
 * workflow-state observation to `dsh-kersor-viewer`.
 * @module @deepseek-ai/dsh-kersor
 */
export { KersorService, default } from './service.ts';
export type { Config, KersorTaskConfig } from './service.ts';
export type { KersorActiveFrame, KersorActiveLaunch, KersorExperimentCheckpointEventData, KersorExperimentId, KersorExperimentStartEventData, KersorExperimentStatus, KersorExperimentStep, KersorLaunchContract, KersorRunId, KersorTaskId, KersorTaskRef, } from './types.ts';
export { parseKersorLaunchContract } from './types.ts';
//# sourceMappingURL=index.d.ts.map