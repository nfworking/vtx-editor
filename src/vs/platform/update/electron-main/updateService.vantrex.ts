/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { rm, readdir } from 'fs/promises';
import { join } from 'path';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { Delayer } from '../../../base/common/async.js';
import { transform } from '../../../base/common/stream.js';
import { URI } from '../../../base/common/uri.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { IFileService } from '../../files/common/files.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IMeteredConnectionService } from '../../meteredConnection/common/meteredConnection.js';
import { INativeHostMainService } from '../../native/electron-main/nativeHostMainService.js';
import { IProductService } from '../../product/common/productService.js';
import { asJson, asText, IRequestService } from '../../request/common/request.js';
import { IApplicationStorageMainService } from '../../storage/electron-main/storageMainService.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { AvailableForDownload, IQuitAndInstallOptions, IUpdate, State, StateType, UpdateType } from '../common/update.js';
import { compareVersions, findChecksum, findChecksumsUrl, isUpdateCandidate, IVantrexRelease, selectReleaseAsset, versionFromTag } from '../common/vantrexUpdate.js';
import { AbstractUpdateService, IUpdateURLOptions } from './abstractUpdateService.js';
import { canReplaceInstall, extractRelease, getInstallTarget, IVantrexInstallTarget, looksLikeEditor, writeSwapScript } from './vantrexInstall.js';

const UPDATE_DIR = 'vantrex-update';

/**
 * Keeps the Vantrex IDE up to date on every platform. It reads the latest GitHub release named by `updateUrl` in
 * product.json, downloads the archive built for this platform, checks it against the release's SHA256SUMS, unpacks it
 * and, when the editor restarts, swaps it in place. When the editor cannot replace itself (the folder is read-only, or
 * macOS is running the app from a temporary location) it offers the download in the browser instead.
 */
export class VantrexUpdateService extends AbstractUpdateService {

	private pending: { readonly update: IUpdate; readonly unpacked: string; readonly target: IVantrexInstallTarget } | undefined;
	private inflight: CancellationTokenSource | undefined;

	constructor(
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@IConfigurationService configurationService: IConfigurationService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@IRequestService requestService: IRequestService,
		@ILogService logService: ILogService,
		@IProductService productService: IProductService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IApplicationStorageMainService applicationStorageMainService: IApplicationStorageMainService,
		@IMeteredConnectionService meteredConnectionService: IMeteredConnectionService,
		@IFileService private readonly fileService: IFileService,
		@INativeHostMainService private readonly nativeHostMainService: INativeHostMainService,
	) {
		super(lifecycleMainService, configurationService, environmentMainService, requestService, logService, productService, telemetryService, applicationStorageMainService, meteredConnectionService, false);
	}

	private get cacheDir(): string {
		return join(this.environmentMainService.userDataPath, UPDATE_DIR);
	}

	protected override getUpdateType(): UpdateType {
		return UpdateType.Archive;
	}

	protected buildUpdateFeedUrl(_quality: string, _commit: string, _options?: IUpdateURLOptions): string | undefined {
		const url = this.productService.updateUrl;
		return url && /^https:\/\//.test(url) ? url : undefined;
	}

	protected override async postInitialize(): Promise<void> {
		// A copy unpacked by an earlier run that was never installed is stale: remove it.
		await this.removeStaleStaging().catch(err => this.logService.warn('update#postInitialize - could not remove old update files', err));
	}

	protected doCheckForUpdates(explicit: boolean): void {
		const feed = this.buildUpdateFeedUrl('', '');
		const current = this.productService.vantrexVersion;

		if (!feed || !current) {
			this.logService.info('update#check - no feed or no release version in this build; nothing to check');
			this.setState(State.Idle(UpdateType.Archive, undefined, explicit || undefined));
			return;
		}

		this.setState(State.CheckingForUpdates(explicit));
		this.check(feed, current, explicit).catch(err => {
			this.logService.error('update#check failed', err);
			if (this.state.type === StateType.CheckingForUpdates || this.state.type === StateType.Downloading) {
				this.setState(State.Idle(UpdateType.Archive, explicit ? String(err?.message ?? err) : undefined));
			}
		});
	}

	private async check(feed: string, current: string, explicit: boolean): Promise<void> {
		const release = await this.fetchJson<IVantrexRelease>(feed, CancellationToken.None);
		if (this.state.type !== StateType.CheckingForUpdates) {
			return; // disabled or cancelled while the request was in flight
		}

		const asset = release && isUpdateCandidate(release) ? selectReleaseAsset(release, process.platform, process.arch) : undefined;
		const latest = release?.tag_name ? versionFromTag(release.tag_name) : undefined;
		const order = latest ? compareVersions(latest, current) : undefined;

		if (!release || !latest || !asset || order === undefined || order <= 0) {
			this.logService.info(`update#check - up to date (this build ${current}, latest ${latest ?? 'unknown'}${release && !asset ? ', no archive for this platform' : ''})`);
			this.setState(State.Idle(UpdateType.Archive, undefined, explicit || undefined));
			return;
		}

		const checksumsUrl = findChecksumsUrl(release);
		const update: IUpdate = { version: release.tag_name!, productVersion: latest, url: asset.url, timestamp: release.published_at ? Date.parse(release.published_at) : undefined };

		const target = getInstallTarget(process.platform, process.execPath, this.cacheDir);
		const canInstall = !!target && !!checksumsUrl && await canReplaceInstall(target);
		this.logService.info(`update#check - ${latest} is available (this build ${current}); can install in place: ${canInstall}${target?.blockedReason ? ` (${target.blockedReason})` : ''}`);

		if (!canInstall || this.deferAutomaticDownload(update, explicit)) {
			if (!canInstall) {
				this.setState(State.AvailableForDownload(update, false));
			}
			return;
		}

		await this.download(update, asset.name, checksumsUrl!, target!, explicit);
	}

	protected override async doDownloadUpdate(state: AvailableForDownload): Promise<void> {
		const release = await this.fetchJson<IVantrexRelease>(this.buildUpdateFeedUrl('', '')!, CancellationToken.None).catch(() => undefined);
		const asset = release ? selectReleaseAsset(release, process.platform, process.arch) : undefined;
		const checksumsUrl = release ? findChecksumsUrl(release) : undefined;
		const target = getInstallTarget(process.platform, process.execPath, this.cacheDir);

		if (!release || !asset || !checksumsUrl || !target || !(await canReplaceInstall(target))) {
			// The editor cannot replace itself here: let the browser download the archive.
			if (state.update.url) {
				await this.nativeHostMainService.openExternal(undefined, state.update.url);
			}
			this.setState(State.Idle(UpdateType.Archive));
			return;
		}

		await this.download(state.update, asset.name, checksumsUrl, target, true).catch(err => {
			this.logService.error('update#download failed', err);
			this.setState(State.Idle(UpdateType.Archive, String(err?.message ?? err)));
		});
	}

	private async download(update: IUpdate, assetName: string, checksumsUrl: string, target: IVantrexInstallTarget, explicit: boolean): Promise<void> {
		this.inflight?.dispose(true);
		const cts = this.inflight = new CancellationTokenSource();
		const startTime = Date.now();
		this.setState(State.Downloading(update, explicit, false, 0, undefined, startTime));

		try {
			const workDir = join(this.cacheDir, versionFromTag(update.version));
			await rm(workDir, { recursive: true, force: true });
			const archive = join(workDir, assetName);

			const checksums = await this.fetchText(checksumsUrl, cts.token);
			const expected = checksums ? findChecksum(checksums, assetName) : undefined;
			if (!expected) {
				throw new Error('The update could not be verified: its checksum is missing.');
			}

			await this.downloadFile(update.url!, archive, update, explicit, startTime, cts.token);
			if (cts.token.isCancellationRequested) {
				return;
			}

			const actual = await sha256(archive);
			if (actual !== expected) {
				await rm(workDir, { recursive: true, force: true });
				throw new Error('The downloaded update did not match its checksum and was discarded.');
			}

			const stage = join(target.stagingParent, `.vantrex-update-${versionFromTag(update.version)}`);
			const unpacked = await extractRelease(process.platform, archive, stage);
			if (!(await looksLikeEditor(process.platform, unpacked, target))) {
				await rm(stage, { recursive: true, force: true });
				throw new Error('The downloaded update is incomplete and was discarded.');
			}
			await rm(workDir, { recursive: true, force: true }); // the archive is no longer needed

			if (cts.token.isCancellationRequested) {
				await rm(stage, { recursive: true, force: true });
				return;
			}

			this.pending = { update: { ...update, sha256hash: expected }, unpacked, target };
			this.setState(State.Ready(this.pending.update, explicit, false));
		} finally {
			if (this.inflight === cts) {
				this.inflight = undefined;
			}
			cts.dispose();
		}
	}

	private async downloadFile(url: string, path: string, update: IUpdate, explicit: boolean, startTime: number, token: CancellationToken): Promise<void> {
		const context = await this.requestService.request({ url, callSite: 'updateService.vantrex.download' }, token);
		if (context.res.statusCode !== 200) {
			throw new Error(`The update could not be downloaded (status ${context.res.statusCode}).`);
		}

		const lengthHeader = context.res.headers['content-length'];
		const totalBytes = typeof lengthHeader === 'string' ? parseInt(lengthHeader, 10) : undefined;
		let downloadedBytes = 0;
		const progress = new Delayer<void>(500);
		const stream = transform<VSBuffer, VSBuffer>(context.stream, {
			data: data => {
				downloadedBytes += data.byteLength;
				progress.trigger(async () => {
					if (this.state.type === StateType.Downloading) {
						this.setState(State.Downloading(update, explicit, false, downloadedBytes, totalBytes, startTime));
					}
				});
				return data;
			}
		}, chunks => VSBuffer.concat(chunks));

		try {
			await this.fileService.writeFile(URI.file(path), stream);
		} finally {
			progress.dispose();
		}
	}

	private async fetchJson<T>(url: string, token: CancellationToken): Promise<T | null> {
		const context = await this.requestService.request({ url, headers: this.requestHeaders(), callSite: 'updateService.vantrex.check' }, token);
		return context.res.statusCode === 200 ? asJson<T>(context) : null;
	}

	private async fetchText(url: string, token: CancellationToken): Promise<string | null> {
		const context = await this.requestService.request({ url, headers: this.requestHeaders(), callSite: 'updateService.vantrex.checksums' }, token);
		return context.res.statusCode === 200 ? asText(context) : null;
	}

	private requestHeaders(): Record<string, string> {
		return {
			'Accept': 'application/vnd.github+json',
			'User-Agent': `Vantrex-IDE/${this.productService.vantrexVersion ?? 'dev'}`,
		};
	}

	protected override doQuitAndInstall(_options?: IQuitAndInstallOptions): void {
		const pending = this.pending;
		if (!pending || (this.state.type !== StateType.Ready && this.state.type !== StateType.Restarting)) {
			return;
		}

		const { target, unpacked } = pending;
		this.logService.info(`update#quitAndInstall - installing ${pending.update.productVersion} over ${target.root}`);

		// Written and started synchronously enough that it outlives this process: it waits for our pid to exit.
		const log = join(this.cacheDir, 'update.log');
		void writeSwapScript(target.platform, this.cacheDir).then(script => {
			const args = [String(process.pid), target.root, unpacked, target.launch, log];
			const child = target.platform === 'win32'
				? spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, ...args], { detached: true, stdio: 'ignore', windowsHide: true })
				: spawn('/bin/sh', [script, ...args], { detached: true, stdio: 'ignore' });
			child.unref();
		}).catch(err => this.logService.error('update#quitAndInstall - could not start the installer script', err));
	}

	protected override async cancelPendingUpdate(): Promise<void> {
		this.inflight?.cancel();
		const pending = this.pending;
		this.pending = undefined;
		if (pending) {
			await rm(pending.unpacked, { recursive: true, force: true });
		}
	}

	protected override async cancelUpdate(): Promise<void> {
		await this.cancelPendingUpdate();
	}

	protected override async doIsLatestVersion(): Promise<boolean | undefined> {
		return undefined;
	}

	private async removeStaleStaging(): Promise<void> {
		await rm(this.cacheDir, { recursive: true, force: true });
		const target = getInstallTarget(process.platform, process.execPath, this.cacheDir);
		if (!target || target.platform === 'win32') {
			return;
		}
		for (const name of await readdir(target.stagingParent).catch(() => [] as string[])) {
			if (name.startsWith('.vantrex-update-')) {
				await rm(join(target.stagingParent, name), { recursive: true, force: true });
			}
		}
	}
}

function sha256(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		createReadStream(path).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
	});
}
