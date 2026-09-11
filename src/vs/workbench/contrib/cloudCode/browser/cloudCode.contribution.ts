/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { CloudCodeChatViewPane } from './cloudCodeChatViewPane.js';

const containerId = 'workbench.view.cloudCodeChat';
const title = localize2('cloudCode.chat.title', "CloudCode Chat");
const icon = registerIcon('cloudcode-chat-view-icon', Codicon.commentDiscussion, localize('cloudCode.chat.icon', "View icon of CloudCode Chat."));

const container = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry).registerViewContainer({
	id: containerId,
	title,
	icon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [containerId, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: containerId,
	hideIfEmpty: true,
	order: 0,
}, ViewContainerLocation.AuxiliaryBar, { isDefault: true, doNotRegisterOpenCommand: true });

Registry.as<IViewsRegistry>(Extensions.ViewsRegistry).registerViews([{
	id: CloudCodeChatViewPane.ID,
	name: title,
	containerIcon: icon,
	containerTitle: title.value,
	singleViewPaneContainerTitle: title.value,
	ctorDescriptor: new SyncDescriptor(CloudCodeChatViewPane),
	canToggleVisibility: false,
	canMoveView: true,
	openCommandActionDescriptor: {
		id: containerId,
		title,
		mnemonicTitle: localize({ key: 'cloudCode.chat.menu', comment: ['&& denotes a mnemonic'] }, "&&CloudCode Chat"),
		order: 0,
	},
}], container);
