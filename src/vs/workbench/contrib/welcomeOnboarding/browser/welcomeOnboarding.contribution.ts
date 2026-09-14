/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Load styles for the remaining onboarding variant.
import './media/variationA.css';

import { Event } from '../../../../base/common/event.js';
import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import product from '../../../../platform/product/common/product.js';
import { IOnboardingService } from '../common/onboardingService.js';
import { OnboardingVariationA } from './onboardingVariationA.js';

/** Keeps startup consumers available when the product does not provide Copilot onboarding. */
class DisabledOnboardingService implements IOnboardingService {
	declare readonly _serviceBrand: undefined;
	readonly onDidDismiss = Event.None;
	show(): void { }
}

if (product.disableBuiltinCopilot || !product.defaultChatAgent) {
	registerSingleton(IOnboardingService, DisabledOnboardingService, InstantiationType.Delayed);
} else {
	registerSingleton(IOnboardingService, OnboardingVariationA, InstantiationType.Delayed);

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.welcomeOnboarding2026',
				title: localize2('welcomeOnboarding2026', "Welcome Onboarding 2026"),
				category: Categories.Developer,
				f1: true,
			});
		}

		run(accessor: ServicesAccessor): void {
			const onboardingService = accessor.get(IOnboardingService);
			onboardingService.show();
		}
	});
}
