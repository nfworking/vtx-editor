/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IOSProperties } from '../../../native/common/native.js';
import { IProductService } from '../../../product/common/productService.js';
import { createNativeAboutDialogDetails, formatBuildDate } from '../../electron-browser/dialog.js';

suite('Dialog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const productService: IProductService = {
		_serviceBrand: undefined,
		nameLong: 'Vantrex',
		version: '1.148.0',
		vantrexVersion: '0.1.9',
		date: '2026-11-24T11:45:19+10:00',
		commit: 'abc123'
	} as IProductService;

	const mac: IOSProperties = { type: 'Darwin', release: '27.2.0', systemVersion: '15.1.0', arch: 'arm64', platform: 'darwin', cpus: [] };

	test('about dialog shows only the Vantrex version, build date and macOS version', () => {
		const { title, details, detailsToCopy } = createNativeAboutDialogDetails(productService, mac);

		assert.deepStrictEqual({ title, details, detailsToCopy }, {
			title: 'Vantrex',
			details: 'Version: 0.1.9\nBuilt: 2026-11-24\nOS: macOS 15.1.0',
			detailsToCopy: 'Version: 0.1.9\nBuilt: 2026-11-24\nOS: macOS 15.1.0'
		});
	});

	test('about dialog falls back when information is missing', () => {
		const bare = { _serviceBrand: undefined, nameLong: 'Vantrex', version: '1.148.0' } as IProductService;

		assert.deepStrictEqual({
			noStampedVersion: createNativeAboutDialogDetails(bare, { ...mac, systemVersion: undefined }).details,
			windows: createNativeAboutDialogDetails(productService, { ...mac, platform: 'win32', systemVersion: '10.0.26100' }).details.split('\n')[2],
			linux: createNativeAboutDialogDetails(productService, { ...mac, platform: 'linux', type: 'Linux', release: '6.8.0' }).details.split('\n')[2],
			noDate: formatBuildDate(undefined),
		}, {
			noStampedVersion: 'Version: 1.148.0\nBuilt: Unknown\nOS: macOS 27.2.0',
			windows: 'OS: Windows 10.0.26100',
			linux: 'OS: Linux 6.8.0',
			noDate: 'Unknown',
		});
	});
});
