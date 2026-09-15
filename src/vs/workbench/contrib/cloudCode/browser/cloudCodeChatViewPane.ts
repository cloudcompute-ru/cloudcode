/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { size } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { ICloudCodeService } from '../../../../platform/cloudCode/common/cloudCode.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { CloudCodeChatWidget } from './cloudCodeChatWidget.js';
import { CloudCodeAttachmentInput } from './cloudCodeAttachmentInput.js';
import { CloudCodeContext } from './cloudCodeContext.js';
import { CloudCodeEditWorkspace } from './cloudCodeEditWorkspace.js';
import { CloudCodeAgentWorkspace } from './cloudCodeAgentWorkspace.js';
import { CloudCodeAgent } from '../common/cloudCodeAgent.js';
import { CloudCodeChatMode } from '../common/cloudCodeEdits.js';
import { CloudCodeAttachmentKind } from '../common/cloudCodeChatContext.js';
import { CloudCodeChatController } from '../common/cloudCodeChatController.js';

export class CloudCodeChatViewPane extends ViewPane {

	static readonly ID = 'workbench.cloudCode.chat';

	private bodyContainer: HTMLElement | undefined;
	private widget: CloudCodeChatWidget | undefined;
	private controller: CloudCodeChatController | undefined;
	private readonly context: CloudCodeContext;
	private readonly attachmentInput: CloudCodeAttachmentInput;
	private readonly editWorkspace: CloudCodeEditWorkspace;
	private readonly agent: CloudCodeAgent;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ICloudCodeService private readonly cloudCodeService: ICloudCodeService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this.context = instantiationService.createInstance(CloudCodeContext);
		this.attachmentInput = instantiationService.createInstance(CloudCodeAttachmentInput, this.context);
		this.editWorkspace = this._register(instantiationService.createInstance(CloudCodeEditWorkspace));
		this.agent = new CloudCodeAgent(cloudCodeService, instantiationService.createInstance(CloudCodeAgentWorkspace), this.editWorkspace);
		this._register(lifecycleService.onWillShutdown(event => {
			if (this.controller) {
				event.join(this.controller.shutdown(), { id: 'cloudcode.chat', label: localize('cloudcode.stoppingChat', "Stopping CloudCode chat") });
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.bodyContainer = container;
		this.widget = this._register(new CloudCodeChatWidget(container, async (models, selected) => {
			const items = models.map(model => ({ label: model.name, description: model.supportsImages ? localize('cloudcode.imageModelDescription', "{0} · Images", model.id) : model.id, id: model.id }));
			const picked = await this.quickInputService.pick(items, {
				placeHolder: localize('cloudcode.searchModels', "Search models by name or ID"),
				matchOnDescription: true,
				activeItem: items.find(item => item.id === selected),
			});
			return picked?.id;
		}, async mode => {
			const items: { id: CloudCodeChatMode; label: string; description: string }[] = [
				{ id: 'agent', label: localize('cloudcode.agentMode', "Agent"), description: localize('cloudcode.agentModeDetail', "Search the project, read files, and propose changes") },
				{ id: 'ask', label: localize('cloudcode.askMode', "Ask"), description: localize('cloudcode.askModeDetail', "Answer using messages and attached content; no project search or edits") },
				{ id: 'edit', label: localize('cloudcode.proposeEdits', "Propose Edits"), description: localize('cloudcode.editModeDetail', "Change only the files or selections you attach") },
			];
			const picked = await this.quickInputService.pick(items, { placeHolder: localize('cloudcode.chatMode', "Choose a chat mode"), activeItem: items.find(item => item.id === mode) });
			return picked?.id;
		}, this.attachmentInput));
		this.controller = this._register(new CloudCodeChatController(this.widget, {
			assertWorkspaceTrusted: () => this.context.assertWorkspaceTrusted(),
			pickAttachments: async () => {
				this.context.assertWorkspaceTrusted();
				const items: { label: string; description: string; kind: CloudCodeAttachmentKind }[] = [
					{ label: localize('cloudcode.attachFile', "Current File"), description: localize('cloudcode.attachFileDetail', "Include unsaved changes"), kind: 'file' },
					{ label: localize('cloudcode.attachSelection', "Selected Code"), description: localize('cloudcode.attachSelectionDetail', "Only the selected code"), kind: 'selection' },
					{ label: localize('cloudcode.attachFiles', "Choose Files…"), description: localize('cloudcode.attachFilesDetail', "Select text files or images"), kind: 'files' },
				];
				const picked = await this.quickInputService.pick(items, { placeHolder: localize('cloudcode.attachContext', "Attach files or images to your next message") });
				return picked ? this.context.readAttachments(picked.kind) : [];
			}
		}, this.editWorkspace, this.agent, this.cloudCodeService));
		void this.controller.initialize();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.bodyContainer) {
			size(this.bodyContainer, width, height);
		}
	}

	newConversation(): void {
		this.widget?.newConversation();
	}

	override focus(): void {
		super.focus();
		this.widget?.focus();
	}
}
