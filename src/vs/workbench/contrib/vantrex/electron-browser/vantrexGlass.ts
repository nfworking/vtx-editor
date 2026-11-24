/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Color } from '../../../../base/common/color.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { editorBackground } from '../../../../platform/theme/common/colorRegistry.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { DEFAULT_GLASS_TRANSPARENCY } from '../../../../platform/vantrexOnboarding/common/vantrexOnboarding.js';
import { vantrexOnboardingState } from './vantrexOnboardingState.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';

const GLASS_THEME = 'Vantrex Liquid Glass';
const TRANSPARENCY_SETTING = 'vantrex.window.glassTransparency';
const DEFAULT_TRANSPARENCY = DEFAULT_GLASS_TRANSPARENCY;
const MAX_TRANSPARENCY = 95;

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vantrex',
	order: 1,
	title: localize('vantrexConfigurationTitle', "Vantrex"),
	type: 'object',
	properties: {
		[TRANSPARENCY_SETTING]: {
			type: 'number',
			default: DEFAULT_TRANSPARENCY,
			minimum: 0,
			maximum: MAX_TRANSPARENCY,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('vantrexGlassTransparency', "How see-through the window is with the **Vantrex Liquid Glass** color theme, from 0 (solid) to {0} (almost clear glass). Works on macOS and Windows.", MAX_TRANSPARENCY),
		}
	}
});

/**
 * The Vantrex Liquid Glass theme: the window itself turns into glass, the system's own Liquid Glass drawn with Metal on macOS 26,
 * with fallbacks (the older vibrancy, acrylic on Windows, a near-solid surface elsewhere). `vantrex.window.glassTransparency`
 * decides how much of the desktop shows through.
 */
class VantrexGlass extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vantrexGlass';

	private restartPrompted = false;

	constructor(
		@IWorkbenchThemeService private readonly themeService: IWorkbenchThemeService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@INotificationService private readonly notificationService: INotificationService,
		@IHostService private readonly hostService: IHostService,
	) {
		super();

		this.apply();
		this._register(this.themeService.onDidColorThemeChange(() => this.apply()));
		this._register(vantrexOnboardingState.onDidChange(() => this.apply())); // the flow ended: back to the chosen theme
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(TRANSPARENCY_SETTING)) {
				this.apply();
			}
		}));
	}

	private async apply(): Promise<void> {
		if (vantrexOnboardingState.active) {
			return; // the onboarding flow owns the window's glass while it shows
		}

		const theme = this.themeService.getColorTheme();
		const enabled = theme.settingsId === GLASS_THEME;
		const transparency = getTransparency(this.configurationService);
		const body = mainWindow.document.body;

		body.classList.toggle('vantrex-glass', enabled);

		const background = theme.getColor(editorBackground);
		const result = await this.nativeHostService.setWindowGlass({
			enabled,
			theme: 'glass',
			transparency,
			backgroundColor: background ? Color.Format.CSS.formatHex(background) : undefined,
		}).catch(() => undefined);

		// Who paints the tint: the system's glass carries it when it can; otherwise the page does, and when nothing can show
		// through (no glass on this machine, or a window that has to be reopened first) the page is nearly solid so text stays readable.
		let tint = 0;
		if (enabled) {
			if (!result || result.mode === 'none' || result.needsRestart) {
				tint = 0.95;
			} else if (result.mode !== 'native') {
				tint = (100 - transparency) / 100;
			}
		}
		body.style.setProperty('--vtx-glass-tint', String(tint));
		body.classList.toggle('vantrex-glass-native', enabled && result?.mode === 'native' && !result.needsRestart);

		if (enabled && result?.needsRestart && !this.restartPrompted) {
			this.restartPrompted = true;
			this.notificationService.prompt(
				Severity.Info,
				localize('vantrexGlassRestart', "The Liquid Glass theme shows your desktop through the window. Restart to turn that on."),
				[{ label: localize('vantrexGlassRestartNow', "Restart"), run: () => this.hostService.restart() }]
			);
		}
	}
}

function getTransparency(configurationService: IConfigurationService): number {
	const value = configurationService.getValue<number>(TRANSPARENCY_SETTING);
	return typeof value === 'number' && isFinite(value) ? Math.max(0, Math.min(MAX_TRANSPARENCY, Math.round(value))) : DEFAULT_TRANSPARENCY;
}

registerWorkbenchContribution2(VantrexGlass.ID, VantrexGlass, WorkbenchPhase.AfterRestored);

registerAction2(class SetGlassTransparency extends Action2 {

	constructor() {
		super({
			id: 'vantrex.glass.setTransparency',
			title: localize2('vantrexSetGlassTransparency', "Set Window Transparency..."),
			category: localize2('vantrexCategory', "Vantrex"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const configurationService = accessor.get(IConfigurationService);
		const current = getTransparency(configurationService);

		const levels = [0, 30, 50, 65, 80, 90, MAX_TRANSPARENCY];
		const items: (IQuickPickItem & { value: number })[] = levels.map(value => ({
			value,
			label: value === 0 ? localize('vantrexGlassSolid', "Solid") : localize('vantrexGlassPercent', "{0}% transparent", value),
			description: value === current ? localize('vantrexGlassCurrent', "current") : undefined,
		}));

		const picked = await quickInputService.pick(items, {
			placeHolder: localize('vantrexGlassPlaceholder', "How see-through should the Liquid Glass window be?"),
			activeItem: items.find(item => item.value === current),
		});
		if (picked) {
			await configurationService.updateValue(TRANSPARENCY_SETTING, picked.value, ConfigurationTarget.USER);
		}
	}
});
