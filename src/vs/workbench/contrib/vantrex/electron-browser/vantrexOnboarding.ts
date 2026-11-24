/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { DEFAULT_GLASS_TRANSPARENCY, IVantrexOnboardingResult, VANTREX_THEME_IDS, VantrexThemeChoice } from '../../../../platform/vantrexOnboarding/common/vantrexOnboarding.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { vantrexOnboardingState } from './vantrexOnboardingState.js';
import { VantrexOnboardingOverlay } from './vantrexOnboardingOverlay.js';

const DONE_KEY = 'vantrex.onboarding.done';
const ACCOUNT_PROVIDER = 'vantrex';

interface IOnboardingDebugArgs {
	readonly step?: number;
	readonly theme?: VantrexThemeChoice;
}

/**
 * Runs the Vantrex onboarding flow in this window: the window goes small and clean on the system's glass, the flow shows over the
 * (hidden) editor, and when it ends the window grows, smoothly, into the editor, which fades in.
 */
class VantrexOnboardingRunner extends Disposable {

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
	) {
		super();
	}

	/** `force` runs the flow again in a window that is already open (the command does this). */
	async run(options: { force?: boolean; debug?: IOnboardingDebugArgs }): Promise<void> {
		const body = mainWindow.document.body;
		const entered = await this.nativeHostService.enterVantrexOnboarding({ force: options.force });
		if (!entered.active) {
			return this.end();
		}

		vantrexOnboardingState.active = true;
		body.classList.add('vtx-onboarding');

		const result = await new Promise<IVantrexOnboardingResult>(finish => {
			this._register(new VantrexOnboardingOverlay({
				setTheme: theme => { this.nativeHostService.setWindowGlass({ enabled: true, theme, transparency: DEFAULT_GLASS_TRANSPARENCY }); },
				requestNotifications: () => this.nativeHostService.requestVantrexNotifications(),
				signIn: () => this.signIn(),
				finish,
			}, entered.mode, { step: options.debug?.step, theme: options.debug?.theme }));
		});

		this.storageService.store(DONE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
		await this.nativeHostService.markVantrexOnboardingDone(); // the main process reads this when it creates the first window
		if (!result.cancelled && result.theme) {
			await this.configurationService.updateValue('workbench.colorTheme', VANTREX_THEME_IDS[result.theme], ConfigurationTarget.USER);
		}

		// Grow into the editor: the window animates to its size while the flow fades out and the editor fades in.
		const growing = this.nativeHostService.leaveVantrexOnboarding({ resize: entered.resize });
		body.classList.add('vtx-onboarding-reveal');
		this.end();
		await growing;
		setTimeout(() => body.classList.remove('vtx-onboarding-reveal'), 800);
	}

	/** Shows the editor again and fades the flow away. */
	end(): void {
		mainWindow.document.body.classList.remove('vtx-onboarding');
		vantrexOnboardingState.active = false;
		for (const overlay of mainWindow.document.querySelectorAll('.vtx-ob')) {
			overlay.classList.add('leaving');
			setTimeout(() => overlay.remove(), 450);
		}
	}

	private async signIn(): Promise<string | undefined> {
		try {
			await this.commandService.executeCommand('vantrex.account.signIn');
			const sessions = await this.authenticationService.getSessions(ACCOUNT_PROVIDER);
			return sessions[0]?.account.label;
		} catch {
			return undefined;
		}
	}
}

/** On the first run, starts the flow: the editor window itself starts small and clean, then grows into the editor. */
class VantrexOnboarding extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vantrexOnboarding';

	constructor(
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
	) {
		super();

		if (!storageService.getBoolean(DONE_KEY, StorageScope.APPLICATION, false) && !environmentService.extensionTestsLocationURI) {
			// Hidden at once, so the editor never flashes in the small window; if this turns out not to be the first-run window, it is shown again.
			vantrexOnboardingState.active = true;
			mainWindow.document.body.classList.add('vtx-onboarding');

			const runner = this._register(instantiationService.createInstance(VantrexOnboardingRunner));
			runner.run({}).catch(() => runner.end());
		}
	}
}

registerWorkbenchContribution2(VantrexOnboarding.ID, VantrexOnboarding, WorkbenchPhase.BlockStartup);

registerAction2(class ShowOnboarding extends Action2 {

	constructor() {
		super({
			id: 'vantrex.onboarding.show',
			title: localize2('vantrexShowOnboarding', "Show Welcome Flow"),
			category: localize2('vantrexCategory', "Vantrex"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, debug?: IOnboardingDebugArgs): Promise<void> {
		const runner = accessor.get(IInstantiationService).createInstance(VantrexOnboardingRunner);
		try {
			await runner.run({ force: true, debug });
		} finally {
			runner.dispose();
		}
	}
});
