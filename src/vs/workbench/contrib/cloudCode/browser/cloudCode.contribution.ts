/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { cloudCodeOrigin, CLOUDCODE_DEFAULT_SERVER, CLOUDCODE_SERVER_SETTING, ICloudCodeService, ICloudCodeState } from '../../../../platform/cloudCode/common/cloudCode.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { CloudCodeChatViewPane } from './cloudCodeChatViewPane.js';

const containerId = 'workbench.view.cloudCodeChat';
const title = localize2('cloudCode.chat.title', "CloudCode Chat");
const icon = registerIcon('cloudcode-chat-view-icon', Codicon.commentDiscussion, localize('cloudCode.chat.icon', "View icon of CloudCode Chat."));

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'cloudcode',
	title: localize('cloudCode.configuration', "CloudCode"),
	properties: {
		[CLOUDCODE_SERVER_SETTING]: {
			type: 'string',
			default: CLOUDCODE_DEFAULT_SERVER,
			scope: ConfigurationScope.APPLICATION,
			description: localize('cloudCode.serverUrl', "CloudCompute server used for sign-in and chat. Requires HTTPS; HTTP is allowed only for loopback development servers. Changing the server signs you out."),
		}
	}
});

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

const accountMenu = new MenuId('CloudCodeAccountMenu');
const signedIn = new RawContextKey<boolean>('cloudcode.signedIn', false);
const signingIn = new RawContextKey<boolean>('cloudcode.signingIn', false);

MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
	submenu: accountMenu,
	title: localize2('cloudcode.accountMenu', "Account"),
	order: 8,
});

class CloudCodeAccountContribution extends Disposable {
	constructor(
		@ICloudCodeService service: ICloudCodeService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		const signedInContext = signedIn.bindTo(contextKeyService);
		const signingInContext = signingIn.bindTo(contextKeyService);
		const accountItem = this._register(new MutableDisposable());
		let revision = 0;
		const update = (state: ICloudCodeState) => {
			signedInContext.set(state.status === 'signedIn');
			signingInContext.set(state.status === 'signingIn');
			accountItem.clear();
			if (state.status === 'signedIn' && state.account) {
				accountItem.value = MenuRegistry.appendMenuItem(accountMenu, {
					group: '1_account',
					command: {
						id: 'cloudcode.accountInfo',
						title: localize('cloudcode.accountIdentity', "{0} · {1}", state.account.user.name, state.account.team.name),
						precondition: ContextKeyExpr.false(),
					},
				});
			}
		};
		this._register(service.onDidChangeState(state => { revision++; update(state); }));
		void service.getState().then(state => {
			if (revision === 0 && !this._store.isDisposed) {
				update(state);
			}
		}, () => { /* Sign-in remains available if restoring the session fails. */ });
	}
}
registerWorkbenchContribution2('cloudcode.account', CloudCodeAccountContribution, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'cloudcode.signIn',
			title: localize2('cloudcode.signInAction', "Sign in to CloudCompute"),
			f1: true,
			precondition: ContextKeyExpr.and(signedIn.negate(), signingIn.negate()),
			menu: [
				{ id: accountMenu, group: '2_session', when: ContextKeyExpr.and(signedIn.negate(), signingIn.negate()) },
				{ id: MenuId.TitleBar, group: 'navigation', when: ContextKeyExpr.and(signedIn.negate(), signingIn.negate()) },
			],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICloudCodeService).signIn();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'cloudcode.openAccount', title: localize2('cloudcode.openAccount', "Manage Account"),
			f1: true, precondition: signedIn,
			menu: { id: accountMenu, group: '1_account', order: 1, when: signedIn },
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const configured = accessor.get(IConfigurationService).getValue<string>(CLOUDCODE_SERVER_SETTING) || CLOUDCODE_DEFAULT_SERVER;
		const url = URI.parse(`${cloudCodeOrigin(configured)}/settings/profile`);
		await accessor.get(IOpenerService).open(url, { openExternal: true, allowContributedOpeners: false });
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'cloudcode.signOut', title: localize2('cloudcode.signOutAction', "Sign Out"),
			f1: true, precondition: signedIn,
			menu: { id: accountMenu, group: '2_session', when: signedIn },
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICloudCodeService).signOut();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'cloudcode.cancelSignIn', title: localize2('cloudcode.cancelSignInAction', "Cancel Sign-in"),
			f1: true, precondition: signingIn,
			menu: { id: accountMenu, group: '2_session', when: signingIn },
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICloudCodeService).cancelSignIn();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'cloudcode.newChat', title: localize2('cloudcode.newChatAction', "New Chat"),
			icon: Codicon.plus, f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const view = await accessor.get(IViewsService).openView<CloudCodeChatViewPane>(CloudCodeChatViewPane.ID, true);
		view?.newConversation();
	}
});
