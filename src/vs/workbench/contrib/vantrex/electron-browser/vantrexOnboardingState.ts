/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';

/** Whether the onboarding flow is showing in this window. The Liquid Glass theme leaves the window's glass alone meanwhile. */
class OnboardingState {
	private _active = false;
	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange = this._onDidChange.event;

	get active(): boolean {
		return this._active;
	}

	set active(value: boolean) {
		if (this._active !== value) {
			this._active = value;
			this._onDidChange.fire();
		}
	}
}

export const vantrexOnboardingState = new OnboardingState();
