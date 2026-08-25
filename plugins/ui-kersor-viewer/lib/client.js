window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-kersor-viewer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region lib/types/client/readiness.js
		/** Terminal-aware presentation policy for a Session's historical fit verdict. */
		/**
		* Apply the rule that a terminal veto outranks any earlier fit result.
		* @param session - Session whose lifecycle and historical confidence are projected.
		* @returns Visible confidence, or `undefined` when terminal ownership suppresses it.
		*/
		function visibleFitConfidence(session) {
			if (session.lifecycle === "stalled" || session.lifecycle === "cancelled") return void 0;
			return session.fit_confidence ?? void 0;
		}
		//#endregion
		//#region \0dsh-css:64557083eb0f58b9.mjs
		const css$1 = ".eIdKYq_view{box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);width:100%;height:100%;min-height:0;color:var(--dsw-alias-label-tertiary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);flex-direction:column;display:flex;overflow:hidden}.eIdKYq_header{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);flex:none;justify-content:space-between;align-items:center;gap:8px;min-height:44px;padding:10px 12px;display:flex}.eIdKYq_title{color:var(--dsw-alias-label-primary);flex:none;font-size:13px;font-weight:500;line-height:20px}.eIdKYq_note,.eIdKYq_readError{color:var(--dsw-alias-label-tertiary);margin:4px 0;font-size:12px;line-height:18px}.eIdKYq_note{text-align:right;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.eIdKYq_followButton{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);height:26px;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:7px;flex:none;padding:0 10px;font-family:inherit;font-size:11px}.eIdKYq_followButton:hover{background:var(--dsw-alias-bg-hover-secondary)}.eIdKYq_readError{color:var(--dsw-alias-state-error-primary)}.eIdKYq_body{min-height:0;padding:4px 12px;padding-bottom:calc(var(--dsh-composer-height,152px) + 24px);flex:1;overflow-y:auto}.eIdKYq_launcher{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);border-radius:12px;flex-direction:column;gap:8px;margin:4px 0 10px;padding:10px 12px;display:flex}.eIdKYq_launcherHead,.eIdKYq_taskRow,.eIdKYq_activeRow{align-items:center;gap:8px;display:flex}.eIdKYq_launcherHead{justify-content:space-between}.eIdKYq_launcherTitle,.eIdKYq_taskLabel{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:510;line-height:18px}.eIdKYq_launcherSummary,.eIdKYq_activeRunId{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.eIdKYq_taskList,.eIdKYq_activeList{flex-direction:column;gap:4px;display:flex}.eIdKYq_taskRow,.eIdKYq_activeRow{min-height:28px}.eIdKYq_taskLabel,.eIdKYq_activeLabel{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;overflow:hidden}.eIdKYq_activeLabel{color:var(--dsw-alias-label-secondary);flex-direction:column;font-size:12px;line-height:16px;display:flex}.eIdKYq_activeRunId{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.eIdKYq_controlButton{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);min-width:52px;height:26px;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:7px;flex:none;padding:0 10px;font-family:inherit;font-size:11px}.eIdKYq_controlButton:hover:not(:disabled){background:var(--dsw-alias-bg-hover-secondary)}.eIdKYq_controlButton:disabled{cursor:default;opacity:.55}.eIdKYq_controlButton[data-busy=true]{color:var(--dsw-alias-state-business-primary)}.eIdKYq_activitySection{flex-direction:column;gap:6px;margin-top:8px;display:flex}.eIdKYq_sectionHead,.eIdKYq_classicHead,.eIdKYq_classicFoot{align-items:center;gap:8px;display:flex}.eIdKYq_sectionHead{justify-content:space-between;min-height:24px;padding:0 2px}.eIdKYq_sectionTitle{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:510;line-height:18px}.eIdKYq_sectionSummary{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.eIdKYq_classicRows{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0;padding:0;list-style:none;display:grid}.eIdKYq_classicRow{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);border-radius:10px;flex-direction:column;gap:6px;min-width:0;padding:10px;display:flex}.eIdKYq_classicRow[data-session-health=active]{border-color:var(--dsw-alias-state-business-primary)}.eIdKYq_classicRow[data-session-health=stale],.eIdKYq_classicRow[data-session-health=needs_resume],.eIdKYq_classicRow[data-session-health=unknown]{border-color:var(--dsw-alias-state-warn-secondary)}.eIdKYq_classicRow[data-expanded=true]{grid-column:1/-1}.eIdKYq_classicHead{min-width:0}.eIdKYq_classicExpand{width:20px;height:20px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;border-radius:5px;flex:none;justify-content:center;align-items:center;padding:0;transition:transform .12s,background .12s;display:inline-flex}.eIdKYq_classicExpand:hover{background:var(--dsw-alias-bg-base)}.eIdKYq_classicExpand[aria-expanded=true]{transform:rotate(90deg)}.eIdKYq_sessionId{min-width:0;color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-weight:510;line-height:16px;overflow:hidden}.eIdKYq_phaseBadge{background:var(--dsw-alias-bg-base);max-width:42%;color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;border-radius:5px;flex:none;padding:1px 5px;font-size:10px;line-height:15px;overflow:hidden}.eIdKYq_workspaceBadge,.eIdKYq_selectedBadge{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-state-warn-label);white-space:nowrap;border-radius:5px;flex:none;padding:1px 5px;font-size:10px;line-height:15px}.eIdKYq_selectedBadge{color:var(--dsw-alias-state-business-primary)}.eIdKYq_classicMetrics{color:var(--dsw-alias-label-tertiary);flex-wrap:wrap;gap:2px 8px;font-size:10px;line-height:15px;display:flex}.eIdKYq_classicMetrics [data-target-met=true]{color:var(--dsw-alias-state-success-primary)}.eIdKYq_routeBadge,.eIdKYq_authoringBadge,.eIdKYq_gateBadge{background:var(--dsw-alias-bg-base);border-radius:5px;padding:0 5px}.eIdKYq_routeBadge{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.eIdKYq_authoringBadge{color:var(--dsw-alias-state-business-primary)}.eIdKYq_gateBadge[data-gate=pass]{color:var(--dsw-alias-state-success-primary)}.eIdKYq_gateBadge[data-gate=fail]{color:var(--dsw-alias-state-error-primary)}.eIdKYq_gateBadge[data-gate=pending]{color:var(--dsw-alias-state-warn-label)}.eIdKYq_baselineAction{border-left:2px solid var(--dsw-alias-state-warn-label);background:var(--dsw-alias-bg-base);border-radius:5px;flex-direction:column;gap:1px;padding:4px 7px;font-size:10px;line-height:15px;display:flex}.eIdKYq_baselineAction[data-baseline-action=new_session]{border-left-color:var(--dsw-alias-state-error-primary)}.eIdKYq_baselineActionLabel{color:var(--dsw-alias-label-secondary);font-weight:510}.eIdKYq_baselineAction[data-baseline-action=new_session] .eIdKYq_baselineActionLabel{color:var(--dsw-alias-state-error-primary)}.eIdKYq_baselineActionReason{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;-webkit-line-clamp:2;-webkit-box-orient:vertical;display:-webkit-box;overflow:hidden}.eIdKYq_profileBlock{border-left:2px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-base);border-radius:5px;flex-direction:column;gap:1px;padding:4px 7px;font-size:10px;line-height:15px;display:flex}.eIdKYq_profileBlockLabel{color:var(--dsw-alias-state-error-primary);font-weight:510}.eIdKYq_profileBlockReason{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;-webkit-line-clamp:2;-webkit-box-orient:vertical;display:-webkit-box;overflow:hidden}.eIdKYq_classicFoot{min-width:0;color:var(--dsw-alias-label-secondary);justify-content:space-between;font-size:10px;line-height:15px}.eIdKYq_workflowName{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;overflow:hidden}.eIdKYq_fitBadge{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);border-radius:5px;flex:none;padding:0 5px}.eIdKYq_fitBadge[data-fit-confidence=high]{color:var(--dsw-alias-state-success-primary)}.eIdKYq_fitBadge[data-fit-confidence=low]{color:var(--dsw-alias-state-warn-label)}.eIdKYq_warningCount{color:var(--dsw-alias-state-warn-label);cursor:help;flex:none}.eIdKYq_decisionReason{border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;-webkit-line-clamp:2;-webkit-box-orient:vertical;padding-top:5px;font-size:10px;line-height:15px;display:-webkit-box;overflow:hidden}.eIdKYq_classicDetail{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:10px;padding-top:8px;display:flex}.eIdKYq_outcomeSummary,.eIdKYq_roundHistory{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);border-radius:9px;flex-direction:column;gap:7px;padding:10px;display:flex}.eIdKYq_outcomeSummary[data-stop-reason=target_met]{border-color:var(--dsw-alias-state-success-primary)}.eIdKYq_outcomeSummary[data-stop-reason=execution_budget_exhausted],.eIdKYq_outcomeSummary[data-stop-reason=selection_stalled],.eIdKYq_outcomeSummary[data-stop-reason=authoring_budget_exhausted]{border-color:var(--dsw-alias-state-warn-secondary)}.eIdKYq_outcomeHead,.eIdKYq_outcomeMetrics,.eIdKYq_roundHead,.eIdKYq_roundFacts,.eIdKYq_stopNode{align-items:center;gap:6px 10px;display:flex}.eIdKYq_outcomeHead{color:var(--dsw-alias-label-secondary);justify-content:space-between;font-size:11px;line-height:16px}.eIdKYq_outcomeMetrics,.eIdKYq_roundFacts{color:var(--dsw-alias-label-tertiary);flex-wrap:wrap;font-size:11px;line-height:16px}.eIdKYq_outcomeMetrics>strong{color:var(--dsw-alias-label-primary)}.eIdKYq_roundTree{flex-direction:column;gap:0;margin:0;padding:0;list-style:none;display:flex}.eIdKYq_roundNode,.eIdKYq_stopNode{border-left:1px solid var(--dsw-alias-border-l1);margin-left:5px;padding:8px 8px 8px 20px;position:relative}.eIdKYq_roundNode:before,.eIdKYq_stopNode:before{border-top:1px solid var(--dsw-alias-border-l1);content:\"\";width:12px;position:absolute;top:16px;left:0}.eIdKYq_roundNode[data-host-verdict=fail]{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 4%, transparent)}.eIdKYq_roundHead{min-width:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}.eIdKYq_roundHead>strong{color:var(--dsw-alias-label-primary);flex:none}.eIdKYq_roundWorkflow{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden}.eIdKYq_roundVerdict,.eIdKYq_authoredBadge,.eIdKYq_promotedBadge,.eIdKYq_failureBadge,.eIdKYq_excludedBadge{background:var(--dsw-alias-bg-module-platform);white-space:nowrap;border-radius:5px;flex:none;padding:1px 5px}.eIdKYq_roundNode[data-host-verdict=pass] .eIdKYq_roundVerdict,.eIdKYq_promotedBadge,.eIdKYq_roundFacts [data-measurement=measured]{color:var(--dsw-alias-state-success-primary)}.eIdKYq_roundNode[data-host-verdict=fail] .eIdKYq_roundVerdict,.eIdKYq_failureBadge{color:var(--dsw-alias-state-error-primary)}.eIdKYq_authoredBadge{color:var(--dsw-alias-state-business-primary)}.eIdKYq_excludedBadge,.eIdKYq_roundFacts [data-measurement=estimated]{color:var(--dsw-alias-state-warn-label)}.eIdKYq_authoringChain,.eIdKYq_roundDecision{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;margin:5px 0 0 20px;font-size:10px;line-height:15px}.eIdKYq_authoringChain{border-left:2px solid var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);padding-left:7px}.eIdKYq_stopNode{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}.eIdKYq_timeline{grid-template-columns:repeat(3,minmax(0,1fr));gap:4px 8px;margin:0;padding:0;list-style:none;display:grid}.eIdKYq_timelineStep{min-width:0;color:var(--dsw-alias-label-tertiary);align-items:center;gap:5px;font-size:10px;line-height:15px;display:flex}.eIdKYq_timelineStep[data-step-status=active]{color:var(--dsw-alias-state-business-primary)}.eIdKYq_timelineStep[data-step-status=failed]{color:var(--dsw-alias-state-error-primary)}.eIdKYq_detailGrid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;display:grid}.eIdKYq_detailSection{background:var(--dsw-alias-bg-base);min-width:0;color:var(--dsw-alias-label-tertiary);border-radius:8px;flex-direction:column;gap:3px;padding:8px;font-size:10px;line-height:15px;display:flex}.eIdKYq_detailTitle{color:var(--dsw-alias-label-primary);font-weight:510}.eIdKYq_detailReason,.eIdKYq_detailPath{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.eIdKYq_detailPath{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.eIdKYq_detailNote,.eIdKYq_detailError{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px}.eIdKYq_detailError{color:var(--dsw-alias-state-error-primary)}.eIdKYq_mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.eIdKYq_checks{flex-wrap:wrap;gap:2px 8px;margin:0;padding:0;list-style:none;display:flex}.eIdKYq_checks [data-check-passed=true]{color:var(--dsw-alias-state-success-primary)}.eIdKYq_checks [data-check-passed=false]{color:var(--dsw-alias-state-error-primary)}.eIdKYq_artifacts{color:var(--dsw-alias-label-tertiary);flex-direction:column;gap:2px;font-size:10px;line-height:15px;display:flex}.eIdKYq_design{flex-direction:column;gap:6px;display:flex}.eIdKYq_designText{color:var(--dsw-alias-label-secondary);margin:0;font-size:10px;line-height:16px}.eIdKYq_workflowTree{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);border-radius:8px;padding:8px}.eIdKYq_workflowRoot,.eIdKYq_workflowPhase{min-width:0;color:var(--dsw-alias-label-primary);align-items:flex-start;gap:6px;font-size:10px;line-height:15px;display:flex}.eIdKYq_workflowRoot{align-items:center;font-weight:510}.eIdKYq_workflowBranches{flex-direction:column;gap:5px;padding-top:5px;padding-left:12px;display:flex}.eIdKYq_workflowBranch{width:10px;color:var(--dsw-alias-label-quaternary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.eIdKYq_workflowPhaseIndex{background:var(--dsw-alias-bg-layer-1);width:16px;height:16px;color:var(--dsw-alias-state-business-primary);border-radius:50%;flex:none;justify-content:center;align-items:center;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;display:inline-flex}.eIdKYq_workflowPhaseBody{min-width:0;color:var(--dsw-alias-label-tertiary);flex-direction:column;gap:1px;display:flex}.eIdKYq_workflowPhaseBody strong{color:var(--dsw-alias-label-primary);font-weight:510}.eIdKYq_designMeta{flex-wrap:wrap;gap:4px;display:flex}.eIdKYq_designMeta>span{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);border-radius:5px;padding:1px 5px;font-size:10px;line-height:15px}.eIdKYq_requiredArgs{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px}.eIdKYq_designDisclosure{background:var(--dsw-alias-bg-base);border-radius:8px}.eIdKYq_designDisclosure>summary{color:var(--dsw-alias-label-secondary);cursor:pointer;padding:7px 8px;font-size:10px;line-height:15px}.eIdKYq_designDisclosure>pre{border-top:1px solid var(--dsw-alias-border-l2);max-height:320px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;margin:0;padding:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9px;line-height:14px;overflow:auto}@media (width<=520px){.eIdKYq_classicRows,.eIdKYq_timeline,.eIdKYq_detailGrid{grid-template-columns:1fr}}.eIdKYq_rows{flex-direction:column;gap:8px;margin:0;padding:0;list-style:none;display:flex}.eIdKYq_row{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);border-radius:12px;flex-direction:column;gap:6px;padding:10px 12px;display:flex}.eIdKYq_row[data-run-status=active]{border-color:var(--dsw-alias-state-business-primary)}.eIdKYq_rowHead{width:100%;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:8px;align-items:center;gap:8px;padding:2px;font-family:inherit;display:flex}.eIdKYq_rowHead:hover{background:var(--dsw-alias-bg-hover-secondary)}.eIdKYq_rowHead[aria-pressed=true]{background:var(--dsw-alias-bg-active-secondary)}.eIdKYq_runId{max-width:20%;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:none;font-size:10px;line-height:16px;overflow:hidden}.eIdKYq_rowLabel{min-width:0;color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:12px;font-weight:510;line-height:18px;overflow:hidden}.eIdKYq_runDetail{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:4px;padding:4px 2px 2px;display:flex}.eIdKYq_runHead{justify-content:space-between;align-items:center;gap:8px;display:flex}.eIdKYq_workflowIdentity{min-width:0;color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:13px;font-weight:510;line-height:20px;overflow:hidden}.eIdKYq_statusTail{height:20px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none;align-items:center;gap:4px;font-size:11px;font-weight:510;line-height:16px;display:inline-flex;overflow:hidden}.eIdKYq_runMeta{color:var(--dsw-alias-label-tertiary);flex-wrap:wrap;gap:4px 12px;font-size:11px;line-height:16px;display:flex}.eIdKYq_runError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}.eIdKYq_executionTree,.eIdKYq_treeGroup{margin:0;padding:0;list-style:none}.eIdKYq_executionTree{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);border-radius:10px;margin-top:6px;padding:9px}.eIdKYq_treeGroup{border-left:1px solid var(--dsw-alias-border-l1);margin-left:6px;padding-left:20px}.eIdKYq_treeGroup>li{margin-top:3px;position:relative}.eIdKYq_treeGroup>li:before{background:var(--dsw-alias-border-l1);content:\"\";width:15px;height:1px;position:absolute;top:15px;left:-20px}.eIdKYq_treeNode,.eIdKYq_treeNodeButton,.eIdKYq_hostStep{min-width:0;min-height:30px;color:var(--dsw-alias-label-secondary);align-items:center;gap:7px;font-size:11px;line-height:16px;display:flex}.eIdKYq_treeNode>span:nth-child(2),.eIdKYq_treeNodeButton>.eIdKYq_callLabel{color:var(--dsw-alias-label-primary);font-weight:510}.eIdKYq_treeNode>span:last-child{color:var(--dsw-alias-label-tertiary);margin-left:auto}.eIdKYq_treeNodeButton{text-align:left;cursor:pointer;background:0 0;border:0;border-radius:6px;width:100%;padding:2px 4px;font-family:inherit}.eIdKYq_treeNodeButton:hover{background:var(--dsw-alias-bg-hover-secondary)}.eIdKYq_treeNodeButton>svg:last-child{flex:none;transition:transform .12s}.eIdKYq_callTreeItem[aria-expanded=true]>.eIdKYq_treeNodeButton>svg:last-child{transform:rotate(90deg)}.eIdKYq_phaseTreeItem[data-parallel=true]>.eIdKYq_treeNode{background:var(--dsw-alias-bg-base);border-radius:6px}.eIdKYq_phaseTreeItem[data-phase-status=failed]>.eIdKYq_treeNode,.eIdKYq_callTreeItem[data-call-status=failed]>.eIdKYq_treeNodeButton,.eIdKYq_hostTreeItem[data-step-status=failed]>.eIdKYq_treeNode{color:var(--dsw-alias-state-error-primary)}.eIdKYq_hostTreeItem>.eIdKYq_treeNode{border-top:1px solid var(--dsw-alias-border-l2);margin-top:6px;padding-top:5px}.eIdKYq_hostStep>span:last-child{color:var(--dsw-alias-label-tertiary);margin-left:auto}.eIdKYq_callDetail{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);border-radius:8px;flex-direction:column;gap:7px;margin:3px 0 7px;padding:8px;display:flex}.eIdKYq_callDetailMeta{color:var(--dsw-alias-label-tertiary);flex-wrap:wrap;gap:4px 10px;font-size:10px;line-height:15px;display:flex}.eIdKYq_callMessages{flex-direction:column;gap:5px;display:flex}.eIdKYq_callMessages>pre{background:var(--dsw-alias-bg-module-platform);max-height:260px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;border-radius:6px;margin:0;padding:7px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;line-height:15px;overflow:auto}.eIdKYq_callActivities{flex-direction:column;gap:3px;margin:0;padding:0;list-style:none;display:flex}.eIdKYq_callActivities>li{color:var(--dsw-alias-label-tertiary);grid-template-columns:auto minmax(0,1fr) auto;gap:7px;font-size:10px;line-height:15px;display:grid}.eIdKYq_callActivities .eIdKYq_mono{color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.eIdKYq_workflowResult{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);border-radius:10px;flex-direction:column;gap:8px;margin-top:4px;padding:10px;display:flex}.eIdKYq_resultHead,.eIdKYq_resultMetrics{flex-wrap:wrap;align-items:center;gap:6px 12px;display:flex}.eIdKYq_resultHead{justify-content:space-between}.eIdKYq_resultStage,.eIdKYq_resultMetrics{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.eIdKYq_resultMetrics [data-measurement=measured]{color:var(--dsw-alias-state-success-primary)}.eIdKYq_resultMetrics [data-measurement=estimated]{color:var(--dsw-alias-state-warn-label)}.eIdKYq_resultMetrics [data-verification=passed]{color:var(--dsw-alias-state-success-primary)}.eIdKYq_resultMetrics [data-verification=failed]{color:var(--dsw-alias-state-error-primary)}.eIdKYq_candidates{grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:6px;margin:0;padding:0;list-style:none;display:grid}.eIdKYq_candidate{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);min-width:0;color:var(--dsw-alias-label-tertiary);border-radius:7px;flex-direction:column;gap:2px;padding:7px;font-size:10px;line-height:15px;display:flex}.eIdKYq_candidate[data-selected=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}.eIdKYq_phaseSummary{min-width:0;color:var(--dsw-alias-label-tertiary);text-align:right;text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:11px;line-height:16px;overflow:hidden}.eIdKYq_callLabel{min-width:0;color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:12px;line-height:18px;overflow:hidden}.eIdKYq_callMeta{color:var(--dsw-alias-label-tertiary);flex:none;align-items:center;gap:6px;font-size:11px;line-height:16px;display:inline-flex}.eIdKYq_badge{border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px}.eIdKYq_callStatus{color:var(--dsw-alias-label-tertiary);flex:none;font-size:11px;font-weight:510;line-height:16px}.eIdKYq_callTreeItem[data-call-status=failed] .eIdKYq_callStatus{color:var(--dsw-alias-state-error-primary)}";
		const tagId$1 = "@deepseek-ai/dsh-client-ui-kersor-viewer/KersorView.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-kersor-viewer";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var _dsh_css_64557083eb0f58b9_default = {
			"activeLabel": "eIdKYq_activeLabel",
			"activeList": "eIdKYq_activeList",
			"activeRow": "eIdKYq_activeRow",
			"activeRunId": "eIdKYq_activeRunId",
			"activitySection": "eIdKYq_activitySection",
			"artifacts": "eIdKYq_artifacts",
			"authoredBadge": "eIdKYq_authoredBadge",
			"authoringBadge": "eIdKYq_authoringBadge",
			"authoringChain": "eIdKYq_authoringChain",
			"badge": "eIdKYq_badge",
			"baselineAction": "eIdKYq_baselineAction",
			"baselineActionLabel": "eIdKYq_baselineActionLabel",
			"baselineActionReason": "eIdKYq_baselineActionReason",
			"body": "eIdKYq_body",
			"callActivities": "eIdKYq_callActivities",
			"callDetail": "eIdKYq_callDetail",
			"callDetailMeta": "eIdKYq_callDetailMeta",
			"callLabel": "eIdKYq_callLabel",
			"callMessages": "eIdKYq_callMessages",
			"callMeta": "eIdKYq_callMeta",
			"callStatus": "eIdKYq_callStatus",
			"callTreeItem": "eIdKYq_callTreeItem",
			"candidate": "eIdKYq_candidate",
			"candidates": "eIdKYq_candidates",
			"checks": "eIdKYq_checks",
			"classicDetail": "eIdKYq_classicDetail",
			"classicExpand": "eIdKYq_classicExpand",
			"classicFoot": "eIdKYq_classicFoot",
			"classicHead": "eIdKYq_classicHead",
			"classicMetrics": "eIdKYq_classicMetrics",
			"classicRow": "eIdKYq_classicRow",
			"classicRows": "eIdKYq_classicRows",
			"controlButton": "eIdKYq_controlButton",
			"decisionReason": "eIdKYq_decisionReason",
			"design": "eIdKYq_design",
			"designDisclosure": "eIdKYq_designDisclosure",
			"designMeta": "eIdKYq_designMeta",
			"designText": "eIdKYq_designText",
			"detailError": "eIdKYq_detailError",
			"detailGrid": "eIdKYq_detailGrid",
			"detailNote": "eIdKYq_detailNote",
			"detailPath": "eIdKYq_detailPath",
			"detailReason": "eIdKYq_detailReason",
			"detailSection": "eIdKYq_detailSection",
			"detailTitle": "eIdKYq_detailTitle",
			"excludedBadge": "eIdKYq_excludedBadge",
			"executionTree": "eIdKYq_executionTree",
			"failureBadge": "eIdKYq_failureBadge",
			"fitBadge": "eIdKYq_fitBadge",
			"followButton": "eIdKYq_followButton",
			"gateBadge": "eIdKYq_gateBadge",
			"header": "eIdKYq_header",
			"hostStep": "eIdKYq_hostStep",
			"hostTreeItem": "eIdKYq_hostTreeItem",
			"launcher": "eIdKYq_launcher",
			"launcherHead": "eIdKYq_launcherHead",
			"launcherSummary": "eIdKYq_launcherSummary",
			"launcherTitle": "eIdKYq_launcherTitle",
			"mono": "eIdKYq_mono",
			"note": "eIdKYq_note",
			"outcomeHead": "eIdKYq_outcomeHead",
			"outcomeMetrics": "eIdKYq_outcomeMetrics",
			"outcomeSummary": "eIdKYq_outcomeSummary",
			"phaseBadge": "eIdKYq_phaseBadge",
			"phaseSummary": "eIdKYq_phaseSummary",
			"phaseTreeItem": "eIdKYq_phaseTreeItem",
			"profileBlock": "eIdKYq_profileBlock",
			"profileBlockLabel": "eIdKYq_profileBlockLabel",
			"profileBlockReason": "eIdKYq_profileBlockReason",
			"promotedBadge": "eIdKYq_promotedBadge",
			"readError": "eIdKYq_readError",
			"requiredArgs": "eIdKYq_requiredArgs",
			"resultHead": "eIdKYq_resultHead",
			"resultMetrics": "eIdKYq_resultMetrics",
			"resultStage": "eIdKYq_resultStage",
			"roundDecision": "eIdKYq_roundDecision",
			"roundFacts": "eIdKYq_roundFacts",
			"roundHead": "eIdKYq_roundHead",
			"roundHistory": "eIdKYq_roundHistory",
			"roundNode": "eIdKYq_roundNode",
			"roundTree": "eIdKYq_roundTree",
			"roundVerdict": "eIdKYq_roundVerdict",
			"roundWorkflow": "eIdKYq_roundWorkflow",
			"routeBadge": "eIdKYq_routeBadge",
			"row": "eIdKYq_row",
			"rowHead": "eIdKYq_rowHead",
			"rowLabel": "eIdKYq_rowLabel",
			"rows": "eIdKYq_rows",
			"runDetail": "eIdKYq_runDetail",
			"runError": "eIdKYq_runError",
			"runHead": "eIdKYq_runHead",
			"runId": "eIdKYq_runId",
			"runMeta": "eIdKYq_runMeta",
			"sectionHead": "eIdKYq_sectionHead",
			"sectionSummary": "eIdKYq_sectionSummary",
			"sectionTitle": "eIdKYq_sectionTitle",
			"selectedBadge": "eIdKYq_selectedBadge",
			"sessionId": "eIdKYq_sessionId",
			"statusTail": "eIdKYq_statusTail",
			"stopNode": "eIdKYq_stopNode",
			"taskLabel": "eIdKYq_taskLabel",
			"taskList": "eIdKYq_taskList",
			"taskRow": "eIdKYq_taskRow",
			"timeline": "eIdKYq_timeline",
			"timelineStep": "eIdKYq_timelineStep",
			"title": "eIdKYq_title",
			"treeGroup": "eIdKYq_treeGroup",
			"treeNode": "eIdKYq_treeNode",
			"treeNodeButton": "eIdKYq_treeNodeButton",
			"view": "eIdKYq_view",
			"warningCount": "eIdKYq_warningCount",
			"workflowBranch": "eIdKYq_workflowBranch",
			"workflowBranches": "eIdKYq_workflowBranches",
			"workflowIdentity": "eIdKYq_workflowIdentity",
			"workflowName": "eIdKYq_workflowName",
			"workflowPhase": "eIdKYq_workflowPhase",
			"workflowPhaseBody": "eIdKYq_workflowPhaseBody",
			"workflowPhaseIndex": "eIdKYq_workflowPhaseIndex",
			"workflowResult": "eIdKYq_workflowResult",
			"workflowRoot": "eIdKYq_workflowRoot",
			"workflowTree": "eIdKYq_workflowTree",
			"workspaceBadge": "eIdKYq_workspaceBadge"
		};
		//#endregion
		//#region lib/types/client/KersorView.js
		/** KerSor conversation view: Session inventory with live Workflow progress. */
		const RUN_STATUS_KEYS = {
			running: "run.active",
			completed: "run.completed",
			waiting: "run.waiting",
			failed: "run.failed",
			unknown: "run.unknown"
		};
		const CALL_STATUS_KEYS = {
			queued: "call.queued",
			running: "call.running",
			completed: "call.completed",
			failed: "call.failed"
		};
		function runDotState(status) {
			switch (status) {
				case "running": return "ongoing";
				case "completed": return "done";
				case "waiting": return "warning";
				case "failed": return "error";
				/* v8 ignore next -- KersorRunStatus is closed and every variant is handled above. */
				default: return "warning";
			}
		}
		function callDotState(status) {
			switch (status) {
				case "queued": return "warning";
				case "running": return "ongoing";
				case "completed": return "done";
				case "failed": return "error";
			}
		}
		function phaseDotState(status) {
			switch (status) {
				case "running": return "ongoing";
				case "completed": return "done";
				case "failed": return "error";
			}
		}
		const CLASSIC_HEALTH_KEYS = {
			active: "session.health.active",
			stale: "session.health.stale",
			needs_resume: "session.health.needsResume",
			terminal: "session.health.terminal",
			unknown: "session.health.unknown"
		};
		const CLASSIC_STEP_KEYS = {
			setup: "detail.step.setup",
			baseline: "detail.step.baseline",
			profile: "detail.step.profile",
			selection: "detail.step.selection",
			authoring: "detail.step.authoring",
			validation: "detail.step.validation",
			dispatch: "detail.step.dispatch",
			measurement: "detail.step.measurement",
			decision: "detail.step.decision"
		};
		const CLASSIC_STEP_STATUS_KEYS = {
			pending: "step.pending",
			active: "step.active",
			completed: "step.completed",
			failed: "step.failed"
		};
		function classicStepDotState(status) {
			switch (status) {
				case "pending": return "warning";
				case "active": return "ongoing";
				case "completed": return "done";
				case "failed": return "error";
			}
		}
		function classicDotState(health, lifecycle) {
			if (health === "active") return "ongoing";
			if (health !== "terminal") return "warning";
			switch (lifecycle) {
				case "completed": return "done";
				case "stalled": return "error";
				case "cancelled": return "warning";
				case "active": return "warning";
			}
		}
		function speedup(value) {
			return Number.isInteger(value) ? value.toFixed(1) : value.toFixed(2);
		}
		const GATE_KEYS = {
			pass: "session.gate.pass",
			fail: "session.gate.fail",
			pending: "session.gate.pending",
			not_required: "session.gate.notRequired"
		};
		const BASELINE_ACTION_KEYS = {
			init: "session.baselineAction.init",
			record_verify: "session.baselineAction.recordVerify",
			new_session: "session.baselineAction.newSession"
		};
		const STOP_REASON_KEYS = {
			target_met: "detail.stop.targetMet",
			execution_budget_exhausted: "detail.stop.executionBudget",
			selection_stalled: "detail.stop.selectionStalled",
			authoring_budget_exhausted: "detail.stop.authoringBudget",
			cancelled: "detail.stop.cancelled",
			single_run_complete: "detail.stop.singleRun"
		};
		const FAILURE_KIND_KEYS = {
			correctness: "detail.round.failure.correctness",
			benchmark: "detail.round.failure.benchmark",
			infrastructure: "detail.round.failure.infrastructure"
		};
		function displayTime(value) {
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return void 0;
			return new Intl.DateTimeFormat(void 0, {
				dateStyle: "medium",
				timeStyle: "short"
			}).format(date);
		}
		function roundDotState(round) {
			if (round.host_verdict === "fail") return "error";
			if (round.host_verdict === "pending") return "ongoing";
			return round.measurement?.best_improved === true ? "done" : "warning";
		}
		function RoundHistory({ rounds, stopReason, t }) {
			if (rounds.length === 0) return null;
			return (0, react_jsx_runtime.jsxs)("section", {
				className: _dsh_css_64557083eb0f58b9_default.roundHistory,
				"aria-label": t("detail.rounds"),
				children: [(0, react_jsx_runtime.jsx)("span", {
					className: _dsh_css_64557083eb0f58b9_default.detailTitle,
					children: t("detail.rounds")
				}), (0, react_jsx_runtime.jsxs)("ol", {
					className: _dsh_css_64557083eb0f58b9_default.roundTree,
					role: "tree",
					"aria-label": t("detail.roundTree"),
					children: [rounds.map((round) => (0, react_jsx_runtime.jsxs)("li", {
						className: _dsh_css_64557083eb0f58b9_default.roundNode,
						role: "treeitem",
						"data-host-verdict": round.host_verdict,
						"data-promoted": round.measurement?.best_improved ?? false,
						children: [
							(0, react_jsx_runtime.jsxs)("div", {
								className: _dsh_css_64557083eb0f58b9_default.roundHead,
								children: [
									(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: roundDotState(round) }),
									(0, react_jsx_runtime.jsx)("strong", { children: t("detail.round.number", { round: round.number }) }),
									(0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.roundWorkflow,
										children: round.workflow ?? t("session.noWorkflow")
									}),
									round.workflow_origin === "authored" ? (0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.authoredBadge,
										children: t("detail.round.authored")
									}) : null,
									(0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.roundVerdict,
										children: t(`detail.round.verdict.${round.host_verdict}`)
									})
								]
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: _dsh_css_64557083eb0f58b9_default.roundFacts,
								children: [
									round.candidate_id !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.mono,
										children: t("detail.round.candidate", { candidate: round.candidate_id })
									}) : null,
									round.measurement?.candidate_cycles !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
										"data-measurement": "measured",
										children: t("detail.round.measuredCycles", { cycles: round.measurement.candidate_cycles.toLocaleString() })
									}) : null,
									round.measurement?.candidate_speedup !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
										"data-measurement": "measured",
										children: t("detail.round.measuredSpeedup", { speedup: speedup(round.measurement.candidate_speedup) })
									}) : null,
									round.measurement?.best_improved === true ? (0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.promotedBadge,
										children: t("detail.round.promoted")
									}) : round.host_verdict === "pass" ? (0, react_jsx_runtime.jsx)("span", { children: t("detail.round.retained") }) : null,
									round.failure_kind !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.failureBadge,
										children: t(FAILURE_KIND_KEYS[round.failure_kind])
									}) : null,
									round.estimate?.cycles !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
										"data-measurement": "estimated",
										children: t("detail.round.estimatedCycles", { cycles: round.estimate.cycles.toLocaleString() })
									}) : null,
									round.estimate?.speedup !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
										"data-measurement": "estimated",
										children: t("detail.round.estimatedSpeedup", { speedup: speedup(round.estimate.speedup) })
									}) : null,
									round.host_verdict === "fail" && round.estimate !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.excludedBadge,
										children: t("detail.round.estimateExcluded")
									}) : null
								]
							}),
							round.workflow_origin === "authored" ? (0, react_jsx_runtime.jsx)("div", {
								className: _dsh_css_64557083eb0f58b9_default.authoringChain,
								children: t("detail.round.authoringChain")
							}) : null,
							round.decision !== void 0 ? (0, react_jsx_runtime.jsx)("div", {
								className: _dsh_css_64557083eb0f58b9_default.roundDecision,
								children: round.decision
							}) : null
						]
					}, round.number)), stopReason !== null && stopReason !== void 0 ? (0, react_jsx_runtime.jsxs)("li", {
						className: _dsh_css_64557083eb0f58b9_default.stopNode,
						role: "treeitem",
						"data-stop-reason": stopReason,
						children: [
							(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: stopReason === "target_met" ? "done" : "warning" }),
							(0, react_jsx_runtime.jsx)("strong", { children: t("detail.stop") }),
							(0, react_jsx_runtime.jsx)("span", { children: t(STOP_REASON_KEYS[stopReason]) })
						]
					}) : null]
				})]
			});
		}
		function ClassicSessionDetail({ session, detail, t }) {
			const design = detail.workflow ?? detail.authoring.design;
			const phases = design?.phases ?? [];
			const lineage = session.cycle_lineage;
			const latestFailureKind = detail.rounds.at(-1)?.failure_kind;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: _dsh_css_64557083eb0f58b9_default.classicDetail,
				children: [
					(0, react_jsx_runtime.jsxs)("section", {
						className: _dsh_css_64557083eb0f58b9_default.outcomeSummary,
						"data-stop-reason": session.stop_reason ?? void 0,
						children: [(0, react_jsx_runtime.jsxs)("div", {
							className: _dsh_css_64557083eb0f58b9_default.outcomeHead,
							children: [(0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.detailTitle,
								children: t("detail.outcome")
							}), session.stop_reason !== null && session.stop_reason !== void 0 ? (0, react_jsx_runtime.jsx)("span", { children: t(STOP_REASON_KEYS[session.stop_reason]) }) : (0, react_jsx_runtime.jsx)("span", { children: t(CLASSIC_HEALTH_KEYS[session.health]) })]
						}), (0, react_jsx_runtime.jsxs)("div", {
							className: _dsh_css_64557083eb0f58b9_default.outcomeMetrics,
							children: [
								lineage?.best_cycles !== void 0 ? (0, react_jsx_runtime.jsx)("strong", { children: t("detail.bestCycles", { cycles: lineage.best_cycles.toLocaleString() }) }) : null,
								lineage?.session_baseline_cycles !== void 0 && lineage.best_cycles !== void 0 ? (0, react_jsx_runtime.jsx)("span", { children: t("detail.sessionLineage", {
									baseline: lineage.session_baseline_cycles.toLocaleString(),
									best: lineage.best_cycles.toLocaleString(),
									speedup: lineage.session_speedup === void 0 ? "—" : speedup(lineage.session_speedup)
								}) }) : null,
								lineage?.task_baseline_cycles !== void 0 && lineage.best_cycles !== void 0 ? (0, react_jsx_runtime.jsx)("span", { children: t("detail.overallLineage", {
									baseline: lineage.task_baseline_cycles.toLocaleString(),
									best: lineage.best_cycles.toLocaleString(),
									speedup: lineage.overall_speedup === void 0 ? "—" : speedup(lineage.overall_speedup)
								}) }) : null,
								session.allow_workflow_authoring === true ? (0, react_jsx_runtime.jsx)("span", { children: t("detail.authoringBudget", {
									used: session.workflow_authoring_used ?? 0,
									total: session.workflow_authoring_budget ?? "—"
								}) }) : null
							]
						})]
					}),
					(0, react_jsx_runtime.jsx)(RoundHistory, {
						rounds: detail.rounds,
						stopReason: session.stop_reason,
						t
					}),
					(0, react_jsx_runtime.jsx)("ol", {
						className: _dsh_css_64557083eb0f58b9_default.timeline,
						"aria-label": t("detail.timeline"),
						children: detail.steps.map((step) => (0, react_jsx_runtime.jsxs)("li", {
							className: _dsh_css_64557083eb0f58b9_default.timelineStep,
							"data-step-status": step.status,
							children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: classicStepDotState(step.status) }), (0, react_jsx_runtime.jsx)("span", { children: t(CLASSIC_STEP_KEYS[step.id]) })]
						}, step.id))
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: _dsh_css_64557083eb0f58b9_default.detailGrid,
						children: [
							(0, react_jsx_runtime.jsxs)("section", {
								className: _dsh_css_64557083eb0f58b9_default.detailSection,
								children: [
									(0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.detailTitle,
										children: t("detail.selection")
									}),
									(0, react_jsx_runtime.jsx)("span", { children: t(`detail.selection.${detail.selection.status}`) }),
									detail.selection.workflow !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.mono,
										children: detail.selection.workflow
									}) : null,
									detail.selection.reason !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.detailReason,
										children: detail.selection.reason
									}) : null,
									(0, react_jsx_runtime.jsx)("span", { children: t("detail.rejected", { count: detail.selection.rejectedCount }) })
								]
							}),
							(0, react_jsx_runtime.jsxs)("section", {
								className: _dsh_css_64557083eb0f58b9_default.detailSection,
								children: [
									(0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.detailTitle,
										children: t("detail.authoring")
									}),
									(0, react_jsx_runtime.jsx)("span", { children: t(`detail.authoring.${detail.authoring.status}`) }),
									detail.authoring.omittedReason !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.detailError,
										children: t("detail.omitted", { reason: detail.authoring.omittedReason })
									}) : null
								]
							}),
							(0, react_jsx_runtime.jsxs)("section", {
								className: _dsh_css_64557083eb0f58b9_default.detailSection,
								children: [
									(0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.detailTitle,
										children: t("detail.validation")
									}),
									(0, react_jsx_runtime.jsx)("span", { children: t(`detail.validation.${detail.validation.status}`) }),
									detail.validation.checks.length > 0 ? (0, react_jsx_runtime.jsx)("ul", {
										className: _dsh_css_64557083eb0f58b9_default.checks,
										children: detail.validation.checks.map((check) => (0, react_jsx_runtime.jsxs)("li", {
											"data-check-passed": check.passed,
											children: [
												check.passed ? "✓" : "×",
												" ",
												check.name
											]
										}, check.name))
									}) : null
								]
							}),
							(0, react_jsx_runtime.jsxs)("section", {
								className: _dsh_css_64557083eb0f58b9_default.detailSection,
								children: [
									(0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.detailTitle,
										children: t("detail.dispatch")
									}),
									(0, react_jsx_runtime.jsx)("span", { children: detail.dispatch.status === "failed" && latestFailureKind !== void 0 ? t(FAILURE_KIND_KEYS[latestFailureKind]) : t(`detail.dispatch.${detail.dispatch.status}`) }),
									detail.dispatch.runtimeStatus !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.mono,
										children: detail.dispatch.runtimeStatus
									}) : null,
									detail.dispatch.runDir !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.detailPath,
										title: detail.dispatch.runDir,
										children: detail.dispatch.runDir
									}) : null
								]
							})
						]
					}),
					detail.authoring.files.length > 0 ? (0, react_jsx_runtime.jsx)("div", {
						className: _dsh_css_64557083eb0f58b9_default.artifacts,
						children: detail.authoring.files.map((file) => (0, react_jsx_runtime.jsxs)("span", {
							title: file.sha256,
							children: [
								(0, react_jsx_runtime.jsx)("span", {
									className: _dsh_css_64557083eb0f58b9_default.mono,
									children: file.name
								}),
								" · ",
								file.bytes,
								" B · ",
								file.sha256.slice(0, 18),
								"…"
							]
						}, file.name))
					}) : null,
					design !== void 0 ? (0, react_jsx_runtime.jsxs)("div", {
						className: _dsh_css_64557083eb0f58b9_default.design,
						children: [
							(0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.detailTitle,
								children: t("detail.workflowDesign")
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: _dsh_css_64557083eb0f58b9_default.designMeta,
								children: [
									design.name !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.mono,
										children: design.name
									}) : null,
									design.technique !== void 0 ? (0, react_jsx_runtime.jsx)("span", { children: design.technique }) : null,
									design.methodCategory !== void 0 ? (0, react_jsx_runtime.jsx)("span", { children: design.methodCategory }) : null,
									design.topology !== void 0 ? (0, react_jsx_runtime.jsx)("span", { children: design.topology }) : null,
									design.languages.map((value) => (0, react_jsx_runtime.jsx)("span", { children: value }, `language:${value}`)),
									design.backends.map((value) => (0, react_jsx_runtime.jsx)("span", { children: value }, `backend:${value}`)),
									design.integrationPatterns.map((value) => (0, react_jsx_runtime.jsx)("span", { children: value }, `integration:${value}`))
								]
							}),
							design.description !== void 0 ? (0, react_jsx_runtime.jsx)("p", {
								className: _dsh_css_64557083eb0f58b9_default.designText,
								children: design.description
							}) : null,
							phases.length > 0 ? (0, react_jsx_runtime.jsxs)("div", {
								className: _dsh_css_64557083eb0f58b9_default.workflowTree,
								role: "tree",
								"aria-label": t("detail.workflowTree"),
								children: [(0, react_jsx_runtime.jsxs)("div", {
									className: _dsh_css_64557083eb0f58b9_default.workflowRoot,
									role: "treeitem",
									"aria-expanded": "true",
									children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: detail.dispatch.status === "failed" ? "error" : detail.dispatch.status === "completed" ? "done" : detail.dispatch.status === "running" ? "ongoing" : "warning" }), (0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.mono,
										children: design.name ?? detail.selection.workflow ?? "Workflow"
									})]
								}), (0, react_jsx_runtime.jsx)("div", {
									className: _dsh_css_64557083eb0f58b9_default.workflowBranches,
									role: "group",
									children: phases.map((phase, index) => (0, react_jsx_runtime.jsxs)("div", {
										className: _dsh_css_64557083eb0f58b9_default.workflowPhase,
										role: "treeitem",
										children: [
											(0, react_jsx_runtime.jsx)("span", {
												className: _dsh_css_64557083eb0f58b9_default.workflowBranch,
												"aria-hidden": "true",
												children: index === phases.length - 1 ? "└" : "├"
											}),
											(0, react_jsx_runtime.jsx)("span", {
												className: _dsh_css_64557083eb0f58b9_default.workflowPhaseIndex,
												children: index + 1
											}),
											(0, react_jsx_runtime.jsxs)("span", {
												className: _dsh_css_64557083eb0f58b9_default.workflowPhaseBody,
												children: [(0, react_jsx_runtime.jsx)("strong", { children: phase.title }), (0, react_jsx_runtime.jsx)("span", { children: phase.detail })]
											})
										]
									}, `${index}:${phase.title}`))
								})]
							}) : null,
							design.requiredArgs.length > 0 ? (0, react_jsx_runtime.jsxs)("div", {
								className: _dsh_css_64557083eb0f58b9_default.requiredArgs,
								children: [
									t("detail.requiredArgs"),
									": ",
									(0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.mono,
										children: design.requiredArgs.join(", ")
									})
								]
							}) : null,
							(0, react_jsx_runtime.jsxs)("details", {
								className: _dsh_css_64557083eb0f58b9_default.designDisclosure,
								children: [(0, react_jsx_runtime.jsx)("summary", { children: t("detail.rationale") }), (0, react_jsx_runtime.jsx)("pre", { children: design.rationale })]
							}),
							design.whenToUse !== void 0 ? (0, react_jsx_runtime.jsxs)("details", {
								className: _dsh_css_64557083eb0f58b9_default.designDisclosure,
								children: [(0, react_jsx_runtime.jsx)("summary", { children: t("detail.whenToUse") }), (0, react_jsx_runtime.jsx)("pre", { children: design.whenToUse })]
							}) : null,
							(0, react_jsx_runtime.jsxs)("details", {
								className: _dsh_css_64557083eb0f58b9_default.designDisclosure,
								children: [(0, react_jsx_runtime.jsx)("summary", { children: t("detail.source") }), (0, react_jsx_runtime.jsx)("pre", { children: design.source })]
							})
						]
					}) : (0, react_jsx_runtime.jsx)("div", {
						className: _dsh_css_64557083eb0f58b9_default.detailNote,
						children: t("detail.sealRequired")
					})
				]
			});
		}
		function ClassicSessionRow({ session, selected, crossWorkspace, detail, loading, error, onToggle, t }) {
			const round = session.current_round !== null && session.current_round !== void 0 ? session.max_workflows !== null && session.max_workflows !== void 0 ? t("session.round", {
				current: session.current_round,
				maximum: session.max_workflows
			}) : t("session.roundOpen", { current: session.current_round }) : void 0;
			const details = [
				session.kernel_language !== null && session.kernel_language !== void 0 ? session.backend !== null && session.backend !== void 0 ? `${session.kernel_language}/${session.backend}` : session.kernel_language : session.backend ?? void 0,
				session.mode,
				session.storage_kind
			].filter(Boolean).join(" · ");
			const activity = session.last_activity_at !== null && session.last_activity_at !== void 0 ? displayTime(session.last_activity_at) : void 0;
			const fitConfidence = visibleFitConfidence(session);
			return (0, react_jsx_runtime.jsxs)("li", {
				className: _dsh_css_64557083eb0f58b9_default.classicRow,
				"data-session-health": session.health,
				"data-session-lifecycle": session.lifecycle,
				"data-expanded": selected,
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: _dsh_css_64557083eb0f58b9_default.classicHead,
						children: [
							(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: session.stop_reason === "execution_budget_exhausted" ? "warning" : classicDotState(session.health, session.lifecycle) }),
							(0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.sessionId,
								title: session.session_dir,
								children: session.session_id
							}),
							(0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.phaseBadge,
								children: t(CLASSIC_HEALTH_KEYS[session.health])
							}),
							crossWorkspace ? (0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.workspaceBadge,
								children: t("session.otherWorkspace")
							}) : null,
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: _dsh_css_64557083eb0f58b9_default.classicExpand,
								"aria-expanded": selected,
								"aria-label": selected ? t("detail.collapse") : t("detail.expand"),
								onClick: onToggle,
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutline14, {})
							})
						]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: _dsh_css_64557083eb0f58b9_default.classicMetrics,
						children: [
							round !== void 0 ? (0, react_jsx_runtime.jsx)("span", { children: round }) : null,
							session.best_speedup !== null && session.best_speedup !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
								"data-target-met": session.target_met ?? void 0,
								children: t("session.best", { speedup: speedup(session.best_speedup) })
							}) : null,
							session.target_speedup !== null && session.target_speedup !== void 0 ? (0, react_jsx_runtime.jsx)("span", { children: t("session.target", { speedup: speedup(session.target_speedup) }) }) : null,
							(0, react_jsx_runtime.jsx)("span", { children: session.phase ?? t("session.unknownPhase") }),
							details.length > 0 ? (0, react_jsx_runtime.jsx)("span", { children: details }) : null,
							session.integration_pattern !== null && session.integration_pattern !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.routeBadge,
								children: session.integration_pattern
							}) : null,
							session.allow_workflow_authoring === true ? (0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.authoringBadge,
								children: t("session.authoring", {
									used: session.workflow_authoring_used ?? 0,
									budget: session.workflow_authoring_budget ?? "—"
								})
							}) : null,
							session.fresh_session != null ? (0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.gateBadge,
								"data-gate": session.fresh_session,
								children: t("session.freshGate", { status: t(GATE_KEYS[session.fresh_session]) })
							}) : null,
							session.allow_workflow_authoring === true && session.baseline_witness != null ? (0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.gateBadge,
								"data-gate": session.baseline_witness,
								children: t("session.baselineGate", { status: t(GATE_KEYS[session.baseline_witness]) })
							}) : null,
							session.allow_workflow_authoring === true && session.profile_evidence != null ? (0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.gateBadge,
								"data-gate": session.profile_evidence,
								children: t("session.profileGate", { status: t(GATE_KEYS[session.profile_evidence]) })
							}) : null,
							session.allow_workflow_authoring === true && session.profile_owner != null ? (0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.routeBadge,
								"data-profile-owner": session.profile_owner,
								children: t("session.profileOwner", { owner: session.profile_owner })
							}) : null,
							session.allow_workflow_authoring === true && session.dsh_compatibility != null ? (0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.gateBadge,
								"data-gate": session.dsh_compatibility,
								children: t("session.dshGate", { status: t(GATE_KEYS[session.dsh_compatibility]) })
							}) : null,
							session.allow_workflow_authoring === true && session.candidate_ownership != null ? (0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.gateBadge,
								"data-gate": session.candidate_ownership,
								children: t("session.ownershipGate", { status: t(GATE_KEYS[session.candidate_ownership]) })
							}) : null,
							activity !== void 0 ? (0, react_jsx_runtime.jsx)("span", { children: t("session.lastActivity", { time: activity }) }) : null
						]
					}),
					session.allow_workflow_authoring === true && session.baseline_next_action != null ? (0, react_jsx_runtime.jsxs)("div", {
						className: _dsh_css_64557083eb0f58b9_default.baselineAction,
						"data-baseline-action": session.baseline_next_action,
						title: session.baseline_reason ?? void 0,
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: _dsh_css_64557083eb0f58b9_default.baselineActionLabel,
							children: t(BASELINE_ACTION_KEYS[session.baseline_next_action])
						}), session.baseline_reason != null ? (0, react_jsx_runtime.jsx)("span", {
							className: _dsh_css_64557083eb0f58b9_default.baselineActionReason,
							children: session.baseline_reason
						}) : null]
					}) : null,
					session.allow_workflow_authoring === true && session.profile_evidence === "fail" && session.profile_reason != null ? (0, react_jsx_runtime.jsxs)("div", {
						className: _dsh_css_64557083eb0f58b9_default.profileBlock,
						"data-profile-gate": "fail",
						title: session.profile_reason,
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: _dsh_css_64557083eb0f58b9_default.profileBlockLabel,
							children: t("session.profileBlocked")
						}), (0, react_jsx_runtime.jsx)("span", {
							className: _dsh_css_64557083eb0f58b9_default.profileBlockReason,
							children: session.profile_reason
						})]
					}) : null,
					(0, react_jsx_runtime.jsxs)("div", {
						className: _dsh_css_64557083eb0f58b9_default.classicFoot,
						children: [
							(0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.workflowName,
								children: session.selection_status === "stalled" ? t("session.selectorStalled") : session.workflow !== null && session.workflow !== void 0 ? t("session.workflow", { workflow: session.workflow }) : t("session.noWorkflow")
							}),
							fitConfidence !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.fitBadge,
								"data-fit-confidence": fitConfidence,
								children: t("session.fit", { confidence: fitConfidence })
							}) : null,
							session.warningCount > 0 ? (0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.warningCount,
								children: t("session.warnings", { count: session.warningCount })
							}) : null
						]
					}),
					session.decision !== null && session.decision !== void 0 ? (0, react_jsx_runtime.jsx)("div", {
						className: _dsh_css_64557083eb0f58b9_default.decisionReason,
						title: session.decision,
						children: session.decision
					}) : null,
					selected && loading ? (0, react_jsx_runtime.jsx)("div", {
						className: _dsh_css_64557083eb0f58b9_default.detailNote,
						children: t("detail.loading")
					}) : null,
					selected && error !== void 0 ? (0, react_jsx_runtime.jsx)("div", {
						className: _dsh_css_64557083eb0f58b9_default.detailError,
						children: error
					}) : null,
					selected && detail !== void 0 ? (0, react_jsx_runtime.jsx)(ClassicSessionDetail, {
						session,
						detail,
						t
					}) : null
				]
			});
		}
		function durationSeconds(startedTs, endedTs) {
			if (startedTs === void 0 || endedTs === void 0) return void 0;
			const start = Date.parse(startedTs);
			const end = Date.parse(endedTs);
			if (Number.isNaN(start) || Number.isNaN(end) || end < start) return void 0;
			return `${((end - start) / 1e3).toFixed(1)}s`;
		}
		function normalizedPath(value) {
			return value.replace(/\\/g, "/").replace(/\/+$/, "");
		}
		function belongsToWorkspace(sessionDir, workspace) {
			if (workspace === void 0 || workspace.length === 0) return true;
			return normalizedPath(sessionDir).startsWith(`${normalizedPath(workspace)}/.kersor/`);
		}
		function sessionName(sessionDir) {
			return normalizedPath(sessionDir).split("/").at(-1) ?? sessionDir;
		}
		function runDisplayLabel(row, session) {
			const round = row.round ?? session?.current_round ?? void 0;
			const roundLabel = round === void 0 ? row.runId : `R${String(round).padStart(2, "0")}`;
			const workflow = row.view?.workflow ?? session?.workflow ?? row.runId;
			if (row.kind === "general-task") return workflow === row.runId ? row.runId : `${row.runId} · ${workflow}`;
			return `${session?.session_id ?? sessionName(row.sessionDir)} · ${roundLabel} · ${workflow}`;
		}
		function CallDetail({ detail, t }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: _dsh_css_64557083eb0f58b9_default.callDetail,
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: _dsh_css_64557083eb0f58b9_default.callDetailMeta,
						children: [
							(0, react_jsx_runtime.jsx)("span", { children: detail.runner === "codex-exec" ? t("call.runner.codex") : t("call.runner.unknown") }),
							(0, react_jsx_runtime.jsx)("span", { children: t("call.model", { model: detail.model ?? t("call.modelUnknown") }) }),
							detail.modelRole != null ? (0, react_jsx_runtime.jsx)("span", { children: t("call.modelRole", { role: detail.modelRole }) }) : null,
							detail.threadId !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.mono,
								children: detail.threadId
							}) : null,
							detail.isolation !== void 0 ? (0, react_jsx_runtime.jsx)("span", { children: detail.isolation }) : null
						]
					}),
					detail.messages.length > 0 ? (0, react_jsx_runtime.jsx)("div", {
						className: _dsh_css_64557083eb0f58b9_default.callMessages,
						children: detail.messages.map((message) => (0, react_jsx_runtime.jsx)("pre", { children: message.text }, message.id))
					}) : (0, react_jsx_runtime.jsx)("div", {
						className: _dsh_css_64557083eb0f58b9_default.detailNote,
						children: t("call.noMessages")
					}),
					detail.activities.length > 0 ? (0, react_jsx_runtime.jsx)("ul", {
						className: _dsh_css_64557083eb0f58b9_default.callActivities,
						children: detail.activities.map((activity) => (0, react_jsx_runtime.jsxs)("li", { children: [
							(0, react_jsx_runtime.jsx)("span", { children: activity.kind === "web-search" ? t("call.webSearch") : t("call.tool") }),
							(0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.mono,
								children: activity.label
							}),
							(0, react_jsx_runtime.jsx)("span", { children: activity.status })
						] }, activity.id))
					}) : null,
					detail.truncated ? (0, react_jsx_runtime.jsx)("div", {
						className: _dsh_css_64557083eb0f58b9_default.detailNote,
						children: t("call.truncated")
					}) : null
				]
			});
		}
		function CallTreeNode({ call, selectedCandidateId, selected, detail, loading, error, onToggle, t }) {
			const duration = durationSeconds(call.startedTs, call.endedTs);
			const chosen = selectedCandidateId !== void 0 && call.label.endsWith(selectedCandidateId);
			return (0, react_jsx_runtime.jsxs)("li", {
				role: "treeitem",
				"aria-expanded": selected,
				className: _dsh_css_64557083eb0f58b9_default.callTreeItem,
				"data-call-status": call.status,
				children: [
					(0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: _dsh_css_64557083eb0f58b9_default.treeNodeButton,
						onClick: onToggle,
						"aria-label": t("call.open", { label: call.label }),
						children: [
							(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: callDotState(call.status) }),
							(0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.callLabel,
								title: call.callId,
								children: call.label
							}),
							chosen ? (0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.selectedBadge,
								children: t("run.result.chosen")
							}) : null,
							(0, react_jsx_runtime.jsxs)("span", {
								className: _dsh_css_64557083eb0f58b9_default.callMeta,
								children: [
									call.kind === "evaluation" ? t("call.evaluation") : null,
									call.rolledBack ? (0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.badge,
										children: t("call.rolledBack")
									}) : null,
									duration !== void 0 ? (0, react_jsx_runtime.jsx)("span", { children: duration }) : null,
									call.tokens !== void 0 ? (0, react_jsx_runtime.jsxs)("span", { children: [call.tokens.toLocaleString(), " tk"] }) : null
								]
							}),
							(0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.callStatus,
								children: t(CALL_STATUS_KEYS[call.status])
							}),
							(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutline14, {})
						]
					}),
					selected && loading ? (0, react_jsx_runtime.jsx)("div", {
						className: _dsh_css_64557083eb0f58b9_default.detailNote,
						children: t("call.loading")
					}) : null,
					selected && error !== void 0 ? (0, react_jsx_runtime.jsx)("div", {
						className: _dsh_css_64557083eb0f58b9_default.detailError,
						children: error
					}) : null,
					selected && !loading && detail !== void 0 ? (0, react_jsx_runtime.jsx)(CallDetail, {
						detail,
						t
					}) : null
				]
			});
		}
		function hostStepStatus(detail, id) {
			return detail?.steps.find((step) => step.id === id)?.status ?? "pending";
		}
		function gateStepStatus(gate) {
			if (gate === "pass" || gate === "not_required") return "completed";
			if (gate === "fail") return "failed";
			return "pending";
		}
		function HostVerificationTree({ session, detail, result, t }) {
			const waiting = result?.stage === "awaiting_host_verification";
			const verified = result?.stage === "host_verified";
			const measurement = verified ? "completed" : hostStepStatus(detail, "measurement");
			const decision = session?.lifecycle === "completed" ? "completed" : hostStepStatus(detail, "decision");
			if (!waiting && !verified && measurement === "pending" && decision === "pending") return null;
			const status = measurement === "failed" || decision === "failed" ? "failed" : decision === "completed" ? "completed" : waiting || measurement === "active" || decision === "active" ? "active" : "pending";
			const steps = [
				{
					id: "ownership",
					label: t("run.host.ownership"),
					status: gateStepStatus(session?.candidate_ownership)
				},
				{
					id: "measurement",
					label: t("detail.step.measurement"),
					status: measurement
				},
				{
					id: "decision",
					label: t("detail.step.decision"),
					status: decision
				}
			];
			return (0, react_jsx_runtime.jsxs)("li", {
				role: "treeitem",
				"aria-expanded": true,
				className: _dsh_css_64557083eb0f58b9_default.hostTreeItem,
				"data-step-status": status,
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: _dsh_css_64557083eb0f58b9_default.treeNode,
					children: [
						(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: classicStepDotState(status) }),
						(0, react_jsx_runtime.jsx)("span", { children: t("run.host.title") }),
						(0, react_jsx_runtime.jsx)("span", {
							className: _dsh_css_64557083eb0f58b9_default.phaseSummary,
							children: t(CLASSIC_STEP_STATUS_KEYS[status])
						})
					]
				}), (0, react_jsx_runtime.jsx)("ul", {
					role: "group",
					className: _dsh_css_64557083eb0f58b9_default.treeGroup,
					children: steps.map((step) => (0, react_jsx_runtime.jsxs)("li", {
						role: "treeitem",
						className: _dsh_css_64557083eb0f58b9_default.hostStep,
						"data-step-status": step.status,
						children: [
							(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: classicStepDotState(step.status) }),
							(0, react_jsx_runtime.jsx)("span", { children: step.label }),
							(0, react_jsx_runtime.jsx)("span", { children: t(CLASSIC_STEP_STATUS_KEYS[step.status]) })
						]
					}, step.id))
				})]
			});
		}
		function WorkflowTree({ row, view, session, sessionDetail, state, loadCallDetail, t }) {
			const [selectedCallId, setSelectedCallId] = (0, react.useState)();
			const result = workflowResultOf(view);
			const detailKey = selectedCallId === void 0 ? void 0 : `${view.runDir}\u0000${selectedCallId}`;
			return (0, react_jsx_runtime.jsx)("ul", {
				role: "tree",
				"aria-label": t("run.tree"),
				className: _dsh_css_64557083eb0f58b9_default.executionTree,
				children: (0, react_jsx_runtime.jsxs)("li", {
					role: "treeitem",
					"aria-expanded": true,
					className: _dsh_css_64557083eb0f58b9_default.roundTreeItem,
					children: [(0, react_jsx_runtime.jsxs)("div", {
						className: _dsh_css_64557083eb0f58b9_default.treeNode,
						children: [
							(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: session?.lifecycle === "active" ? "ongoing" : runDotState(view.status) }),
							(0, react_jsx_runtime.jsx)("span", { children: session?.session_id ?? sessionName(view.sessionDir) }),
							(0, react_jsx_runtime.jsx)("span", { children: row.round === void 0 ? row.runId : `R${String(row.round).padStart(2, "0")}` })
						]
					}), (0, react_jsx_runtime.jsxs)("ul", {
						role: "group",
						className: _dsh_css_64557083eb0f58b9_default.treeGroup,
						children: [(0, react_jsx_runtime.jsxs)("li", {
							role: "treeitem",
							"aria-expanded": true,
							className: _dsh_css_64557083eb0f58b9_default.workflowTreeItem,
							children: [(0, react_jsx_runtime.jsxs)("div", {
								className: _dsh_css_64557083eb0f58b9_default.treeNode,
								children: [
									(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: runDotState(view.status) }),
									(0, react_jsx_runtime.jsx)("span", { children: view.workflow ?? view.runId }),
									(0, react_jsx_runtime.jsx)("span", { children: t(RUN_STATUS_KEYS[view.status]) })
								]
							}), (0, react_jsx_runtime.jsx)("ul", {
								role: "group",
								className: _dsh_css_64557083eb0f58b9_default.treeGroup,
								children: view.phases.map((phase) => (0, react_jsx_runtime.jsxs)("li", {
									role: "treeitem",
									"aria-expanded": phase.calls.length > 0,
									className: _dsh_css_64557083eb0f58b9_default.phaseTreeItem,
									"data-phase-status": phase.status,
									"data-parallel": phase.calls.length > 1,
									children: [(0, react_jsx_runtime.jsxs)("div", {
										className: _dsh_css_64557083eb0f58b9_default.treeNode,
										children: [
											(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: phaseDotState(phase.status) }),
											(0, react_jsx_runtime.jsx)("span", { children: phase.title.length > 0 ? phase.title : t("phase.empty") }),
											(0, react_jsx_runtime.jsx)("span", { children: phase.calls.length > 1 ? t("run.parallelCalls", { calls: phase.calls.length }) : t("run.calls", { calls: phase.calls.length }) })
										]
									}), phase.calls.length > 0 ? (0, react_jsx_runtime.jsx)("ul", {
										role: "group",
										className: _dsh_css_64557083eb0f58b9_default.treeGroup,
										children: phase.calls.map((call) => {
											const selected = selectedCallId === call.callId;
											const errorPrefix = `${view.runDir}\u0000${call.callId}: `;
											const callDetail = state.callDetails.get(`${view.runDir}\u0000${call.callId}`);
											return (0, react_jsx_runtime.jsx)(CallTreeNode, {
												call,
												...result?.selectedCandidateId === void 0 ? {} : { selectedCandidateId: result.selectedCandidateId },
												selected,
												loading: selected && state.callDetailLoading === detailKey,
												...state.callDetailError?.startsWith(errorPrefix) === true ? { error: state.callDetailError.slice(errorPrefix.length) } : {},
												...callDetail === void 0 ? {} : { detail: callDetail },
												onToggle: () => {
													const next = selected ? void 0 : call.callId;
													setSelectedCallId(next);
													if (next !== void 0 && state.callDetails.get(`${view.runDir}\u0000${next}`) === void 0) loadCallDetail(view.runDir, next);
												},
												t
											}, call.callId);
										})
									}) : null]
								}, `${phase.index}-${phase.title}`))
							})]
						}), (0, react_jsx_runtime.jsx)(HostVerificationTree, {
							session,
							detail: sessionDetail,
							result,
							t
						})]
					})]
				})
			});
		}
		function WorkflowResult({ result, t }) {
			return (0, react_jsx_runtime.jsxs)("section", {
				className: _dsh_css_64557083eb0f58b9_default.workflowResult,
				"aria-label": t("run.result.title"),
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: _dsh_css_64557083eb0f58b9_default.resultHead,
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: _dsh_css_64557083eb0f58b9_default.detailTitle,
							children: t("run.result.title")
						}), result.stage !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
							className: _dsh_css_64557083eb0f58b9_default.resultStage,
							children: t("run.result.stage", { stage: result.stage })
						}) : null]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: _dsh_css_64557083eb0f58b9_default.resultMetrics,
						children: [
							result.verification !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
								"data-verification": result.verification,
								children: t(`run.result.verification.${result.verification}`)
							}) : null,
							result.failureKind !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.failureBadge,
								children: t(FAILURE_KIND_KEYS[result.failureKind])
							}) : null,
							result.selectedCandidateId !== void 0 ? (0, react_jsx_runtime.jsx)("span", { children: t("run.result.selected", { candidate: result.selectedCandidateId }) }) : null,
							result.measuredCycles !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
								"data-measurement": "measured",
								children: t("run.result.cyclesMeasured", { cycles: result.measuredCycles.toLocaleString() })
							}) : result.expectedCycles !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
								"data-measurement": "estimated",
								children: t("run.result.cyclesEstimated", { cycles: result.expectedCycles.toLocaleString() })
							}) : null,
							result.measuredSpeedup !== void 0 && result.measuredSpeedup !== null ? (0, react_jsx_runtime.jsx)("span", {
								"data-measurement": "measured",
								children: t("run.result.measured", { speedup: speedup(result.measuredSpeedup) })
							}) : result.estimatedSpeedup !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
								"data-measurement": "estimated",
								children: t("run.result.estimated", { speedup: speedup(result.estimatedSpeedup) })
							}) : (0, react_jsx_runtime.jsx)("span", {
								"data-measurement": "pending",
								children: t("run.result.unmeasured")
							}),
							result.bestImproved === true ? (0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.promotedBadge,
								children: t("run.result.promoted")
							}) : result.bestImproved === false ? (0, react_jsx_runtime.jsx)("span", { children: t("run.result.incumbentRetained") }) : null,
							result.incumbentCycles !== void 0 ? (0, react_jsx_runtime.jsx)("span", { children: t("run.result.incumbentCycles", { cycles: result.incumbentCycles.toLocaleString() }) }) : null,
							result.verification === "failed" && result.estimatedSpeedup !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.excludedBadge,
								children: t("run.result.estimateExcluded")
							}) : null
						]
					}),
					result.candidates.length > 0 ? (0, react_jsx_runtime.jsx)("ul", {
						className: _dsh_css_64557083eb0f58b9_default.candidates,
						children: result.candidates.map((candidate) => (0, react_jsx_runtime.jsxs)("li", {
							className: _dsh_css_64557083eb0f58b9_default.candidate,
							"data-selected": candidate.id === result.selectedCandidateId,
							children: [
								(0, react_jsx_runtime.jsx)("span", {
									className: _dsh_css_64557083eb0f58b9_default.mono,
									children: candidate.id
								}),
								candidate.id === result.selectedCandidateId && result.measuredCycles !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
									"data-measurement": "measured",
									children: t("run.result.cyclesMeasured", { cycles: result.measuredCycles.toLocaleString() })
								}) : candidate.expectedCycles !== void 0 ? (0, react_jsx_runtime.jsx)("span", { children: t("run.result.cyclesEstimated", { cycles: candidate.expectedCycles.toLocaleString() }) }) : null,
								candidate.id === result.selectedCandidateId ? (0, react_jsx_runtime.jsx)("span", { children: t("run.result.chosen") }) : null
							]
						}, candidate.id))
					}) : null
				]
			});
		}
		function workflowResultOf(view) {
			const nested = view.result;
			const candidates = view.candidates ?? nested?.candidates ?? [];
			const stage = view.candidateStage ?? nested?.stage;
			const verification = view.verification ?? nested?.verification;
			const failureKind = view.failureKind ?? nested?.failureKind;
			const selectedCandidateId = view.selectedCandidateId ?? nested?.selectedCandidateId;
			const expectedCycles = view.expectedCycles ?? nested?.expectedCycles;
			const measuredBaselineCycles = view.measuredBaselineCycles ?? nested?.measuredBaselineCycles;
			const measuredCycles = view.measuredCycles ?? nested?.measuredCycles;
			const estimatedSpeedup = view.estimatedSpeedup ?? nested?.estimatedSpeedup;
			const measuredSpeedup = view.measuredSpeedup ?? nested?.measuredSpeedup;
			const incumbentCycles = view.incumbentCycles ?? nested?.incumbentCycles;
			const incumbentSpeedup = view.incumbentSpeedup ?? nested?.incumbentSpeedup;
			const bestImproved = view.bestImproved ?? nested?.bestImproved;
			if (stage === void 0 && verification === void 0 && selectedCandidateId === void 0 && expectedCycles === void 0 && measuredBaselineCycles === void 0 && measuredCycles === void 0 && estimatedSpeedup === void 0 && measuredSpeedup === void 0 && candidates.length === 0) return void 0;
			return {
				...stage === void 0 ? {} : { stage },
				...verification === void 0 ? {} : { verification },
				...failureKind === void 0 ? {} : { failureKind },
				...selectedCandidateId === void 0 ? {} : { selectedCandidateId },
				...expectedCycles === void 0 ? {} : { expectedCycles },
				...measuredBaselineCycles === void 0 ? {} : { measuredBaselineCycles },
				...measuredCycles === void 0 ? {} : { measuredCycles },
				...estimatedSpeedup === void 0 ? {} : { estimatedSpeedup },
				...measuredSpeedup === void 0 ? {} : { measuredSpeedup },
				...incumbentCycles === void 0 ? {} : { incumbentCycles },
				...incumbentSpeedup === void 0 ? {} : { incumbentSpeedup },
				...bestImproved === void 0 ? {} : { bestImproved },
				candidates
			};
		}
		function RunDetail({ row, view, session, sessionDetail, crossWorkspace, state, loadCallDetail, t }) {
			const result = workflowResultOf(view);
			const workflowWaiting = view.status === "completed" && session?.lifecycle === "active" && result?.stage === "awaiting_host_verification";
			const statusLabel = workflowWaiting ? t("run.workflowCompletedHostPending") : view.status === "completed" && session?.lifecycle === "active" ? t("run.workflowCompletedSessionActive") : t(RUN_STATUS_KEYS[view.status]);
			return (0, react_jsx_runtime.jsxs)("div", {
				className: _dsh_css_64557083eb0f58b9_default.runDetail,
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: _dsh_css_64557083eb0f58b9_default.runHead,
						children: [
							(0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.workflowIdentity,
								title: view.runDir,
								children: runDisplayLabel(row, session)
							}),
							(0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.runId,
								title: view.runDir,
								children: view.runId
							}),
							crossWorkspace ? (0, react_jsx_runtime.jsx)("span", {
								className: _dsh_css_64557083eb0f58b9_default.workspaceBadge,
								children: t("session.otherWorkspace")
							}) : null,
							(0, react_jsx_runtime.jsxs)("span", {
								className: _dsh_css_64557083eb0f58b9_default.statusTail,
								"data-status": view.status,
								children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: workflowWaiting ? "ongoing" : runDotState(view.status) }), (0, react_jsx_runtime.jsx)("span", { children: statusLabel })]
							})
						]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: _dsh_css_64557083eb0f58b9_default.runMeta,
						children: [
							view.currentPhase.length > 0 ? (0, react_jsx_runtime.jsx)("span", { children: t("run.currentPhase", { phase: view.currentPhase }) }) : null,
							(0, react_jsx_runtime.jsx)("span", { children: t("run.calls", { calls: view.totals.calls }) }),
							view.totals.tokens > 0 ? (0, react_jsx_runtime.jsx)("span", { children: t("run.tokens", { tokens: view.totals.tokens.toLocaleString() }) }) : null
						]
					}),
					view.error !== void 0 ? (0, react_jsx_runtime.jsx)("div", {
						className: _dsh_css_64557083eb0f58b9_default.runError,
						children: t("run.error", { message: view.error })
					}) : null,
					view.phases.length > 0 ? (0, react_jsx_runtime.jsx)(WorkflowTree, {
						row,
						view,
						session,
						sessionDetail,
						state,
						loadCallDetail,
						t
					}) : null,
					result !== void 0 ? (0, react_jsx_runtime.jsx)(WorkflowResult, {
						result,
						t
					}) : null
				]
			});
		}
		function LauncherControls({ launcher, busy, start, stop, t }) {
			const labels = new Map(launcher.tasks.map((task) => [task.id, task.label]));
			return (0, react_jsx_runtime.jsxs)("section", {
				className: _dsh_css_64557083eb0f58b9_default.launcher,
				"aria-label": t("launcher.title"),
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: _dsh_css_64557083eb0f58b9_default.launcherHead,
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: _dsh_css_64557083eb0f58b9_default.launcherTitle,
							children: t("launcher.title")
						}), launcher.active.length > 0 ? (0, react_jsx_runtime.jsx)("span", {
							className: _dsh_css_64557083eb0f58b9_default.launcherSummary,
							children: t("launcher.running", { count: launcher.active.length })
						}) : null]
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: _dsh_css_64557083eb0f58b9_default.taskList,
						children: launcher.tasks.map((task) => {
							const key = `start:${task.id}`;
							return (0, react_jsx_runtime.jsxs)("div", {
								className: _dsh_css_64557083eb0f58b9_default.taskRow,
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: _dsh_css_64557083eb0f58b9_default.taskLabel,
									children: task.label
								}), (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: _dsh_css_64557083eb0f58b9_default.controlButton,
									disabled: busy !== void 0,
									onClick: () => {
										start(task.id);
									},
									"data-busy": busy === key,
									children: t("launcher.start")
								})]
							}, task.id);
						})
					}),
					launcher.active.length > 0 ? (0, react_jsx_runtime.jsx)("div", {
						className: _dsh_css_64557083eb0f58b9_default.activeList,
						children: launcher.active.map((launch) => (0, react_jsx_runtime.jsxs)("div", {
							className: _dsh_css_64557083eb0f58b9_default.activeRow,
							children: [
								(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: "ongoing" }),
								(0, react_jsx_runtime.jsxs)("span", {
									className: _dsh_css_64557083eb0f58b9_default.activeLabel,
									title: launch.runDir,
									children: [labels.get(launch.taskId) ?? launch.taskId, (0, react_jsx_runtime.jsx)("span", {
										className: _dsh_css_64557083eb0f58b9_default.activeRunId,
										children: launch.runId
									})]
								}),
								(0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: _dsh_css_64557083eb0f58b9_default.controlButton,
									disabled: busy !== void 0,
									onClick: () => {
										stop(launch.runDir);
									},
									"data-busy": busy === `stop:${launch.runDir}`,
									children: t("launcher.stop")
								})
							]
						}, launch.runDir))
					}) : null,
					launcher.error !== void 0 ? (0, react_jsx_runtime.jsx)("div", {
						className: _dsh_css_64557083eb0f58b9_default.readError,
						children: t("launcher.error", { message: launcher.error })
					}) : null
				]
			});
		}
		function viewerHealth(snapshot) {
			const roots = snapshot.diagnostics.scan.roots;
			const readers = snapshot.diagnostics.runs;
			const rootIssues = roots.flatMap((root) => root.lastIssue === void 0 ? [] : [root.lastIssue]);
			const runIssues = readers.flatMap((run) => run.lastIssue === void 0 ? [] : [run.lastIssue]);
			const classicIssue = snapshot.classic.source.lastIssue;
			const issues = [
				...rootIssues,
				...runIssues,
				...classicIssue === void 0 ? [] : [classicIssue]
			];
			const classicFailed = snapshot.classic.source.state === "failed";
			const degraded = snapshot.diagnostics.scan.state === "degraded" || snapshot.diagnostics.scan.state === "failed" || classicFailed || snapshot.classic.source.state === "degraded" || readers.some((run) => run.state === "degraded" || run.state === "failed");
			const noReadableSource = snapshot.diagnostics.scan.state === "failed" && snapshot.classic.source.state !== "healthy" && snapshot.classic.source.state !== "degraded";
			const issue = snapshot.diagnostics.scan.lastIssue ?? classicIssue ?? runIssues.at(-1);
			return {
				state: noReadableSource ? "failed" : degraded ? "degraded" : "healthy",
				roots: roots.length,
				readers: readers.length,
				sources: issues.length,
				...issue === void 0 ? {} : { issue }
			};
		}
		/** First-class KerSor view rendered beside Chat and Trajectory. */
		function KersorView({ t, store, currentWorkspace, refresh, loadRun, loadCallDetail, loadClassic, start, stop }) {
			const [busy, setBusy] = (0, react.useState)();
			const state = (0, react.useSyncExternalStore)(store.subscribe, store.getSnapshot);
			const rows = store.rows;
			const classicSessions = state.snapshot?.classic.sessions ?? [];
			const visibleRows = store.selectedClassicSessionDir === void 0 ? rows : rows.filter((row) => row.sessionDir === store.selectedClassicSessionDir);
			const health = state.snapshot === void 0 ? void 0 : viewerHealth(state.snapshot);
			(0, react.useEffect)(() => {
				refresh();
			}, [refresh]);
			(0, react.useEffect)(() => {
				if (store.selectionIntent !== "follow") return;
				const currentRows = rows.filter((row) => belongsToWorkspace(row.sessionDir, currentWorkspace));
				const target = currentRows.find((row) => row.discovery === "active") ?? currentRows[0] ?? rows.find((row) => row.discovery === "active") ?? rows[0];
				if (target === void 0 || !store.followDiscoveredRun(target.runDir)) return;
				loadRun(target.runDir);
			}, [
				currentWorkspace,
				loadRun,
				rows,
				store
			]);
			const runStart = async (taskId) => {
				setBusy(`start:${taskId}`);
				try {
					await start(taskId);
				} finally {
					setBusy(void 0);
				}
			};
			const runStop = async (runDir) => {
				setBusy(`stop:${runDir}`);
				try {
					await stop(runDir);
				} finally {
					setBusy(void 0);
				}
			};
			const toggleClassic = (sessionDir) => {
				if (store.selectedClassicSessionDir === sessionDir) {
					store.selectClassic(void 0);
					return;
				}
				const runDir = store.selectClassic(sessionDir);
				loadClassic(sessionDir);
				if (runDir !== void 0) loadRun(runDir);
			};
			return (0, react_jsx_runtime.jsxs)("section", {
				className: _dsh_css_64557083eb0f58b9_default.view,
				"data-conversation-composer-overlay": "",
				"data-selection-intent": store.selectionIntent,
				"aria-label": t("panel.title"),
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: _dsh_css_64557083eb0f58b9_default.header,
					children: [(0, react_jsx_runtime.jsx)("span", {
						className: _dsh_css_64557083eb0f58b9_default.title,
						children: t("panel.title")
					}), store.selectionIntent === "manual" ? (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: _dsh_css_64557083eb0f58b9_default.followButton,
						onClick: () => {
							store.followLatest();
						},
						children: t("panel.followLatest")
					}) : (0, react_jsx_runtime.jsx)("span", {
						className: _dsh_css_64557083eb0f58b9_default.note,
						children: t("panel.hint")
					})]
				}), (0, react_jsx_runtime.jsxs)("div", {
					className: _dsh_css_64557083eb0f58b9_default.body,
					children: [
						state.launcher !== void 0 ? (0, react_jsx_runtime.jsx)(LauncherControls, {
							launcher: state.launcher,
							busy,
							start: runStart,
							stop: runStop,
							t
						}) : null,
						state.transportError !== void 0 ? (0, react_jsx_runtime.jsx)("div", {
							className: _dsh_css_64557083eb0f58b9_default.readError,
							children: t("panel.readFailed", { message: state.transportError })
						}) : null,
						health !== void 0 && health.state !== "healthy" ? (0, react_jsx_runtime.jsx)("div", {
							className: _dsh_css_64557083eb0f58b9_default.readError,
							"data-source-health": health.state,
							children: t(health.state === "failed" ? "panel.sourcesFailed" : "panel.sourcesDegraded", {
								roots: health.roots,
								readers: health.readers,
								sources: health.sources,
								stage: health.issue?.stage ?? "source",
								code: health.issue?.code ?? "unavailable",
								occurrences: health.issue?.occurrences ?? 1
							})
						}) : null,
						state.loading ? (0, react_jsx_runtime.jsx)("div", {
							className: _dsh_css_64557083eb0f58b9_default.note,
							children: t("panel.loading")
						}) : null,
						!state.loading && state.transportError === void 0 && health?.state === "healthy" && rows.length === 0 && classicSessions.length === 0 ? (0, react_jsx_runtime.jsx)("div", {
							className: _dsh_css_64557083eb0f58b9_default.note,
							children: t("panel.empty", { roots: health.roots })
						}) : null,
						classicSessions.length > 0 ? (0, react_jsx_runtime.jsxs)("section", {
							className: _dsh_css_64557083eb0f58b9_default.activitySection,
							"aria-label": t("session.title"),
							children: [(0, react_jsx_runtime.jsxs)("div", {
								className: _dsh_css_64557083eb0f58b9_default.sectionHead,
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: _dsh_css_64557083eb0f58b9_default.sectionTitle,
									children: t("session.title")
								}), (0, react_jsx_runtime.jsx)("span", {
									className: _dsh_css_64557083eb0f58b9_default.sectionSummary,
									children: t("session.summary", {
										count: classicSessions.length,
										active: classicSessions.filter((session) => session.health === "active").length
									})
								})]
							}), (0, react_jsx_runtime.jsx)("ul", {
								className: _dsh_css_64557083eb0f58b9_default.classicRows,
								children: classicSessions.map((session) => (0, react_jsx_runtime.jsx)(ClassicSessionRow, {
									session,
									selected: store.selectedClassicSessionDir === session.session_dir,
									crossWorkspace: !belongsToWorkspace(session.session_dir, currentWorkspace),
									loading: state.classicDetailLoading === session.session_dir,
									...state.classicDetails.get(session.session_dir) === void 0 ? {} : { detail: state.classicDetails.get(session.session_dir) },
									...state.classicDetailError?.startsWith(`${session.session_dir}: `) === true ? { error: state.classicDetailError.slice(session.session_dir.length + 2) } : {},
									onToggle: () => {
										toggleClassic(session.session_dir);
									},
									t
								}, session.session_dir))
							})]
						}) : null,
						visibleRows.length > 0 ? (0, react_jsx_runtime.jsxs)("section", {
							className: _dsh_css_64557083eb0f58b9_default.activitySection,
							"aria-label": t("run.sectionTitle"),
							children: [(0, react_jsx_runtime.jsxs)("div", {
								className: _dsh_css_64557083eb0f58b9_default.sectionHead,
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: _dsh_css_64557083eb0f58b9_default.sectionTitle,
									children: t("run.sectionTitle")
								}), (0, react_jsx_runtime.jsx)("span", {
									className: _dsh_css_64557083eb0f58b9_default.sectionSummary,
									children: visibleRows.length
								})]
							}), (0, react_jsx_runtime.jsx)("ul", {
								className: _dsh_css_64557083eb0f58b9_default.rows,
								children: visibleRows.map((row) => {
									const session = classicSessions.find((candidate) => candidate.session_dir === row.sessionDir);
									const crossWorkspace = !belongsToWorkspace(row.sessionDir, currentWorkspace);
									return (0, react_jsx_runtime.jsxs)("li", {
										className: _dsh_css_64557083eb0f58b9_default.row,
										"data-run-status": row.discovery,
										children: [(0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: _dsh_css_64557083eb0f58b9_default.rowHead,
											"aria-pressed": store.selectedRunDir === row.runDir,
											onClick: () => {
												const next = store.selectedRunDir === row.runDir ? void 0 : row.runDir;
												store.select(next);
												if (next !== void 0) {
													loadRun(next);
													if (session !== void 0) loadClassic(row.sessionDir);
												}
											},
											children: [
												(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: row.discovery === "active" ? "ongoing" : row.discovery === "failed" ? "error" : row.discovery === "waiting" ? "warning" : "done" }),
												(0, react_jsx_runtime.jsx)("span", {
													className: _dsh_css_64557083eb0f58b9_default.rowLabel,
													children: runDisplayLabel(row, session)
												}),
												(0, react_jsx_runtime.jsx)("span", {
													className: _dsh_css_64557083eb0f58b9_default.runId,
													children: row.runId
												}),
												crossWorkspace ? (0, react_jsx_runtime.jsx)("span", {
													className: _dsh_css_64557083eb0f58b9_default.workspaceBadge,
													children: t("session.otherWorkspace")
												}) : null
											]
										}), store.selectedRunDir === row.runDir && row.view !== void 0 ? (0, react_jsx_runtime.jsx)(RunDetail, {
											row,
											view: row.view,
											session,
											sessionDetail: state.classicDetails.get(row.sessionDir),
											crossWorkspace,
											state,
											loadCallDetail,
											t
										}) : null]
									}, row.runDir);
								})
							})]
						}) : null
					]
				})]
			});
		}
		//#endregion
		//#region \0dsh-css:5e80a47b73f6677b.mjs
		const css = ".Y4TV_G_card{border:1px solid var(--dsw-alias-border-normal,#d9dce3);background:var(--dsw-alias-bg-module-platform,#fff);border-radius:12px;margin:8px 0 14px;padding:14px}.Y4TV_G_header,.Y4TV_G_footer,.Y4TV_G_facts{align-items:center;display:flex}.Y4TV_G_header{justify-content:space-between;gap:12px}.Y4TV_G_eyebrow{color:var(--dsw-alias-fg-secondary,#667085);font-size:12px}.Y4TV_G_title{margin-top:2px;font-weight:650}.Y4TV_G_status{background:var(--dsw-alias-bg-base-hover,#f2f4f7);border-radius:999px;padding:3px 8px;font-size:12px}.Y4TV_G_objective,.Y4TV_G_next{margin:10px 0 0;line-height:1.45}.Y4TV_G_facts{color:var(--dsw-alias-fg-secondary,#667085);flex-wrap:wrap;gap:6px 12px;margin-top:10px;font-size:12px}.Y4TV_G_progress{margin-top:12px}.Y4TV_G_progressTrack{background:var(--dsw-alias-bg-base-hover,#eaecf0);border-radius:999px;height:4px;overflow:hidden}.Y4TV_G_progressTrack>span{border-radius:inherit;background:var(--dsw-alias-fg-business-primary,#4f46e5);height:100%;transition:width .16s;display:block}.Y4TV_G_steps{grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:8px;margin:10px 0 0;padding:0;font-size:12px;list-style:none;display:grid}.Y4TV_G_steps li{align-items:center;gap:6px;min-width:0;display:flex}.Y4TV_G_dot{background:#98a2b3;border-radius:50%;flex:none;width:8px;height:8px}.Y4TV_G_steps li[data-step-status=active] .Y4TV_G_dot{background:#f79009}.Y4TV_G_steps li[data-step-status=completed] .Y4TV_G_dot{background:#12b76a}.Y4TV_G_steps li[data-step-status=failed] .Y4TV_G_dot{background:#f04438}.Y4TV_G_next{background:var(--dsw-alias-bg-base-hover,#f7f8fa);border-radius:8px;padding:8px 10px;font-size:13px}.Y4TV_G_footer{justify-content:space-between;gap:12px;margin-top:12px}.Y4TV_G_open{border:1px solid var(--dsw-alias-border-normal,#d0d5dd);color:inherit;cursor:pointer;background:0 0;border-radius:8px;padding:6px 10px}.Y4TV_G_open:disabled{cursor:default;opacity:.5}.Y4TV_G_footer code{color:var(--dsw-alias-fg-secondary,#667085);text-overflow:ellipsis;white-space:nowrap;font-size:10px;overflow:hidden}";
		const tagId = "@deepseek-ai/dsh-client-ui-kersor-viewer/KersorExperimentNode.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-kersor-viewer";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var _dsh_css_5e80a47b73f6677b_default = {
			"card": "Y4TV_G_card",
			"dot": "Y4TV_G_dot",
			"eyebrow": "Y4TV_G_eyebrow",
			"facts": "Y4TV_G_facts",
			"footer": "Y4TV_G_footer",
			"header": "Y4TV_G_header",
			"next": "Y4TV_G_next",
			"objective": "Y4TV_G_objective",
			"open": "Y4TV_G_open",
			"progress": "Y4TV_G_progress",
			"progressTrack": "Y4TV_G_progressTrack",
			"status": "Y4TV_G_status",
			"steps": "Y4TV_G_steps",
			"title": "Y4TV_G_title"
		};
		//#endregion
		//#region lib/types/client/KersorExperimentNode.js
		const STATUS_KEYS = {
			provisioning: "experiment.status.provisioning",
			running: "experiment.status.running",
			waiting: "experiment.status.waiting",
			blocked: "experiment.status.blocked",
			completed: "experiment.status.completed",
			cancelled: "experiment.status.cancelled"
		};
		/** Render one stable experiment summary and its durable child-conversation link. */
		function KersorExperimentNode({ node, openController, t }) {
			const data = node.data;
			const complete = data.steps.filter((step) => step.status === "completed").length;
			const progress = data.steps.length === 0 ? 0 : Math.round(complete * 100 / data.steps.length);
			const round = data.currentRound === void 0 ? null : data.maxWorkflows === void 0 ? t("experiment.roundOpen", { current: data.currentRound }) : t("experiment.round", {
				current: data.currentRound,
				maximum: data.maxWorkflows
			});
			return (0, react_jsx_runtime.jsxs)("article", {
				className: _dsh_css_5e80a47b73f6677b_default.card,
				"data-experiment-status": data.status,
				children: [
					(0, react_jsx_runtime.jsxs)("header", {
						className: _dsh_css_5e80a47b73f6677b_default.header,
						children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("div", {
							className: _dsh_css_5e80a47b73f6677b_default.eyebrow,
							children: t("experiment.title")
						}), (0, react_jsx_runtime.jsx)("div", {
							className: _dsh_css_5e80a47b73f6677b_default.title,
							children: data.kersorSessionId ?? data.experimentId
						})] }), (0, react_jsx_runtime.jsx)("span", {
							className: _dsh_css_5e80a47b73f6677b_default.status,
							children: t(STATUS_KEYS[data.status])
						})]
					}),
					(0, react_jsx_runtime.jsx)("p", {
						className: _dsh_css_5e80a47b73f6677b_default.objective,
						children: data.objective
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: _dsh_css_5e80a47b73f6677b_default.facts,
						children: [
							data.phase === void 0 ? null : (0, react_jsx_runtime.jsx)("span", { children: t("experiment.phase", { phase: data.phase }) }),
							round === null ? null : (0, react_jsx_runtime.jsx)("span", { children: round }),
							data.workflow === void 0 ? null : (0, react_jsx_runtime.jsx)("span", { children: t("experiment.workflow", { workflow: data.workflow }) }),
							data.bestSpeedup === void 0 ? null : (0, react_jsx_runtime.jsx)("span", { children: t("experiment.best", { speedup: data.bestSpeedup }) })
						]
					}),
					data.steps.length === 0 ? null : (0, react_jsx_runtime.jsxs)("div", {
						className: _dsh_css_5e80a47b73f6677b_default.progress,
						children: [(0, react_jsx_runtime.jsx)("div", {
							className: _dsh_css_5e80a47b73f6677b_default.progressTrack,
							"aria-label": t("experiment.progress", { progress }),
							children: (0, react_jsx_runtime.jsx)("span", { style: { width: `${progress}%` } })
						}), (0, react_jsx_runtime.jsx)("ol", {
							className: _dsh_css_5e80a47b73f6677b_default.steps,
							children: data.steps.map((step) => (0, react_jsx_runtime.jsxs)("li", {
								"data-step-status": step.status,
								children: [(0, react_jsx_runtime.jsx)("span", { className: _dsh_css_5e80a47b73f6677b_default.dot }), (0, react_jsx_runtime.jsx)("span", { children: t(`detail.step.${step.id}`) })]
							}, step.id))
						})]
					}),
					data.nextAction === void 0 ? null : (0, react_jsx_runtime.jsxs)("p", {
						className: _dsh_css_5e80a47b73f6677b_default.next,
						children: [
							(0, react_jsx_runtime.jsx)("strong", { children: t("experiment.next") }),
							" ",
							data.nextAction
						]
					}),
					(0, react_jsx_runtime.jsxs)("footer", {
						className: _dsh_css_5e80a47b73f6677b_default.footer,
						children: [(0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: _dsh_css_5e80a47b73f6677b_default.open,
							disabled: data.status === "provisioning",
							onClick: () => {
								openController(data.childSessionId);
							},
							children: t("experiment.openController")
						}), (0, react_jsx_runtime.jsx)("code", { children: data.childSessionId })]
					})
				]
			});
		}
		//#endregion
		//#region lib/types/client/experiment-definition.js
		/** Durable KerSor Experiment Conversation Node definition. */
		function checkpointClosed(checkpoint) {
			return checkpoint.phase === "stalled" || checkpoint.status === "blocked" || checkpoint.status === "completed" || checkpoint.status === "cancelled";
		}
		function project(context) {
			const state = context.state;
			if (state === void 0) throw new Error("kersor-experiment projection requires start state");
			const { start, checkpoint } = state;
			const status = checkpoint?.phase === "stalled" ? "blocked" : checkpoint?.status ?? "provisioning";
			return {
				experimentId: start.experimentId,
				childSessionId: start.childSessionId,
				objective: start.objective,
				origin: start.origin,
				freshSession: start.freshSession,
				revision: checkpoint?.revision ?? 0,
				status,
				...checkpoint?.kersorSessionId === void 0 ? {} : { kersorSessionId: checkpoint.kersorSessionId },
				...checkpoint?.phase === void 0 ? {} : { phase: checkpoint.phase },
				...checkpoint?.currentRound === void 0 ? {} : { currentRound: checkpoint.currentRound },
				...checkpoint?.maxWorkflows === void 0 ? {} : { maxWorkflows: checkpoint.maxWorkflows },
				...checkpoint?.workflow === void 0 ? {} : { workflow: checkpoint.workflow },
				...checkpoint?.bestSpeedup === void 0 ? {} : { bestSpeedup: checkpoint.bestSpeedup },
				...checkpoint?.targetSpeedup === void 0 ? {} : { targetSpeedup: checkpoint.targetSpeedup },
				...status === "blocked" || checkpoint?.nextAction === void 0 ? {} : { nextAction: checkpoint.nextAction },
				steps: checkpoint?.steps ?? []
			};
		}
		/** Experiment start plus monotonic latest-value checkpoints folded into one Chat node. */
		const kersorExperimentDefinition = {
			kind: "kersor-experiment",
			target: "chat",
			match: (event) => {
				if (event.type === "kersor/experiment-start") return {
					id: String(event.data.experimentId),
					role: "start"
				};
				if (event.type === "kersor/experiment-checkpoint") return {
					id: String(event.data.experimentId),
					role: "update"
				};
				return null;
			},
			start: (_context, match) => {
				if (match.event.type !== "kersor/experiment-start") throw new Error("kersor-experiment start requires kersor/experiment-start");
				return { start: match.event.data };
			},
			update: (context, match) => {
				if (match.event.type !== "kersor/experiment-checkpoint") return context.state;
				const previous = context.state.checkpoint;
				if (match.event.data.childSessionId !== context.state.start.childSessionId || previous !== void 0 && (checkpointClosed(previous) || match.event.data.revision <= previous.revision)) return context.state;
				return {
					...context.state,
					checkpoint: match.event.data
				};
			},
			publication: () => "immediate",
			buildViewNode: (context) => {
				if (context.start === void 0) return null;
				return {
					key: context.key,
					kind: "kersor-experiment",
					id: context.id,
					target: "chat",
					anchorSeq: context.start.event.seq,
					location: context.start.location,
					visibility: "visible",
					data: project(context)
				};
			}
		};
		//#endregion
		//#region lib/types/client/store.js
		/**
		* Browser-side KerSor viewer store. One Host snapshot owns inventory,
		* classic Sessions, and source health; folded run views and launcher process
		* ownership remain orthogonal client-side accounts.
		* @module @deepseek-ai/dsh-client-ui-kersor-viewer/client
		*/
		/** Snapshot store over the Host projection and per-run folded views. */
		var KersorViewerStore = class {
			state = {
				views: /* @__PURE__ */ new Map(),
				classicDetails: /* @__PURE__ */ new Map(),
				callDetails: /* @__PURE__ */ new Map(),
				loading: true
			};
			listeners = /* @__PURE__ */ new Set();
			selected;
			selectedClassic;
			intent = "follow";
			/** Stable snapshot for useSyncExternalStore. */
			getSnapshot = () => this.state;
			/** Subscribe to snapshot replacements. */
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			};
			/** Latest run inventory joined with independently folded views. */
			get rows() {
				return (this.state.snapshot?.runs ?? []).map((ref) => ({
					...ref,
					view: this.withInventoryResult(ref.runDir, this.state.views.get(ref.runDir))
				}));
			}
			/** Currently selected run directory (panel-local choice). */
			get selectedRunDir() {
				return this.selected;
			}
			/** Currently expanded classic Session directory. */
			get selectedClassicSessionDir() {
				return this.selectedClassic;
			}
			/** Whether new active runs may replace the current browser-local selection. */
			get selectionIntent() {
				return this.intent;
			}
			/**
			* Select one experiment and its newest discovered run as one explicit UI choice.
			* @param sessionDir - Selected Session directory, or `undefined` to collapse.
			* @returns The newest matching run directory, when the Host discovered one.
			*/
			selectClassic(sessionDir) {
				const runDir = sessionDir === void 0 ? void 0 : [...this.state.snapshot?.runs ?? []].filter((ref) => ref.sessionDir === sessionDir).sort((left, right) => (right.round ?? 0) - (left.round ?? 0))[0]?.runDir;
				this.setSelection(runDir, sessionDir, "manual");
				return runDir;
			}
			/**
			* Select a run and its owning experiment, disabling automatic selection until resumed.
			* @param runDir - Exact discovered run directory, or `undefined` to clear selection.
			*/
			select(runDir) {
				const ref = this.state.snapshot?.runs.find((candidate) => candidate.runDir === runDir);
				this.setSelection(runDir, runDir === void 0 || ref?.kind === "general-task" ? void 0 : ref?.sessionDir, "manual");
			}
			/**
			* Follow one Host-discovered run without turning automatic selection into a user choice.
			* @param runDir - Exact run selected by the view's current-Workspace policy.
			* @returns `true` only when the selected run or owning Session changed.
			*/
			followDiscoveredRun(runDir) {
				const ref = this.state.snapshot?.runs.find((candidate) => candidate.runDir === runDir);
				return this.setSelection(runDir, ref?.kind === "general-task" ? void 0 : ref?.sessionDir, "follow");
			}
			/** Resume automatic selection after an explicit run or Session choice. */
			followLatest() {
				this.setSelection(this.selected, this.selectedClassic, "follow");
			}
			/**
			* Resolve one previously loaded call detail.
			* @param runDir - Exact discovered run directory.
			* @param callId - Exact folded call identity.
			* @returns Cached detail, or `undefined` before a successful load.
			*/
			callDetail(runDir, callId) {
				return this.state.callDetails.get(callDetailKey(runDir, callId));
			}
			/** Selected folded view, falling back to a real available run view. */
			get activeView() {
				if (this.selected !== void 0) return this.state.views.get(this.selected);
				const active = this.state.snapshot?.runs.find((ref) => ref.discovery === "active");
				if (active !== void 0) return this.state.views.get(active.runDir);
				for (const ref of this.state.snapshot?.runs ?? []) {
					const view = this.state.views.get(ref.runDir);
					if (view !== void 0) return view;
				}
			}
			/**
			* Atomically replace inventory, classic Sessions, and diagnostics.
			* @param snapshot - Complete Host projection from one committed scan.
			*/
			setSnapshot(snapshot) {
				const live = new Set(snapshot.runs.map((ref) => ref.runDir));
				const views = new Map([...this.state.views].filter(([runDir]) => live.has(runDir)));
				const liveClassic = new Set(snapshot.classic.sessions.map((session) => session.session_dir));
				const classicDetails = new Map([...this.state.classicDetails].filter(([sessionDir]) => liveClassic.has(sessionDir)));
				const callDetails = new Map([...this.state.callDetails].filter(([key]) => [...live].some((runDir) => key.startsWith(`${runDir}\u0000`))));
				if (this.selectedClassic !== void 0 && !liveClassic.has(this.selectedClassic)) this.selectedClassic = void 0;
				if (this.selected !== void 0 && !live.has(this.selected)) this.selected = void 0;
				const { transportError: _, ...state } = this.state;
				const loading = this.state.snapshot === void 0 && (snapshot.diagnostics.scan.state === "never" || snapshot.diagnostics.scan.state === "running");
				this.state = {
					...state,
					snapshot,
					views,
					classicDetails,
					callDetails,
					loading
				};
				this.emit();
			}
			/**
			* Record a Remote/connection failure without overwriting Host diagnostics.
			* @param message - Bounded transport diagnostic shown to the user.
			*/
			setTransportError(message) {
				this.state = {
					...this.state,
					loading: false,
					transportError: message
				};
				this.emit();
			}
			/**
			* Mark one selected classic Session detail as loading.
			* @param sessionDir - Session whose on-demand detail is loading.
			*/
			setClassicDetailLoading(sessionDir) {
				const { classicDetailError: _, ...state } = this.state;
				this.state = {
					...state,
					classicDetailLoading: sessionDir
				};
				this.emit();
			}
			/**
			* Store one successful classic Session detail answer.
			* @param sessionDir - Session owning the answer.
			* @param detail - Valid inspector detail, or `undefined` when unavailable.
			*/
			setClassicDetail(sessionDir, detail) {
				const { classicDetailLoading: _, classicDetailError: __, ...state } = this.state;
				const classicDetails = new Map(state.classicDetails);
				if (detail === void 0) classicDetails.delete(sessionDir);
				else classicDetails.set(sessionDir, detail);
				this.state = {
					...state,
					classicDetails
				};
				this.emit();
			}
			/**
			* Record a bounded detail-read failure without replacing the summary snapshot.
			* @param sessionDir - Session whose detail failed.
			* @param message - Remote transport diagnostic.
			*/
			setClassicDetailError(sessionDir, message) {
				const { classicDetailLoading: _, ...state } = this.state;
				this.state = {
					...state,
					classicDetailError: `${sessionDir}: ${message}`
				};
				this.emit();
			}
			/**
			* Mark one call detail as loading.
			* @param runDir - Exact discovered run directory.
			* @param callId - Exact folded call identity.
			*/
			setCallDetailLoading(runDir, callId) {
				const { callDetailError: _, ...state } = this.state;
				this.state = {
					...state,
					callDetailLoading: callDetailKey(runDir, callId)
				};
				this.emit();
			}
			/**
			* Store one successful bounded call-detail answer.
			* @param runDir - Exact discovered run directory.
			* @param callId - Exact folded call identity.
			* @param detail - Bounded answer, or `undefined` when artifacts are unavailable.
			*/
			setCallDetail(runDir, callId, detail) {
				const { callDetailLoading: _, callDetailError: __, ...state } = this.state;
				const callDetails = new Map(state.callDetails);
				const key = callDetailKey(runDir, callId);
				if (detail === void 0) callDetails.delete(key);
				else callDetails.set(key, detail);
				this.state = {
					...state,
					callDetails
				};
				this.emit();
			}
			/**
			* Record a call-detail transport failure without replacing run progress.
			* @param runDir - Exact discovered run directory.
			* @param callId - Exact folded call identity.
			* @param message - Remote transport diagnostic.
			*/
			setCallDetailError(runDir, callId, message) {
				const { callDetailLoading: _, ...state } = this.state;
				this.state = {
					...state,
					callDetailError: `${callDetailKey(runDir, callId)}: ${message}`
				};
				this.emit();
			}
			/**
			* Replace the optional launcher's configured-task and owned-process inventory.
			* @param tasks - Deployment-configured tasks exposed by the Host.
			* @param active - Processes currently owned by the launcher service.
			*/
			setLauncher(tasks, active) {
				this.state = {
					...this.state,
					launcher: {
						tasks,
						active
					}
				};
				this.emit();
			}
			/** Hide controls when the Host launcher plugin is not loaded. */
			setLauncherUnavailable() {
				if (this.state.launcher === void 0) return;
				const { launcher: _, ...state } = this.state;
				this.state = state;
				this.emit();
			}
			/**
			* Record a launch/stop failure without contaminating viewer read state.
			* @param message - Bounded launcher failure text.
			*/
			setLauncherError(message) {
				if (this.state.launcher === void 0) return;
				this.state = {
					...this.state,
					launcher: {
						...this.state.launcher,
						error: message
					}
				};
				this.emit();
			}
			/**
			* Apply the Host launcher's complete owned-process replacement frame.
			* @param frame - Complete active-launch replacement.
			*/
			applyActiveFrame(frame) {
				if (this.state.launcher === void 0) return;
				this.state = {
					...this.state,
					launcher: {
						...this.state.launcher,
						active: frame.launches
					}
				};
				this.emit();
			}
			/**
			* Apply one forwarded Host frame.
			* @param frame - Atomic snapshot replacement or one folded run update.
			*/
			applyFrame(frame) {
				if (frame.kind === "snapshot") {
					this.setSnapshot(frame.snapshot);
					return;
				}
				const views = new Map(this.state.views);
				views.set(frame.run.runDir, this.withInventoryResult(frame.run.runDir, frame.run) ?? frame.run);
				this.state = {
					...this.state,
					views,
					loading: false
				};
				this.emit();
			}
			/**
			* Store a successful `runBacklog` answer; undefined never fabricates zeros.
			* @param runDir - Exact discovered run directory.
			* @param view - Folded backlog, or `undefined` when unavailable.
			*/
			setBacklog(runDir, view) {
				if (view === void 0) return;
				const views = new Map(this.state.views);
				views.set(runDir, this.withInventoryResult(runDir, view) ?? view);
				this.state = {
					...this.state,
					views,
					loading: false
				};
				this.emit();
			}
			/**
			* Attach one separately loaded bounded Workflow result to its folded run view.
			* @param runDir - Exact discovered run directory.
			* @param result - Candidate and Host verification projection, when available.
			*/
			setRunResult(runDir, result) {
				if (result === void 0) return;
				const existing = this.state.views.get(runDir);
				if (existing === void 0) return;
				const views = new Map(this.state.views);
				views.set(runDir, {
					...existing,
					result,
					candidateStage: result.stage,
					verification: result.verification,
					failureKind: result.failureKind,
					selectedCandidateId: result.selectedCandidateId,
					expectedCycles: result.expectedCycles,
					measuredBaselineCycles: result.measuredBaselineCycles,
					measuredCycles: result.measuredCycles,
					estimatedSpeedup: result.estimatedSpeedup,
					measuredSpeedup: result.measuredSpeedup,
					incumbentCycles: result.incumbentCycles,
					incumbentSpeedup: result.incumbentSpeedup,
					bestImproved: result.bestImproved,
					candidates: result.candidates
				});
				this.state = {
					...this.state,
					views
				};
				this.emit();
			}
			/** Drop connection-scoped state. */
			reset() {
				this.state = {
					views: /* @__PURE__ */ new Map(),
					classicDetails: /* @__PURE__ */ new Map(),
					callDetails: /* @__PURE__ */ new Map(),
					loading: true
				};
				this.selected = void 0;
				this.selectedClassic = void 0;
				this.intent = "follow";
				this.emit();
			}
			setSelection(runDir, sessionDir, intent) {
				if (this.selected === runDir && this.selectedClassic === sessionDir && this.intent === intent) return false;
				this.selected = runDir;
				this.selectedClassic = sessionDir;
				this.intent = intent;
				this.state = { ...this.state };
				this.emit();
				return true;
			}
			withInventoryResult(runDir, view) {
				if (view === void 0 || view.result !== void 0) return view;
				const result = this.state.snapshot?.runs.find((ref) => ref.runDir === runDir)?.result;
				return result === void 0 ? view : {
					...view,
					result,
					candidateStage: result.stage,
					verification: result.verification,
					failureKind: result.failureKind,
					selectedCandidateId: result.selectedCandidateId,
					expectedCycles: result.expectedCycles,
					measuredBaselineCycles: result.measuredBaselineCycles,
					measuredCycles: result.measuredCycles,
					estimatedSpeedup: result.estimatedSpeedup,
					measuredSpeedup: result.measuredSpeedup,
					incumbentCycles: result.incumbentCycles,
					incumbentSpeedup: result.incumbentSpeedup,
					bestImproved: result.bestImproved,
					candidates: result.candidates
				};
			}
			emit() {
				for (const listener of this.listeners) listener();
			}
		};
		function callDetailKey(runDir, callId) {
			return `${runDir}\u0000${callId}`;
		}
		//#endregion
		//#region lib/types/client/locales.js
		/** KerSor viewer UI dictionaries. */
		const NS = "kersorViewer";
		/** Simplified Chinese KerSor viewer messages. */
		const zh = {
			"view.kersor": "KerSor",
			"experiment.title": "KerSor 实验",
			"experiment.status.provisioning": "正在建立",
			"experiment.status.running": "运行中",
			"experiment.status.waiting": "等待恢复",
			"experiment.status.blocked": "已阻塞",
			"experiment.status.completed": "已完成",
			"experiment.status.cancelled": "已取消",
			"experiment.phase": "阶段：{phase}",
			"experiment.round": "第 {current}/{maximum} 轮",
			"experiment.roundOpen": "第 {current} 轮",
			"experiment.workflow": "Workflow：{workflow}",
			"experiment.best": "最佳：{speedup}x",
			"experiment.progress": "KerSor 实验进度 {progress}%",
			"experiment.next": "下一步：",
			"experiment.openController": "查看 DSH 执行对话",
			"panel.trigger": "KerSor 活动",
			"panel.title": "KerSor 活动",
			"panel.empty": "已扫描 {roots} 个来源，未发现 KerSor 优化会话或 Workflow 运行",
			"panel.loading": "读取中…",
			"panel.readFailed": "读取运行清单失败：{message}",
			"panel.sourcesDegraded": "仅显示可读取数据：{roots} 个根、{readers} 个 run reader、{sources} 个异常来源；最近 {stage}/{code}（{occurrences} 次）",
			"panel.sourcesFailed": "KerSor 来源读取失败：{roots} 个根、{readers} 个 run reader；最近 {stage}/{code}（{occurrences} 次）",
			"panel.hint": "优化会话摘要与 Workflow 实时进度",
			"panel.followLatest": "跟随最新活动",
			"session.title": "优化会话",
			"session.summary": "最近 {count} 个 · {active} 个活跃",
			"session.round": "第 {current}/{maximum} 轮",
			"session.roundOpen": "第 {current} 轮",
			"session.best": "最佳 {speedup}x",
			"session.target": "目标 {speedup}x",
			"session.authoring": "可创作 · 已用 {used}/{budget}",
			"session.freshGate": "从零隔离：{status}",
			"session.baselineGate": "基线见证：{status}",
			"session.profileGate": "Profile 证据：{status}",
			"session.profileOwner": "Profile 来源：{owner}",
			"session.profileBlocked": "Profile 阻塞",
			"session.baselineAction.init": "下一步：初始化基线方法",
			"session.baselineAction.recordVerify": "下一步：记录并验证基线",
			"session.baselineAction.newSession": "下一步：新建 Session 后重试",
			"session.dshGate": "DSH 兼容：{status}",
			"session.ownershipGate": "候选所有权：{status}",
			"session.gate.pass": "通过",
			"session.gate.fail": "失败",
			"session.gate.pending": "待验证",
			"session.gate.notRequired": "无需",
			"session.workflow": "Workflow：{workflow}",
			"session.fit": "适配度：{confidence}",
			"session.noWorkflow": "尚未选择 Workflow",
			"session.selectorStalled": "Selector：STALLED · 正在寻找逃生路径",
			"session.unknownPhase": "未知阶段",
			"session.lastActivity": "活动于 {time}",
			"session.health.active": "活跃",
			"session.health.stale": "已陈旧",
			"session.health.needsResume": "可恢复",
			"session.health.terminal": "已结束",
			"session.health.unknown": "状态未知",
			"session.otherWorkspace": "非当前对话工作区",
			"session.warnings": "{count} 个状态提醒",
			"detail.expand": "展开 Session 详情",
			"detail.collapse": "收起 Session 详情",
			"detail.loading": "读取 Session 详情…",
			"detail.outcome": "实验结论",
			"detail.bestCycles": "最佳正确结果：{cycles} cycles",
			"detail.sessionLineage": "本 Session：{baseline} → {best} · {speedup}x",
			"detail.overallLineage": "全链路：{baseline} → {best} · {speedup}x",
			"detail.authoringBudget": "Workflow 创作：已用 {used}/{total}",
			"detail.rounds": "逐轮实验树",
			"detail.roundTree": "KerSor 逐轮实验树",
			"detail.round.number": "R{round}",
			"detail.round.authored": "新创作",
			"detail.round.candidate": "候选：{candidate}",
			"detail.round.verdict.pending": "等待 Host",
			"detail.round.verdict.pass": "Host PASS",
			"detail.round.verdict.fail": "Host FAIL",
			"detail.round.measuredCycles": "{cycles} cycles 实测",
			"detail.round.measuredSpeedup": "{speedup}x 实测",
			"detail.round.estimatedCycles": "{cycles} cycles 估算",
			"detail.round.estimatedSpeedup": "{speedup}x 估算",
			"detail.round.promoted": "晋升为 best",
			"detail.round.retained": "保留 incumbent",
			"detail.round.failure.correctness": "候选正确性失败",
			"detail.round.failure.benchmark": "候选 benchmark 失败",
			"detail.round.failure.infrastructure": "基础设施失败",
			"detail.round.estimateExcluded": "估算未计入结果",
			"detail.round.authoringChain": "路由无解 → Author → Seal → Validate → Catalog → Reselect",
			"detail.stop": "停止",
			"detail.stop.targetMet": "目标已达到",
			"detail.stop.executionBudget": "执行预算耗尽，目标未达；保留最佳正确结果",
			"detail.stop.selectionStalled": "没有可用 Workflow，需要新的策略或用户合同",
			"detail.stop.authoringBudget": "Workflow 创作预算耗尽",
			"detail.stop.cancelled": "实验已取消",
			"detail.stop.singleRun": "单轮实验已完成",
			"detail.timeline": "Session 阶段时间线",
			"detail.step.setup": "Setup",
			"detail.step.baseline": "Baseline",
			"detail.step.profile": "Profile",
			"detail.step.selection": "Selection",
			"detail.step.authoring": "Authoring",
			"detail.step.validation": "Validation",
			"detail.step.dispatch": "Dispatch",
			"detail.step.measurement": "Measurement",
			"detail.step.decision": "Decision",
			"detail.step.workflow": "Workflow",
			"detail.step.ownership": "Ownership",
			"step.pending": "待处理",
			"step.active": "进行中",
			"step.completed": "已完成",
			"step.failed": "失败",
			"detail.selection": "Selector",
			"detail.selection.pending": "尚未运行",
			"detail.selection.stalled": "没有 released Workflow，转入 authoring",
			"detail.selection.selected": "已选择 Workflow",
			"detail.rejected": "拒绝 {count} 个候选",
			"detail.authoring": "Workflow authoring",
			"detail.authoring.not_started": "尚未开始",
			"detail.authoring.in_progress": "前台 author 正在写入；seal 前不公开设计",
			"detail.authoring.sealed": "handoff 已密封，可只读审查",
			"detail.authoring.saved": "Proposal 已保存",
			"detail.authoring.rejected": "Proposal 被拒绝",
			"detail.validation": "Proposal validation",
			"detail.validation.pending": "等待 seal/save",
			"detail.validation.passed": "全部通过",
			"detail.validation.failed": "验证失败",
			"detail.dispatch": "Workflow dispatch",
			"detail.dispatch.pending": "等待 dispatch",
			"detail.dispatch.preparing": "正在合成参数与 provenance",
			"detail.dispatch.running": "Workflow Host 运行中",
			"detail.dispatch.completed": "Workflow Host 已完成",
			"detail.dispatch.failed": "Host 拒绝本轮候选",
			"detail.workflowDesign": "所选 Workflow",
			"detail.workflowTree": "所选 Workflow 拓扑",
			"detail.requiredArgs": "必需参数",
			"detail.rationale": "查看 rationale.md",
			"detail.whenToUse": "查看适用条件",
			"detail.source": "查看已验证的 Workflow 源码",
			"detail.sealRequired": "所选 Workflow 完成兼容性验证或 author handoff 密封后显示设计。",
			"detail.omitted": "设计内容不可显示：{reason}",
			"run.sectionTitle": "Workflow 执行",
			"launcher.title": "任务控制",
			"launcher.start": "启动",
			"launcher.stop": "停止",
			"launcher.running": "dsh 正在托管 {count} 个启动进程",
			"launcher.error": "任务控制失败：{message}",
			"run.active": "运行中",
			"run.completed": "已完成",
			"run.waiting": "等待恢复",
			"run.failed": "已失败",
			"run.unknown": "未知",
			"run.currentPhase": "当前阶段：{phase}",
			"run.calls": "{calls} 个调用",
			"run.tokens": "{tokens} tokens",
			"run.startedAt": "开始于 {time}",
			"run.error": "错误：{message}",
			"run.pipeline": "Workflow 执行图",
			"run.tree": "KerSor 执行树",
			"run.parallelCalls": "{calls} 个并行调用",
			"run.workflowCompletedHostPending": "Workflow 已完成 · Session 等待 Host 验证",
			"run.workflowCompletedSessionActive": "Workflow 已完成 · Session 仍在优化",
			"run.host.title": "Host 验证",
			"run.host.ownership": "候选所有权",
			"run.result.title": "候选选择",
			"run.result.stage": "阶段：{stage}",
			"run.result.verification.passed": "Host PASS",
			"run.result.verification.failed": "Host FAIL",
			"run.result.selected": "已选择 {candidate}",
			"run.result.cycles": "{cycles} cycles",
			"run.result.cyclesMeasured": "{cycles} cycles 实测",
			"run.result.cyclesEstimated": "{cycles} cycles 预估",
			"run.result.measured": "{speedup}x 实测",
			"run.result.estimated": "{speedup}x 预估",
			"run.result.unmeasured": "尚未实测",
			"run.result.chosen": "已选择",
			"run.result.promoted": "晋升为 best",
			"run.result.incumbentRetained": "保留 incumbent",
			"run.result.incumbentCycles": "当前 best：{cycles} cycles",
			"run.result.estimateExcluded": "估算未计入结果",
			"phase.empty": "（无事件）",
			"call.queued": "排队中",
			"call.running": "运行中",
			"call.completed": "已完成",
			"call.failed": "已失败",
			"call.rolledBack": "已回滚",
			"call.evaluation": "评测",
			"call.agent": "代理",
			"call.duration": "{seconds}",
			"call.open": "查看调用 {label}",
			"call.loading": "读取调用详情…",
			"call.runner.codex": "Codex exec",
			"call.runner.unknown": "执行器未知",
			"call.model": "模型：{model}",
			"call.modelUnknown": "未记录",
			"call.modelRole": "模型角色：{role}",
			"call.noMessages": "没有可显示的 Agent 消息",
			"call.tool": "工具",
			"call.webSearch": "搜索",
			"call.truncated": "详情已按安全上限截断"
		};
		/** English KerSor viewer messages. */
		const en = {
			"view.kersor": "KerSor",
			"experiment.title": "KerSor experiment",
			"experiment.status.provisioning": "Provisioning",
			"experiment.status.running": "Running",
			"experiment.status.waiting": "Waiting to resume",
			"experiment.status.blocked": "Blocked",
			"experiment.status.completed": "Completed",
			"experiment.status.cancelled": "Cancelled",
			"experiment.phase": "Phase: {phase}",
			"experiment.round": "Round {current}/{maximum}",
			"experiment.roundOpen": "Round {current}",
			"experiment.workflow": "Workflow: {workflow}",
			"experiment.best": "Best: {speedup}x",
			"experiment.progress": "KerSor experiment progress {progress}%",
			"experiment.next": "Next:",
			"experiment.openController": "Open DSH execution conversation",
			"panel.trigger": "KerSor activity",
			"panel.title": "KerSor activity",
			"panel.empty": "Scanned {roots} sources; no KerSor optimization Sessions or Workflow runs were discovered",
			"panel.loading": "Loading…",
			"panel.readFailed": "Reading the run inventory failed: {message}",
			"panel.sourcesDegraded": "Showing readable data only: {roots} roots, {readers} run readers, {sources} unhealthy sources; latest {stage}/{code} ({occurrences} occurrence(s))",
			"panel.sourcesFailed": "KerSor sources failed: {roots} roots, {readers} run readers; latest {stage}/{code} ({occurrences} occurrence(s))",
			"panel.hint": "Optimization summaries and live Workflow progress",
			"panel.followLatest": "Follow latest activity",
			"session.title": "Optimization Sessions",
			"session.summary": "Latest {count} · {active} active",
			"session.round": "Round {current}/{maximum}",
			"session.roundOpen": "Round {current}",
			"session.best": "Best {speedup}x",
			"session.target": "Target {speedup}x",
			"session.authoring": "Authoring · used {used}/{budget}",
			"session.freshGate": "Fresh isolation: {status}",
			"session.baselineGate": "Baseline witness: {status}",
			"session.profileGate": "Profile evidence: {status}",
			"session.profileOwner": "Profile owner: {owner}",
			"session.profileBlocked": "Profile blocked",
			"session.baselineAction.init": "Initialize the baseline method",
			"session.baselineAction.recordVerify": "Record and verify the baseline",
			"session.baselineAction.newSession": "Start a new Session before retrying",
			"session.dshGate": "DSH compatibility: {status}",
			"session.ownershipGate": "Candidate ownership: {status}",
			"session.gate.pass": "pass",
			"session.gate.fail": "fail",
			"session.gate.pending": "pending",
			"session.gate.notRequired": "not required",
			"session.workflow": "Workflow: {workflow}",
			"session.fit": "Fit: {confidence}",
			"session.noWorkflow": "No Workflow selected yet",
			"session.selectorStalled": "Selector: STALLED · resolving an escape path",
			"session.unknownPhase": "Unknown phase",
			"session.lastActivity": "Active {time}",
			"session.health.active": "Active",
			"session.health.stale": "Stale",
			"session.health.needsResume": "Needs resume",
			"session.health.terminal": "Terminal",
			"session.health.unknown": "Unknown",
			"session.otherWorkspace": "Different conversation workspace",
			"session.warnings": "{count} status warning(s)",
			"detail.expand": "Expand Session details",
			"detail.collapse": "Collapse Session details",
			"detail.loading": "Loading Session detail…",
			"detail.outcome": "Experiment outcome",
			"detail.bestCycles": "Best correct result: {cycles} cycles",
			"detail.sessionLineage": "This Session: {baseline} → {best} · {speedup}x",
			"detail.overallLineage": "Overall lineage: {baseline} → {best} · {speedup}x",
			"detail.authoringBudget": "Workflow authoring: {used}/{total} used",
			"detail.rounds": "Round history",
			"detail.roundTree": "KerSor experiment round tree",
			"detail.round.number": "R{round}",
			"detail.round.authored": "Authored",
			"detail.round.candidate": "Candidate: {candidate}",
			"detail.round.verdict.pending": "Awaiting Host",
			"detail.round.verdict.pass": "Host PASS",
			"detail.round.verdict.fail": "Host FAIL",
			"detail.round.measuredCycles": "{cycles} measured cycles",
			"detail.round.measuredSpeedup": "{speedup}x measured",
			"detail.round.estimatedCycles": "{cycles} estimated cycles",
			"detail.round.estimatedSpeedup": "{speedup}x estimated",
			"detail.round.promoted": "Promoted to best",
			"detail.round.retained": "Incumbent retained",
			"detail.round.failure.correctness": "Candidate correctness failed",
			"detail.round.failure.benchmark": "Candidate benchmark failed",
			"detail.round.failure.infrastructure": "Infrastructure failed",
			"detail.round.estimateExcluded": "Estimate excluded from results",
			"detail.round.authoringChain": "Routing gap → Author → Seal → Validate → Catalog → Reselect",
			"detail.stop": "Stop",
			"detail.stop.targetMet": "Target met",
			"detail.stop.executionBudget": "Execution budget exhausted; target missed and best correct result retained",
			"detail.stop.selectionStalled": "No compatible Workflow; a new strategy or user contract is required",
			"detail.stop.authoringBudget": "Workflow authoring budget exhausted",
			"detail.stop.cancelled": "Experiment cancelled",
			"detail.stop.singleRun": "Single-run experiment completed",
			"detail.timeline": "Session stage timeline",
			"detail.step.setup": "Setup",
			"detail.step.baseline": "Baseline",
			"detail.step.profile": "Profile",
			"detail.step.selection": "Selection",
			"detail.step.authoring": "Authoring",
			"detail.step.validation": "Validation",
			"detail.step.dispatch": "Dispatch",
			"detail.step.measurement": "Measurement",
			"detail.step.decision": "Decision",
			"detail.step.workflow": "Workflow",
			"detail.step.ownership": "Ownership",
			"step.pending": "Pending",
			"step.active": "Active",
			"step.completed": "Completed",
			"step.failed": "Failed",
			"detail.selection": "Selector",
			"detail.selection.pending": "Not started",
			"detail.selection.stalled": "No released Workflow; authoring an escape path",
			"detail.selection.selected": "Workflow selected",
			"detail.rejected": "{count} candidate(s) rejected",
			"detail.authoring": "Workflow authoring",
			"detail.authoring.not_started": "Not started",
			"detail.authoring.in_progress": "Foreground author is writing; design stays hidden until seal",
			"detail.authoring.sealed": "Handoff sealed and available for read-only review",
			"detail.authoring.saved": "Proposal saved",
			"detail.authoring.rejected": "Proposal rejected",
			"detail.validation": "Proposal validation",
			"detail.validation.pending": "Waiting for seal/save",
			"detail.validation.passed": "All checks passed",
			"detail.validation.failed": "Validation failed",
			"detail.dispatch": "Workflow dispatch",
			"detail.dispatch.pending": "Waiting for dispatch",
			"detail.dispatch.preparing": "Synthesizing args and provenance",
			"detail.dispatch.running": "Workflow Host running",
			"detail.dispatch.completed": "Workflow Host completed",
			"detail.dispatch.failed": "Host rejected this candidate",
			"detail.workflowDesign": "Selected Workflow",
			"detail.workflowTree": "Selected Workflow topology",
			"detail.requiredArgs": "Required args",
			"detail.rationale": "View rationale.md",
			"detail.whenToUse": "View applicability",
			"detail.source": "View verified Workflow source",
			"detail.sealRequired": "Design appears after compatibility verification or an author handoff seal.",
			"detail.omitted": "Design content is unavailable: {reason}",
			"run.sectionTitle": "Workflow execution",
			"launcher.title": "Task controls",
			"launcher.start": "Start",
			"launcher.stop": "Stop",
			"launcher.running": "dsh owns {count} launcher process(es)",
			"launcher.error": "Task control failed: {message}",
			"run.active": "Running",
			"run.completed": "Completed",
			"run.waiting": "Waiting to resume",
			"run.failed": "Failed",
			"run.unknown": "Unknown",
			"run.currentPhase": "Current phase: {phase}",
			"run.calls": "{calls} calls",
			"run.tokens": "{tokens} tokens",
			"run.startedAt": "Started {time}",
			"run.error": "Error: {message}",
			"run.pipeline": "Workflow execution graph",
			"run.tree": "KerSor execution tree",
			"run.parallelCalls": "{calls} parallel calls",
			"run.workflowCompletedHostPending": "Workflow completed · Session awaits Host verification",
			"run.workflowCompletedSessionActive": "Workflow completed · Session is still optimizing",
			"run.host.title": "Host verification",
			"run.host.ownership": "Candidate ownership",
			"run.result.title": "Candidate selection",
			"run.result.stage": "Stage: {stage}",
			"run.result.verification.passed": "Host PASS",
			"run.result.verification.failed": "Host FAIL",
			"run.result.selected": "Selected {candidate}",
			"run.result.cycles": "{cycles} cycles",
			"run.result.cyclesMeasured": "{cycles} measured cycles",
			"run.result.cyclesEstimated": "{cycles} estimated cycles",
			"run.result.measured": "{speedup}x measured",
			"run.result.estimated": "{speedup}x estimated",
			"run.result.unmeasured": "Not measured yet",
			"run.result.chosen": "Selected",
			"run.result.promoted": "Promoted to best",
			"run.result.incumbentRetained": "Incumbent retained",
			"run.result.incumbentCycles": "Current best: {cycles} cycles",
			"run.result.estimateExcluded": "Estimate excluded from results",
			"phase.empty": "(no events)",
			"call.queued": "Queued",
			"call.running": "Running",
			"call.completed": "Completed",
			"call.failed": "Failed",
			"call.rolledBack": "rolled back",
			"call.evaluation": "evaluation",
			"call.agent": "agent",
			"call.duration": "{seconds}",
			"call.open": "View call {label}",
			"call.loading": "Loading call detail…",
			"call.runner.codex": "Codex exec",
			"call.runner.unknown": "Unknown runner",
			"call.model": "Model: {model}",
			"call.modelUnknown": "not recorded",
			"call.modelRole": "Model role: {role}",
			"call.noMessages": "No Agent messages are available",
			"call.tool": "Tool",
			"call.webSearch": "Search",
			"call.truncated": "Detail was truncated at the safety limit"
		};
		//#endregion
		//#region lib/types/client/index.js
		/**
		* KerSor viewer browser half: one atomic Host snapshot plus optional launcher
		* process ownership, rendered as a first-class conversation view.
		* @module @deepseek-ai/dsh-client-ui-kersor-viewer/client
		*/
		/** Required services: viewer UI seams, assembled Remotes, and Host inventory. */
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.pluginInventory",
			"sessions",
			"conversationEvents"
		];
		/** Mount the KerSor viewer surfaces over the API assembly's Remote namespaces. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "kersor-viewer: dictionaries");
			ctx.conversationEvents.register(kersorExperimentDefinition);
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "kersor-experiment",
				locale: NS,
				inject: () => ({ openController(childSessionId) {
					const parentSessionId = ctx.sessions.list.getSnapshot().current;
					if (parentSessionId === void 0) return;
					ctx.sessions.refreshSubagents(parentSessionId).then(() => {
						ctx.sessions.openSubagent({
							parentSessionId,
							childSessionId,
							mode: "continuable"
						});
					});
				} })
			}, KersorExperimentNode));
			const store = new KersorViewerStore();
			const classicDetailRevisions = /* @__PURE__ */ new Map();
			const classicRevision = (sessionDir) => {
				const session = store.getSnapshot().snapshot?.classic.sessions.find((candidate) => candidate.session_dir === sessionDir);
				return session === void 0 ? void 0 : `${session.last_activity_at ?? ""}:${session.phase ?? ""}:${session.current_round ?? ""}`;
			};
			const launcherRemote = () => ctx.get("remote.kersor");
			const viewerRemote = () => {
				const remote = ctx.get("remote.kersorViewer");
				if (remote === void 0) throw new Error("KerSor viewer Remote is not mounted");
				return remote;
			};
			const launcherHostAvailable = async () => {
				const answered = await ctx.remote.pluginInventory.list();
				if (!answered.ok) return false;
				return answered.value.entries.some((entry) => entry.moduleName === "@deepseek-ai/dsh-kersor" && entry.enabled && entry.fiberPhase === "active");
			};
			const refreshViewer = async () => {
				try {
					const remote = viewerRemote();
					const answered = await remote.snapshot();
					if (!answered.ok) {
						store.setTransportError(`${answered.error.code}: ${answered.error.message}`);
						return;
					}
					store.setSnapshot(answered.value);
					const selected = store.selectedRunDir;
					if (selected !== void 0) {
						const backlog = await remote.runBacklog(selected);
						if (!backlog.ok) {
							store.setTransportError(`${backlog.error.code}: ${backlog.error.message}`);
							return;
						}
						store.setBacklog(selected, backlog.value);
					}
					const selectedClassic = store.selectedClassicSessionDir;
					if (selectedClassic !== void 0) await loadClassicIfChanged(selectedClassic);
				} catch (error) {
					store.setTransportError(error instanceof Error ? error.message : String(error));
				}
			};
			const refreshLauncher = async () => {
				try {
					const launcher = launcherRemote();
					if (!await launcherHostAvailable() || launcher === void 0) {
						store.setLauncherUnavailable();
						return;
					}
					const [tasks, active] = await Promise.all([launcher.listTasks(), launcher.listActive()]);
					if (!tasks.ok || !active.ok) {
						store.setLauncherUnavailable();
						return;
					}
					store.setLauncher(tasks.value, active.value);
				} catch {
					store.setLauncherUnavailable();
				}
			};
			const loadRun = async (runDir) => {
				try {
					const remote = viewerRemote();
					const [backlog, result] = await Promise.all([remote.runBacklog(runDir), remote.runResult(runDir)]);
					if (!backlog.ok) {
						store.setTransportError(`${backlog.error.code}: ${backlog.error.message}`);
						return;
					}
					if (!result.ok) {
						store.setTransportError(`${result.error.code}: ${result.error.message}`);
						return;
					}
					store.setBacklog(runDir, backlog.value);
					store.setRunResult(runDir, result.value);
				} catch (error) {
					store.setTransportError(error instanceof Error ? error.message : String(error));
				}
			};
			const loadClassic = async (sessionDir) => {
				store.setClassicDetailLoading(sessionDir);
				try {
					const answered = await viewerRemote().classicSessionDetail(sessionDir);
					if (!answered.ok) {
						store.setClassicDetailError(sessionDir, `${answered.error.code}: ${answered.error.message}`);
						return;
					}
					store.setClassicDetail(sessionDir, answered.value);
					const revision = classicRevision(sessionDir);
					if (revision !== void 0) classicDetailRevisions.set(sessionDir, revision);
				} catch (error) {
					store.setClassicDetailError(sessionDir, error instanceof Error ? error.message : String(error));
				}
			};
			const loadClassicIfChanged = async (sessionDir) => {
				const revision = classicRevision(sessionDir);
				if (revision !== void 0 && classicDetailRevisions.get(sessionDir) === revision) return;
				await loadClassic(sessionDir);
			};
			const loadCallDetail = async (runDir, callId) => {
				store.setCallDetailLoading(runDir, callId);
				try {
					const answered = await viewerRemote().runCallDetail(runDir, callId);
					if (!answered.ok) {
						store.setCallDetailError(runDir, callId, `${answered.error.code}: ${answered.error.message}`);
						return;
					}
					store.setCallDetail(runDir, callId, answered.value);
				} catch (error) {
					store.setCallDetailError(runDir, callId, error instanceof Error ? error.message : String(error));
				}
			};
			const refresh = async () => {
				await Promise.all([refreshViewer(), refreshLauncher()]);
			};
			const start = async (taskId) => {
				try {
					const launcher = launcherRemote();
					if (!await launcherHostAvailable() || launcher === void 0) {
						store.setLauncherUnavailable();
						return;
					}
					const answered = await launcher.start(taskId);
					if (!answered.ok) {
						store.setLauncherError(`${answered.error.code}: ${answered.error.message}`);
						return;
					}
					await refreshLauncher();
					await refreshViewer();
				} catch (error) {
					store.setLauncherError(error instanceof Error ? error.message : String(error));
				}
			};
			const stop = async (runDir) => {
				try {
					const launcher = launcherRemote();
					if (!await launcherHostAvailable() || launcher === void 0) {
						store.setLauncherUnavailable();
						return;
					}
					const answered = await launcher.stop(runDir);
					if (!answered.ok) {
						store.setLauncherError(`${answered.error.code}: ${answered.error.message}`);
						return;
					}
					await refreshLauncher();
					await refreshViewer();
				} catch (error) {
					store.setLauncherError(error instanceof Error ? error.message : String(error));
				}
			};
			ctx.on("connection/reset", () => {
				store.reset();
				classicDetailRevisions.clear();
				refresh();
			});
			ctx.remote.$on("kersor/event", (frame) => {
				store.applyFrame(frame);
				if (frame.kind === "snapshot" && store.selectedClassicSessionDir !== void 0) loadClassicIfChanged(store.selectedClassicSessionDir);
			});
			ctx.remote.$on("kersor/active", (frame) => {
				store.applyActiveFrame(frame);
			});
			refresh();
			const face = {
				store,
				refresh,
				loadRun,
				loadCallDetail,
				loadClassic,
				start,
				stop
			};
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "kersor",
				order: 20,
				locale: NS,
				label: () => t("view.kersor"),
				inject: (sessionId) => {
					const currentWorkspace = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd;
					return {
						...face,
						...currentWorkspace === void 0 ? {} : { currentWorkspace }
					};
				}
			}, KersorView));
		}
		//#endregion
		exports.KersorViewerStoreClass = KersorViewerStore;
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map