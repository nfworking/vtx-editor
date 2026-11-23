/*---------------------------------------------------------------------------------------------
 *  Vantrex: default settings that make the workbench quiet. Every one can be changed in Settings; these are only the
 *  starting values. Kept in one place so the Vantrex look does not spread through registrations in the rest of the code.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		// Title bar: the floating command bar replaces the search box and the layout buttons.
		'window.commandCenter': false,
		'workbench.layoutControl.enabled': false,

		// Side bar: only what is needed, and no empty secondary side bar on the right.
		'workbench.secondarySideBar.defaultVisibility': 'hidden',
		'explorer.openEditors.visible': 0,

		// Editor: calm by default.
		'breadcrumbs.enabled': false,
		'editor.minimap.enabled': false,
		'editor.scrollBeyondLastLine': false,
		'editor.smoothScrolling': true,
		'editor.cursorBlinking': 'smooth',
		'editor.cursorSmoothCaretAnimation': 'on',
		'editor.padding.top': 12,
		'editor.overviewRulerBorder': false,
		'editor.hideCursorInOverviewRuler': true,
		'editor.renderLineHighlight': 'line',
		'editor.guides.bracketPairs': false,
		'editor.stickyScroll.enabled': false,

		// This is your own tool: no trust prompts, no tips, no telemetry, no recommendations.
		'security.workspace.trust.enabled': false,
		'workbench.tips.enabled': false,
		'workbench.welcomePage.walkthroughs.openOnInstall': false,
		'telemetry.telemetryLevel': 'off',
		'extensions.ignoreRecommendations': true,
		'workbench.enableExperiments': false,
		'update.mode': 'none',
	}
}]);
