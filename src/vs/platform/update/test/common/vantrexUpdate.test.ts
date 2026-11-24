/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { compareVersions, findChecksum, findChecksumsUrl, getReleaseNotesMediaBase, getReleaseNotesUrl, getReleaseVersion, isUpdateCandidate, selectReleaseAsset, shouldShowReleaseNotes, versionFromTag } from '../../common/vantrexUpdate.js';

suite('Vantrex update', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('compareVersions', () => {
		assert.deepStrictEqual({
			older: compareVersions('0.1.8', '0.1.9'),
			newer: compareVersions('0.2.0', '0.1.9'),
			same: compareVersions('v0.1.8', '0.1.8'),
			tenIsAboveNine: (compareVersions('0.1.10', '0.1.9') ?? 0) > 0,
			preIsBelowFinal: (compareVersions('0.2.0-beta.1', '0.2.0') ?? 0) < 0,
			betaOrder: (compareVersions('0.2.0-beta.2', '0.2.0-beta.10') ?? 0) < 0,
			notAVersion: compareVersions('main', '0.1.8'),
		}, {
			older: -1,
			newer: 1,
			same: 0,
			tenIsAboveNine: true,
			preIsBelowFinal: true,
			betaOrder: true,
			notAVersion: undefined,
		});
	});

	test('selectReleaseAsset picks this platform and arch', () => {
		const release = {
			tag_name: 'v0.1.8',
			assets: [
				{ name: 'SHA256SUMS.txt', browser_download_url: 'https://example.test/sums' },
				{ name: 'Vantrex-0.1.8-darwin-arm64.zip', size: 10, browser_download_url: 'https://example.test/mac-arm' },
				{ name: 'Vantrex-0.1.8-darwin-x64.zip', size: 11, browser_download_url: 'https://example.test/mac-x64' },
				{ name: 'Vantrex-0.1.8-linux-x64.tar.gz', size: 12, browser_download_url: 'https://example.test/linux' },
				{ name: 'Vantrex-0.1.8-win32-x64.zip', size: 13, browser_download_url: 'https://example.test/win' },
			],
		};

		assert.deepStrictEqual({
			macArm: selectReleaseAsset(release, 'darwin', 'arm64')?.url,
			macIntel: selectReleaseAsset(release, 'darwin', 'x64')?.url,
			linux: selectReleaseAsset(release, 'linux', 'x64')?.name,
			windows: selectReleaseAsset(release, 'win32', 'x64')?.name,
			linuxArm: selectReleaseAsset(release, 'linux', 'arm64'),
			checksums: findChecksumsUrl(release),
			otherVersionIsNotMatched: selectReleaseAsset({ ...release, tag_name: 'v0.1.9' }, 'linux', 'x64'),
		}, {
			macArm: 'https://example.test/mac-arm',
			macIntel: 'https://example.test/mac-x64',
			linux: 'Vantrex-0.1.8-linux-x64.tar.gz',
			windows: 'Vantrex-0.1.8-win32-x64.zip',
			linuxArm: undefined,
			checksums: 'https://example.test/sums',
			otherVersionIsNotMatched: undefined,
		});
	});

	test('findChecksum reads sha256sum text', () => {
		const a = 'a'.repeat(64);
		const b = 'B'.repeat(64);
		const text = `${a}  Vantrex-0.1.8-linux-x64.tar.gz\r\n${b} *Vantrex-0.1.8-win32-x64.zip\n\nnot a line\n`;

		assert.deepStrictEqual({
			linux: findChecksum(text, 'Vantrex-0.1.8-linux-x64.tar.gz'),
			windows: findChecksum(text, 'Vantrex-0.1.8-win32-x64.zip'),
			missing: findChecksum(text, 'Vantrex-0.1.8-darwin-arm64.zip'),
			partialNameIsNotMatched: findChecksum(text, '0.1.8-linux-x64.tar.gz'),
		}, {
			linux: a,
			windows: b.toLowerCase(),
			missing: undefined,
			partialNameIsNotMatched: undefined,
		});
	});

	test('isUpdateCandidate and versionFromTag', () => {
		assert.deepStrictEqual({
			final: isUpdateCandidate({ tag_name: 'v1.0.0' }),
			draft: isUpdateCandidate({ tag_name: 'v1.0.0', draft: true }),
			prerelease: isUpdateCandidate({ tag_name: 'v1.0.0', prerelease: true }),
			noTag: isUpdateCandidate({}),
			tag: versionFromTag('v0.1.8'),
		}, {
			final: true,
			draft: false,
			prerelease: false,
			noTag: false,
			tag: '0.1.8',
		});
	});

	test('release notes address and when to show them', () => {
		const template = 'https://raw.example.test/v{version}/release-notes/v{version}.md';

		assert.deepStrictEqual({
			url: getReleaseNotesUrl(template, '0.1.12'),
			urlFromTag: getReleaseNotesUrl(template, 'v0.1.12'),
			media: getReleaseNotesMediaBase(template, '0.1.12'),
			stamped: getReleaseVersion({ vantrexVersion: '0.1.12', version: '1.148.0' }),
			unstamped: getReleaseVersion({ version: '1.148.0' }),
			firstRun: shouldShowReleaseNotes(undefined, '0.1.12'),
			sameVersion: shouldShowReleaseNotes('0.1.12', '0.1.12'),
			update: shouldShowReleaseNotes('0.1.11', '0.1.12'),
			skippedVersions: shouldShowReleaseNotes('0.1.9', '0.1.12'),
			tenIsNewerThanNine: shouldShowReleaseNotes('0.1.9', '0.1.10'),
			downgrade: shouldShowReleaseNotes('0.1.12', '0.1.11'),
			garbage: shouldShowReleaseNotes('1.148.0-x', 'dev'),
		}, {
			url: 'https://raw.example.test/v0.1.12/release-notes/v0.1.12.md',
			urlFromTag: 'https://raw.example.test/v0.1.12/release-notes/v0.1.12.md',
			media: 'https://raw.example.test/v0.1.12/release-notes/images/',
			stamped: '0.1.12',
			unstamped: '1.148.0',
			firstRun: false,
			sameVersion: false,
			update: true,
			skippedVersions: true,
			tenIsNewerThanNine: true,
			downgrade: false,
			garbage: false,
		});
	});
});
