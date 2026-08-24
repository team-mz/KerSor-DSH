import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import css from './KersorExperimentNode.module.css';
const STATUS_KEYS = {
    provisioning: 'experiment.status.provisioning',
    running: 'experiment.status.running',
    waiting: 'experiment.status.waiting',
    blocked: 'experiment.status.blocked',
    completed: 'experiment.status.completed',
    cancelled: 'experiment.status.cancelled',
};
/** Render one stable experiment summary and its durable child-conversation link. */
export function KersorExperimentNode({ node, openController, t }) {
    const data = node.data;
    const complete = data.steps.filter(step => step.status === 'completed').length;
    const progress = data.steps.length === 0 ? 0 : Math.round(complete * 100 / data.steps.length);
    const round = data.currentRound === undefined
        ? null
        : data.maxWorkflows === undefined
            ? t('experiment.roundOpen', { current: data.currentRound })
            : t('experiment.round', { current: data.currentRound, maximum: data.maxWorkflows });
    return (_jsxs("article", { className: css.card, "data-experiment-status": data.status, children: [_jsxs("header", { className: css.header, children: [_jsxs("div", { children: [_jsx("div", { className: css.eyebrow, children: t('experiment.title') }), _jsx("div", { className: css.title, children: data.kersorSessionId ?? data.experimentId })] }), _jsx("span", { className: css.status, children: t(STATUS_KEYS[data.status]) })] }), _jsx("p", { className: css.objective, children: data.objective }), _jsxs("div", { className: css.facts, children: [data.phase === undefined ? null : _jsx("span", { children: t('experiment.phase', { phase: data.phase }) }), round === null ? null : _jsx("span", { children: round }), data.workflow === undefined ? null : _jsx("span", { children: t('experiment.workflow', { workflow: data.workflow }) }), data.bestSpeedup === undefined ? null : _jsx("span", { children: t('experiment.best', { speedup: data.bestSpeedup }) })] }), data.steps.length === 0 ? null : (_jsxs("div", { className: css.progress, children: [_jsx("div", { className: css.progressTrack, "aria-label": t('experiment.progress', { progress }), children: _jsx("span", { style: { width: `${progress}%` } }) }), _jsx("ol", { className: css.steps, children: data.steps.map(step => (_jsxs("li", { "data-step-status": step.status, children: [_jsx("span", { className: css.dot }), _jsx("span", { children: t(`detail.step.${step.id}`) })] }, step.id))) })] })), data.nextAction === undefined ? null : (_jsxs("p", { className: css.next, children: [_jsx("strong", { children: t('experiment.next') }), " ", data.nextAction] })), _jsxs("footer", { className: css.footer, children: [_jsx("button", { type: "button", className: css.open, disabled: data.status === 'provisioning', onClick: () => { openController(data.childSessionId); }, children: t('experiment.openController') }), _jsx("code", { children: data.childSessionId })] })] }));
}
//# sourceMappingURL=KersorExperimentNode.js.map