/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLOUDCODE_PRODUCT_NAME } from '../../../../platform/cloudCode/common/cloudCodeBrand.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { getCodeEditor, ICodeEditor, isDiffEditor } from '../../../../editor/browser/editorBrowser.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarker, IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ISCMViewService, VIEW_PANE_ID } from '../../scm/common/scm.js';
import { CLOUDCODE_MAX_QUICK_DIAGNOSTICS, cloudCodeCommitMessage, capCloudCodeStagedDiff, ICloudCodeQuickDiagnostic } from '../common/cloudCodeQuickActions.js';
import { CloudCodeChatViewPane } from './cloudCodeChatViewPane.js';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'cloudcode.explainSelection',
			title: localize2('cloudcode.explainSelection', "Explain Selection"),
			f1: true,
			precondition: EditorContextKeys.hasNonEmptySelection,
			menu: {
				id: MenuId.EditorContext,
				group: '1_chat',
				order: 1,
				when: EditorContextKeys.hasNonEmptySelection,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const viewsService = accessor.get(IViewsService);
		if (!hasTextEditor(editorService)) {
			return;
		}
		const view = await openChat(viewsService, true);
		await view?.explainSelection();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'cloudcode.editSelection',
			title: localize2('cloudcode.editSelection', "Edit Selection"),
			f1: true,
			precondition: ContextKeyExpr.and(EditorContextKeys.hasNonEmptySelection, EditorContextKeys.writable),
			menu: {
				id: MenuId.EditorContext,
				group: '1_chat',
				order: 2,
				when: ContextKeyExpr.and(EditorContextKeys.hasNonEmptySelection, EditorContextKeys.writable),
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const editorService = accessor.get(IEditorService);
		const viewsService = accessor.get(IViewsService);
		const instruction = await quickInputService.input({
			title: localize('cloudcode.editSelectionTitle', "Edit Selection"),
			prompt: localize('cloudcode.editSelectionInstruction', "Describe how to change the selection"),
			placeHolder: localize('cloudcode.editSelectionPlaceholder', "Instruction"),
		});
		if (!instruction?.trim() || !hasTextEditor(editorService)) {
			return;
		}
		const view = await openChat(viewsService, true);
		await view?.editSelection(instruction.trim());
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'cloudcode.fixDiagnostic',
			title: localize2('cloudcode.fixDiagnostic', "Fix Diagnostic"),
			f1: true,
			precondition: ContextKeyExpr.and(EditorContextKeys.editorTextFocus, EditorContextKeys.writable),
			menu: {
				id: MenuId.EditorContext,
				group: '1_chat',
				order: 3,
				when: ContextKeyExpr.and(EditorContextKeys.editorTextFocus, EditorContextKeys.writable),
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const markerService = accessor.get(IMarkerService);
		const notifications = accessor.get(INotificationService);
		const viewsService = accessor.get(IViewsService);
		const control = editorService.activeTextEditorControl;
		const editor = getCodeEditor(control);
		if (isDiffEditor(control)) {
			const view = await openChat(viewsService, true);
			await view?.fixDiagnostic(new Range(1, 1, 1, 1), []);
			return;
		}
		if (!editor?.hasModel()) {
			return;
		}
		const model = editor.getModel();
		const markers = relevantMarkers(markerService.read({
			resource: model.uri,
			severities: MarkerSeverity.Error | MarkerSeverity.Warning,
		}), editor);
		if (!markers.length) {
			notifications.info(localize('cloudcode.noDiagnostic', "No error or warning on this line."));
			return;
		}
		const diagnostics: ICloudCodeQuickDiagnostic[] = [];
		for (const marker of markers) {
			const severity = marker.severity === MarkerSeverity.Error ? 'Error' : marker.severity === MarkerSeverity.Warning ? 'Warning' : undefined;
			if (severity) {
				diagnostics.push({ line: marker.startLineNumber, severity, message: marker.message });
			}
		}
		if (!diagnostics.length) {
			notifications.info(localize('cloudcode.noDiagnostic', "No error or warning on this line."));
			return;
		}
		const view = await openChat(viewsService, true);
		await view?.fixDiagnostic(diagnosticRange(model, markers), diagnostics);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'cloudcode.commitMessage',
			title: localize2('cloudcode.commitMessage', "Generate Commit Message"),
			f1: true,
			menu: {
				id: MenuId.SCMTitle,
				group: 'navigation',
				order: 100,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const notifications = accessor.get(INotificationService);
		const commandService = accessor.get(ICommandService);
		const viewsService = accessor.get(IViewsService);
		const active = accessor.get(ISCMViewService).activeRepository.get();
		const root = active?.repository.provider.rootUri;
		if (!active || !root) {
			notifications.info(localize('cloudcode.commitNeedsRepository', "Open a Git repository before generating a commit message."));
			return;
		}
		const diff = await commandService.executeCommand<string | null>('git.api.getStagedDiff', root.toString());
		if (typeof diff !== 'string') {
			notifications.info(localize('cloudcode.commitNeedsRepository', "Open a Git repository before generating a commit message."));
			return;
		}
		if (!diff.trim()) {
			notifications.info(localize('cloudcode.nothingStaged', "Nothing is staged."));
			return;
		}
		const capped = capCloudCodeStagedDiff(diff);
		const view = await openChat(viewsService, false);
		if (!view) {
			notifications.error(localize('cloudcode.chatUnavailable', "{0} Chat is not available in this window.", CLOUDCODE_PRODUCT_NAME));
			return;
		}
		let reply: string;
		try {
			reply = await view.draftCommitMessage(capped.diff, capped.truncated);
		} catch (error) {
			if (!isCancellationError(error)) {
				notifications.error(error instanceof Error ? error.message : localize('cloudcode.commitMessageFailed', "The commit message could not be generated."));
			}
			return;
		}
		const message = cloudCodeCommitMessage(reply);
		if (!message) {
			notifications.error(localize('cloudcode.commitMessageRejected', "The reply could not be used as a commit message. The commit box was not changed."));
			return;
		}
		const repository = active.repository;
		await viewsService.openView(VIEW_PANE_ID, true);
		repository.input.setValue(message, false);
		repository.input.setFocus();
	}
});

function hasTextEditor(editorService: IEditorService): boolean {
	const control = editorService.activeTextEditorControl;
	return isDiffEditor(control) || !!getCodeEditor(control);
}

async function openChat(viewsService: IViewsService, focus: boolean): Promise<CloudCodeChatViewPane | undefined> {
	const view = await viewsService.openView<CloudCodeChatViewPane>(CloudCodeChatViewPane.ID, focus);
	return view ?? undefined;
}

function relevantMarkers(markers: readonly IMarker[], editor: ICodeEditor): IMarker[] {
	const selection = editor.getSelection();
	const line = selection?.startLineNumber ?? editor.getPosition()?.lineNumber;
	const matched = markers.filter(marker => {
		if (selection && !selection.isEmpty()) {
			return Range.areIntersecting(selection, marker);
		}
		return line !== undefined && markerIntersectsLine(marker, line);
	});
	matched.sort((a, b) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn || b.severity - a.severity);
	return matched.slice(0, CLOUDCODE_MAX_QUICK_DIAGNOSTICS);
}

function markerIntersectsLine(marker: IMarker, line: number): boolean {
	const endLine = marker.endColumn === 1 && marker.endLineNumber > marker.startLineNumber ? marker.endLineNumber - 1 : marker.endLineNumber;
	return marker.startLineNumber <= line && line <= endLine;
}

function diagnosticRange(model: ITextModel, markers: readonly IMarker[]): Range {
	let span = new Range(markers[0].startLineNumber, markers[0].startColumn, markers[0].endLineNumber, markers[0].endColumn);
	for (const marker of markers.slice(1)) {
		span = span.plusRange(new Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn));
	}
	const lastLine = Math.min(model.getLineCount(), Math.max(1, span.endLineNumber));
	const firstLine = Math.min(lastLine, Math.max(1, span.startLineNumber));
	return new Range(firstLine, 1, lastLine, model.getLineMaxColumn(lastLine));
}
