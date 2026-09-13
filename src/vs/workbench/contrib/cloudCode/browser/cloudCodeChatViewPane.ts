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
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { CloudCodeChatWidget } from './cloudCodeChatWidget.js';
import { CloudCodeChatController } from '../common/cloudCodeChatController.js';

export class CloudCodeChatViewPane extends ViewPane {

	static readonly ID = 'workbench.cloudCode.chat';

	private bodyContainer: HTMLElement | undefined;
	private widget: CloudCodeChatWidget | undefined;
	private controller: CloudCodeChatController | undefined;

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
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(lifecycleService.onWillShutdown(event => {
			if (this.controller) {
				event.join(this.controller.shutdown(), { id: 'cloudcode.chat', label: localize('cloudcode.stoppingChat', "Stopping CloudCode chat") });
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.bodyContainer = container;
		this.widget = this._register(new CloudCodeChatWidget(container));
		this.controller = this._register(new CloudCodeChatController(this.widget, this.cloudCodeService));
		void this.controller.initialize();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.bodyContainer) {
			size(this.bodyContainer, width, height);
		}
	}

	override focus(): void {
		super.focus();
		this.widget?.focus();
	}
}
