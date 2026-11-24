/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure helpers for the Vantrex updater: it reads the GitHub Releases of the Vantrex IDE
 * (`updateUrl` in product.json), picks the archive for this platform and checks it against
 * the release's SHA256SUMS file. Nothing here touches the disk or the network.
 */

/** The parts of a GitHub release the updater reads. */
export interface IVantrexRelease {
	readonly tag_name?: string;
	readonly draft?: boolean;
	readonly prerelease?: boolean;
	readonly html_url?: string;
	readonly published_at?: string;
	readonly assets?: readonly IVantrexReleaseAsset[];
}

export interface IVantrexReleaseAsset {
	readonly name?: string;
	readonly size?: number;
	readonly browser_download_url?: string;
}

export interface IVantrexAsset {
	readonly name: string;
	readonly url: string;
	readonly size: number | undefined;
}

export const VANTREX_CHECKSUMS_FILE = 'SHA256SUMS.txt';

/**
 * Compares two release versions such as `0.1.8` or `v0.2.0-beta.1`. Returns a negative number when `a` is older than
 * `b`, zero when they are the same and a positive number when `a` is newer. A version with a pre-release part is older
 * than the same version without one. Returns `undefined` when either value is not a version.
 */
export function compareVersions(a: string, b: string): number | undefined {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (!pa || !pb) {
		return undefined;
	}

	for (let i = 0; i < 3; i++) {
		if (pa.numbers[i] !== pb.numbers[i]) {
			return pa.numbers[i] - pb.numbers[i];
		}
	}

	if (pa.pre.length === 0 && pb.pre.length === 0) {
		return 0;
	}
	if (pa.pre.length === 0) {
		return 1;
	}
	if (pb.pre.length === 0) {
		return -1;
	}

	for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
		const x = pa.pre[i];
		const y = pb.pre[i];
		if (x === undefined) {
			return -1;
		}
		if (y === undefined) {
			return 1;
		}
		if (x === y) {
			continue;
		}
		const xn = /^\d+$/.test(x);
		const yn = /^\d+$/.test(y);
		if (xn && yn) {
			return Number(x) - Number(y);
		}
		if (xn !== yn) {
			return xn ? -1 : 1;
		}
		return x < y ? -1 : 1;
	}

	return 0;
}

function parseVersion(value: string): { numbers: number[]; pre: string[] } | undefined {
	const match = /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<pre>[0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
	if (!match?.groups) {
		return undefined;
	}

	const { major, minor, patch, pre } = match.groups;
	return { numbers: [Number(major), Number(minor), Number(patch)], pre: pre ? pre.split('.') : [] };
}

/** Removes a leading `v` from a tag such as `v0.1.8`. */
export function versionFromTag(tag: string): string {
	return tag.trim().replace(/^v/, '');
}

/**
 * Finds the archive of a release built for this platform. Archives are named
 * `Vantrex-<version>-<platform>-<arch>.<zip|tar.gz>`, for example `Vantrex-0.1.8-darwin-arm64.zip`.
 */
export function selectReleaseAsset(release: IVantrexRelease, platform: string, arch: string): IVantrexAsset | undefined {
	const version = release.tag_name ? versionFromTag(release.tag_name) : undefined;
	if (!version) {
		return undefined;
	}

	const expected = `Vantrex-${version}-${platform}-${arch}`;
	for (const asset of release.assets ?? []) {
		if (!asset.name || !asset.browser_download_url) {
			continue;
		}
		if (asset.name === `${expected}.zip` || asset.name === `${expected}.tar.gz`) {
			return { name: asset.name, url: asset.browser_download_url, size: asset.size };
		}
	}

	return undefined;
}

/** The download address of the checksums file of a release. */
export function findChecksumsUrl(release: IVantrexRelease): string | undefined {
	return release.assets?.find(asset => asset.name === VANTREX_CHECKSUMS_FILE)?.browser_download_url;
}

/**
 * Reads the SHA-256 of a file from the text of a `sha256sum` file, whose lines look like `<64 hex>  <name>` or
 * `<64 hex> *<name>`. Returns the lower-case hash, or `undefined` when the file is not listed.
 */
export function findChecksum(text: string, fileName: string): string | undefined {
	for (const line of text.split(/\r?\n/)) {
		const match = /^(?<hash>[0-9a-fA-F]{64})\s+\*?(?<name>.+?)\s*$/.exec(line);
		if (match?.groups && match.groups.name === fileName) {
			return match.groups.hash.toLowerCase();
		}
	}

	return undefined;
}

/** Whether a release can be offered as an update: a published, final release. */
export function isUpdateCandidate(release: IVantrexRelease): boolean {
	return !!release.tag_name && !release.draft && !release.prerelease;
}
