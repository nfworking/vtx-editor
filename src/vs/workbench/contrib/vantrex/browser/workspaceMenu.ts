/*---------------------------------------------------------------------------------------------
 *  Vantrex: puts "Open Vantrex Workspace..." where people look for it: the File menu (and so the command bar's menu on
 *  Windows and Linux). The command itself, and everything behind it, lives in extensions/vantrex-workspaces; on macOS the
 *  same command is also in the application menu (see platform/menubar).
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';

MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
	group: '1_new',
	order: 5,
	command: {
		id: 'vantrex.workspace.open',
		title: localize({ key: 'miOpenVantrexWorkspaceFile', comment: ['&& denotes a mnemonic'] }, "Open Vantrex &&Workspace...")
	}
});
