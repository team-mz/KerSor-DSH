/** KerSor conversation view: Session inventory with live Workflow progress. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { KersorViewFace } from './slots.ts';
/** Full view props composed by the conversation view slot. */
export type KersorViewProps = PropsRuntime<'conversation.view'> & InjectFace<KersorViewFace> & PropsLocale<'kersorViewer'>;
/** First-class KerSor view rendered beside Chat and Trajectory. */
export declare function KersorView({ t, store, currentWorkspace, refresh, loadRun, loadCallDetail, loadClassic, start, stop, }: KersorViewProps): React.JSX.Element;
//# sourceMappingURL=KersorView.d.ts.map