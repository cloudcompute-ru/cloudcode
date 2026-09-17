/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { ICloudCodeService, ICloudCodeState } from '../../../../platform/cloudCode/common/cloudCode.js';
import { ICloudCodeCommandService } from '../../../../platform/cloudCode/common/cloudCodeCommand.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

class CloudCodeWebService implements ICloudCodeService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeState = Event.None;
	readonly onDidReceiveChatDelta = Event.None;

	async getState(): Promise<ICloudCodeState> { return { status: 'signedOut' }; }
	async signIn(): Promise<never> { throw new Error(localize('cloudcode.desktopRequired', "Open the CloudCode desktop app to sign in and chat.")); }
	async cancelSignIn(): Promise<void> { }
	async signOut(): Promise<void> { }
	async getModels(): Promise<never> { return this.signIn(); }
	async streamChat(): Promise<never> { return this.signIn(); }
	async streamAgent(): Promise<never> { return this.signIn(); }
	async cancelChat(): Promise<void> { }
	async reportAgentError(): Promise<void> { }
}

registerSingleton(ICloudCodeService, CloudCodeWebService, InstantiationType.Delayed);

class CloudCodeWebCommandService implements ICloudCodeCommandService {
	declare readonly _serviceBrand: undefined;
	async run(): Promise<never> { throw new Error(localize('cloudcode.commandsDesktopRequired', "Open a local project in the CloudCode desktop app to run commands.")); }
	async cancel(): Promise<void> { }
}

registerSingleton(ICloudCodeCommandService, CloudCodeWebCommandService, InstantiationType.Delayed);
