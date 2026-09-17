/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLOUDCODE_CHANNEL, ICloudCodeService } from '../../../../platform/cloudCode/common/cloudCode.js';
import { CLOUDCODE_COMMAND_CHANNEL, ICloudCodeCommandService } from '../../../../platform/cloudCode/common/cloudCodeCommand.js';
import { registerSharedProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';

registerSharedProcessRemoteService(ICloudCodeService, CLOUDCODE_CHANNEL);
registerSharedProcessRemoteService(ICloudCodeCommandService, CLOUDCODE_COMMAND_CHANNEL);
