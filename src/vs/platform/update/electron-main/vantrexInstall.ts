/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile, spawn } from 'child_process';
import { constants } from 'fs';
import { access, mkdir, readdir, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';

/**
 * Where the running copy of the editor is installed and how a new copy replaces it. The editor is not installed by an
 * installer: macOS runs `Vantrex.app` from a folder, Linux runs the extracted folder, Windows runs the unzipped
 * folder. An update is therefore the same three steps everywhere: unpack the new copy, wait for this process to exit,
 * swap it in and start it again.
 */
export interface IVantrexInstallTarget {
	readonly platform: 'darwin' | 'linux' | 'win32';
	/** The folder (or `.app`) that holds the running copy and is replaced by an update. */
	readonly root: string;
	/** What to start again after the swap. */
	readonly launch: string;
	/** Where the new copy is unpacked: next to `root` on macOS and Linux so that the swap is a rename. */
	readonly stagingParent: string;
	/** Why the editor cannot update itself in place, when that is so. */
	readonly blockedReason?: string;
}

/** Works out where the running editor is installed from the path of its executable. */
export function getInstallTarget(platform: NodeJS.Platform, execPath: string, updateCacheDir: string): IVantrexInstallTarget | undefined {
	switch (platform) {
		case 'darwin': {
			const marker = '.app/Contents/MacOS/';
			const index = execPath.indexOf(marker);
			if (index === -1) {
				return undefined;
			}
			const root = execPath.slice(0, index + '.app'.length);
			return {
				platform,
				root,
				launch: root,
				stagingParent: dirname(root),
				blockedReason: root.includes('/AppTranslocation/') ? 'The app is running from a temporary location. Move it to Applications and open it from there.' : undefined,
			};
		}
		case 'linux': {
			const root = dirname(execPath);
			return { platform, root, launch: execPath, stagingParent: dirname(root) };
		}
		case 'win32': {
			const root = dirname(execPath);
			return { platform, root, launch: execPath, stagingParent: updateCacheDir };
		}
		default:
			return undefined;
	}
}

/** Whether the current user can replace the installed copy. */
export async function canReplaceInstall(target: IVantrexInstallTarget): Promise<boolean> {
	if (target.blockedReason) {
		return false;
	}
	try {
		await access(target.root, constants.W_OK);
		await access(target.stagingParent, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function run(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, error => error ? reject(error) : resolve());
	});
}

/**
 * Deletes a folder. This cannot use `fs.rm`: inside Electron it treats a file named `*.asar` as a folder it cannot empty,
 * so a staged copy of the editor (which holds `node_modules.asar`) would be left half deleted.
 */
export async function removeTree(path: string): Promise<void> {
	if (process.platform === 'win32') {
		await run('cmd.exe', ['/d', '/c', 'rmdir', '/s', '/q', path]).catch(() => undefined);
	} else {
		await run('/bin/rm', ['-rf', path]);
	}
}

/** Unpacks a release archive into an empty `destination` and returns the path of the unpacked copy. */
export async function extractRelease(platform: NodeJS.Platform, archive: string, destination: string): Promise<string> {
	await removeTree(destination);
	await mkdir(destination, { recursive: true });

	if (platform === 'darwin') {
		await run('/usr/bin/ditto', ['-x', '-k', archive, destination]);
		const app = (await readdir(destination)).find(name => name.endsWith('.app'));
		if (!app) {
			throw new Error('The update archive does not contain an application.');
		}
		const path = join(destination, app);
		// The archive came from our own download, but clear any quarantine flag so the swapped-in app opens without a prompt.
		await run('/usr/bin/xattr', ['-cr', path]).catch(() => undefined);
		return path;
	}

	if (platform === 'linux') {
		await run('tar', ['-xzf', archive, '-C', destination]);
		const entries = await readdir(destination);
		if (entries.length !== 1) {
			throw new Error('The update archive has an unexpected layout.');
		}
		return join(destination, entries[0]);
	}

	// Windows: the archive holds the files directly. `tar` ships with Windows 10 and later and reads zip files.
	await run('tar.exe', ['-xf', archive, '-C', destination]);
	return destination;
}

/** Whether an unpacked copy looks like a complete editor, before it replaces the working one. */
export async function looksLikeEditor(platform: NodeJS.Platform, unpacked: string, installed: IVantrexInstallTarget): Promise<boolean> {
	const marker = platform === 'darwin' ? join(unpacked, 'Contents', 'Info.plist')
		: join(unpacked, basename(installed.launch));
	try {
		await access(marker, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/** The script that waits for the editor to exit, swaps the new copy in, and starts the editor again. */
export function renderUnixSwapScript(platform: 'darwin' | 'linux'): string {
	const relaunch = platform === 'darwin'
		? '/usr/bin/open "$TARGET"'
		: 'nohup "$LAUNCH" >/dev/null 2>&1 &';
	return `#!/bin/sh
# Vantrex IDE updater. Arguments: pid target staged launch log
PID="$1"; TARGET="$2"; STAGED="$3"; LAUNCH="$4"; LOG="$5"
BACKUP="$TARGET.vantrex-old"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

log "waiting for $PID to exit"
i=0
while kill -0 "$PID" 2>/dev/null; do
	i=$((i + 1))
	if [ "$i" -gt 240 ]; then log "gave up waiting"; ${relaunch}; exit 1; fi
	sleep 0.5
done

rm -rf "$BACKUP"
if mv "$TARGET" "$BACKUP"; then
	if mv "$STAGED" "$TARGET"; then
		log "updated"
		rm -rf "$BACKUP"
		rmdir "$(dirname "$STAGED")" 2>/dev/null
	else
		log "could not move the new copy into place, restoring"
		mv "$BACKUP" "$TARGET"
	fi
else
	log "could not move the old copy aside"
fi
${relaunch}
`;
}

/** The PowerShell script that does the same on Windows by copying over the installed folder. */
export function renderWindowsSwapScript(): string {
	return `param([int]$ProcessId, [string]$Target, [string]$Staged, [string]$Launch, [string]$Log)
function Write-Log($m) { Add-Content -Path $Log -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) }
Write-Log "waiting for $ProcessId to exit"
try { Wait-Process -Id $ProcessId -Timeout 120 -ErrorAction Stop } catch { }
if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) { Write-Log 'gave up waiting'; Start-Process -FilePath $Launch; exit 1 }
robocopy $Staged $Target /E /R:10 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -lt 8) { Write-Log 'updated'; Remove-Item -Recurse -Force $Staged -ErrorAction SilentlyContinue } else { Write-Log "copy failed with $LASTEXITCODE" }
Start-Process -FilePath $Launch
`;
}

export async function writeSwapScript(platform: 'darwin' | 'linux' | 'win32', directory: string): Promise<string> {
	await mkdir(directory, { recursive: true });
	const path = join(directory, platform === 'win32' ? 'vantrex-update.ps1' : 'vantrex-update.sh');
	await writeFile(path, platform === 'win32' ? renderWindowsSwapScript() : renderUnixSwapScript(platform), { mode: 0o755 });
	return path;
}

/** Starts the swap script so that it outlives this process. This must run synchronously: the process is about to exit. */
export function startSwapScript(target: IVantrexInstallTarget, script: string, args: string[]): void {
	const child = target.platform === 'win32'
		? spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, ...args], { detached: true, stdio: 'ignore', windowsHide: true })
		: spawn('/bin/sh', [script, ...args], { detached: true, stdio: 'ignore' });
	child.unref();
}
