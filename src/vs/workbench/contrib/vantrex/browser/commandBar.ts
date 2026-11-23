/*---------------------------------------------------------------------------------------------
 *  Vantrex: the floating command bar. A slim pill centred at the top of the window that opens the quick access (files by
 *  name, ">" for commands). It replaces the title bar's search box. Pure UI: it only runs the existing quick open command.
 *--------------------------------------------------------------------------------------------*/

import './media/commandBar.css';
import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';

const OPEN_COMMAND = 'workbench.action.quickOpen';

class VantrexCommandBar extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vantrexCommandBar';

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super();

		const bar = append(layoutService.mainContainer, $('button.vtx-commandbar'));
		bar.setAttribute('type', 'button');
		bar.setAttribute('aria-label', 'Search files and run commands');

		append(bar, $('span.vtx-commandbar-dot'));
		append(bar, $('span.vtx-commandbar-text', undefined, 'Search files, or type > for commands'));
		const keys = append(bar, $('span.vtx-commandbar-keys'));

		const updateKeys = () => {
			keys.textContent = this.keybindingService.lookupKeybinding(OPEN_COMMAND)?.getLabel() ?? '';
		};
		updateKeys();
		this._register(this.keybindingService.onDidUpdateKeybindings(updateKeys));

		this._register(addDisposableListener(bar, EventType.CLICK, () => this.commandService.executeCommand(OPEN_COMMAND)));
		this._register({ dispose: () => bar.remove() });
	}
}

registerWorkbenchContribution2(VantrexCommandBar.ID, VantrexCommandBar, WorkbenchPhase.AfterRestored);
