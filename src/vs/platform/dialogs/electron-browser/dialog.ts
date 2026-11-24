/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isLinuxSnap } from '../../../base/common/platform.js';
import { localize } from '../../../nls.js';
import { IOSProperties } from '../../native/common/native.js';
import { IProductService } from '../../product/common/productService.js';

/** The operating system as a person would name it, such as "macOS 15.1". */
function formatOperatingSystem(osProps: IOSProperties): string {
	switch (osProps.platform) {
		case 'darwin':
			return `macOS ${osProps.systemVersion ?? osProps.release}`;
		case 'win32':
			return `Windows ${osProps.systemVersion ?? osProps.release}`;
		default:
			return `${osProps.type} ${osProps.release}${isLinuxSnap ? ' snap' : ''}`;
	}
}

/** The day a build was made, such as "2026-11-23", from the build timestamp. */
export function formatBuildDate(date: string | undefined): string {
	return date?.slice(0, 10) || 'Unknown';
}

/** The text of the About dialog: the Vantrex version, when it was built, and the operating system. */
export function createNativeAboutDialogDetails(productService: IProductService, osProps: IOSProperties): { title: string; details: string; detailsToCopy: string } {
	const details = localize('aboutDetail', "Version: {0}\nBuilt: {1}\nOS: {2}",
		productService.vantrexVersion || productService.version,
		formatBuildDate(productService.date),
		formatOperatingSystem(osProps)
	);

	return {
		title: productService.nameLong,
		details,
		detailsToCopy: details
	};
}
