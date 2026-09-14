/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import product from '../../../../../platform/product/common/product.js';
import { IOnboardingService } from '../../common/onboardingService.js';
// Import the same contribution as workbench startup: this must not assert on absent chat configuration.
import '../../browser/welcomeOnboarding.contribution.js';

suite('Onboarding startup', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('products without Copilot can resolve startup onboarding without its dependencies', () => {
		if (!product.disableBuiltinCopilot && product.defaultChatAgent) {
			return;
		}
		const descriptor = getSingletonServiceDescriptors().find(([id]) => id === IOnboardingService)?.[1];
		assert.ok(descriptor);
		const instantiationService = disposables.add(new InstantiationService(new ServiceCollection([IOnboardingService, descriptor]), true));
		const service = instantiationService.invokeFunction(accessor => accessor.get(IOnboardingService));
		disposables.add(service.onDidDismiss(() => assert.fail('Disabled onboarding must not dismiss an unseen modal.')));
		service.show();
		assert.strictEqual(CommandsRegistry.getCommand('workbench.action.welcomeOnboarding2026'), undefined);
	});
});
