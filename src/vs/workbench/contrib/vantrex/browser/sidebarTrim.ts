/*---------------------------------------------------------------------------------------------
 *  Vantrex: a quiet Explorer. Hides the Outline and Timeline sections once, the first time the window starts. They stay
 *  one click away (Explorer "..." menu, or the command bar), and if the person shows them again they are left alone.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';

const TRIMMED_KEY = 'vantrex.explorerTrimmed';
const SECTIONS_TO_HIDE = ['outline', 'timeline'];

class VantrexSidebarTrim extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vantrexSidebarTrim';

	constructor(
		@IViewsService viewsService: IViewsService,
		@IStorageService storageService: IStorageService,
	) {
		super();

		if (storageService.getBoolean(TRIMMED_KEY, StorageScope.PROFILE, false)) {
			return;
		}
		storageService.store(TRIMMED_KEY, true, StorageScope.PROFILE, StorageTarget.MACHINE);
		for (const id of SECTIONS_TO_HIDE) {
			if (viewsService.isViewVisible(id)) {
				viewsService.closeView(id);
			}
		}
	}
}

registerWorkbenchContribution2(VantrexSidebarTrim.ID, VantrexSidebarTrim, WorkbenchPhase.AfterRestored);
