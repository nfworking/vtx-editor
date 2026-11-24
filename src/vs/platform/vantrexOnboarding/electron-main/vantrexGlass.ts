/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import electron from 'electron';
import type { BrowserWindow } from 'electron';
import { join } from '../../../base/common/path.js';
import { isMacintosh, isWindows } from '../../../base/common/platform.js';
import { ILogService } from '../../log/common/log.js';
import { GlassMode, IGlassResult, IGlassTint } from '../common/vantrexOnboarding.js';

/** The native addon (glass.mm): the system's Liquid Glass behind the web content of a window. macOS only. */
interface IGlassAddon {
	isSupported(): boolean;
	apply(handle: Buffer, options: { style: string; cornerRadius: number; tintR: number; tintG: number; tintB: number; tintA: number; appearance: string }): boolean;
	remove(handle: Buffer): boolean;
	describe(handle: Buffer): string;
}

let addon: IGlassAddon | null | undefined;

/** Loads the addon once. Returns nothing when this is not a Mac with native Liquid Glass and Metal, or when it cannot be loaded. */
export function loadGlassAddon(appRoot: string, logService?: ILogService): IGlassAddon | undefined {
	if (addon !== undefined) {
		return addon ?? undefined;
	}

	addon = null;
	if (!isMacintosh) {
		return undefined;
	}

	try {
		const module = { exports: {} as IGlassAddon };
		process.dlopen(module, join(appRoot, 'out', 'vs', 'platform', 'vantrexOnboarding', 'electron-main', 'vantrex-glass.node'));
		if (module.exports.isSupported()) {
			addon = module.exports;
		} else {
			logService?.info('vantrexGlass - native Liquid Glass is not available on this Mac, using the vibrancy fallback');
		}
	} catch (error) {
		logService?.warn('vantrexGlass - could not load the native glass addon, using the vibrancy fallback', error);
	}

	return addon ?? undefined;
}

/** Which kind of glass this machine can show. */
export function getGlassMode(appRoot: string, logService?: ILogService): GlassMode {
	if (isMacintosh) {
		return loadGlassAddon(appRoot, logService) ? 'native' : 'vibrancy';
	}
	return isWindows ? 'acrylic' : 'none';
}

// A window only shows what is behind it when it was created see-through (macOS), so the ones that were are remembered.
const transparentWindows = new WeakSet<BrowserWindow>();

export function markTransparent(win: BrowserWindow): void {
	transparentWindows.add(win);
}

/** A window created see-through keeps a clear background for good: the page paints whatever surface a theme needs. */
export function isTransparentWindow(win: BrowserWindow): boolean {
	return transparentWindows.has(win);
}

export interface IApplyGlassOptions {
	readonly enabled: boolean;
	readonly tint?: IGlassTint;
	/** Rounding of the glass itself: for a window that has no frame. */
	readonly cornerRadius?: number;
	/** The colour the window goes back to when glass is turned off. */
	readonly restoreBackground?: string;
}

/** Turns glass on or off for a window, with the best kind this machine has. */
export function applyWindowGlass(win: BrowserWindow, appRoot: string, options: IApplyGlassOptions, logService?: ILogService): IGlassResult {
	if (win.isDestroyed()) {
		return { mode: 'none', needsRestart: false };
	}

	const mode = getGlassMode(appRoot, logService);
	const needsRestart = options.enabled && isMacintosh && !transparentWindows.has(win);

	if (mode === 'native') {
		const native = loadGlassAddon(appRoot)!;
		if (options.enabled) {
			const tint = options.tint;
			native.apply(win.getNativeWindowHandle(), {
				style: 'clear',
				cornerRadius: options.cornerRadius ?? 0,
				tintR: tint?.r ?? 0, tintG: tint?.g ?? 0, tintB: tint?.b ?? 0, tintA: tint?.a ?? 0,
				appearance: tint?.appearance ?? '',
			});
			win.setVibrancy(null);
			if (transparentWindows.has(win)) {
				win.setBackgroundColor('#00000000');
			}
		} else {
			native.remove(win.getNativeWindowHandle());
			if (!transparentWindows.has(win)) {
				win.setBackgroundColor(options.restoreBackground ?? '#000000');
			}
		}
	} else if (mode === 'vibrancy') {
		win.setVibrancy(options.enabled ? 'under-window' : null);
		if (options.enabled || !transparentWindows.has(win)) {
			win.setBackgroundColor(options.enabled ? '#00000000' : (options.restoreBackground ?? '#000000'));
		}
	} else if (mode === 'acrylic') {
		win.setBackgroundMaterial(options.enabled ? 'acrylic' : 'none');
		win.setBackgroundColor(options.enabled ? '#00000000' : (options.restoreBackground ?? '#000000'));
	}

	return { mode, needsRestart };
}

// #region The first-run window: the editor window itself starts small and clean, and grows into the editor when the flow is done

let onboardingClaimed = false;
let onboardingWindowId: number | undefined;
let claimJustMade = false;

/**
 * Called once as the first editor window is being set up: whether this start is the first run, so that the window should be
 * created as the small onboarding window. Only the first window of a run can claim it.
 */
export function claimOnboarding(alreadyDone: boolean): boolean {
	if (onboardingClaimed || process.env['VTX_SKIP_ONBOARDING']) { // the variable is for tests and automation
		return false;
	}
	onboardingClaimed = true;
	claimJustMade = !alreadyDone;
	return claimJustMade;
}

/** Right after the claiming window was created: remember it. */
export function takeOnboardingClaim(win: BrowserWindow): void {
	if (claimJustMade) {
		claimJustMade = false;
		onboardingWindowId = win.id;
	}
}

export function isOnboardingWindow(win: BrowserWindow): boolean {
	return onboardingWindowId === win.id;
}

/** Starts the flow in a window: no window controls, a fixed size, on a plain opaque surface. */
export function enterOnboarding(win: BrowserWindow, appRoot: string, resizeWindow: boolean, logService?: ILogService): IGlassResult {
	if (resizeWindow) {
		if (isMacintosh) {
			win.setWindowButtonVisibility(false);
		}
		win.setResizable(false);
	}

	return { mode: 'none', needsRestart: false };
}

/** Ends the flow: the window gets its controls back and grows, smoothly, to the size of the editor. Resolves when it has finished. */
export async function leaveOnboarding(win: BrowserWindow, resizeWindow: boolean): Promise<void> {
	if (win.isDestroyed() || !resizeWindow) {
		return;
	}

	if (isMacintosh) {
		win.setWindowButtonVisibility(true);
	}
	win.setResizable(true);

	const workArea = electron.screen.getDisplayMatching(win.getBounds()).workArea;
	const width = Math.min(1440, Math.round(workArea.width * 0.86));
	const height = Math.min(960, Math.round(workArea.height * 0.86));
	const target = { x: workArea.x + Math.round((workArea.width - width) / 2), y: workArea.y + Math.round((workArea.height - height) / 2), width, height };

	if (isMacintosh) {
		win.setBounds(target, true); // the system animates this one
		await new Promise<void>(resolve => setTimeout(resolve, 480));
		return;
	}

	// Elsewhere the window is moved a little each frame, easing out.
	const from = win.getBounds();
	const frames = 28;
	await new Promise<void>(resolve => {
		let frame = 0;
		const timer = setInterval(() => {
			frame++;
			const t = 1 - Math.pow(1 - frame / frames, 3);
			if (win.isDestroyed()) {
				clearInterval(timer);
				return resolve();
			}
			win.setBounds({
				x: Math.round(from.x + (target.x - from.x) * t),
				y: Math.round(from.y + (target.y - from.y) * t),
				width: Math.round(from.width + (target.width - from.width) * t),
				height: Math.round(from.height + (target.height - from.height) * t),
			});
			if (frame >= frames) {
				clearInterval(timer);
				resolve();
			}
		}, 15);
	});
}

/** The first notification a macOS app shows is what makes the system ask for permission, so this shows a real one. */
export function requestNotifications(): Promise<'allowed' | 'denied'> {
	if (!electron.Notification.isSupported()) {
		return Promise.resolve('denied');
	}

	return new Promise(resolve => {
		const notification = new electron.Notification({ title: 'Build notifications are on', body: 'Vantrex will tell you when a deployment finishes or fails.' });
		const timer = setTimeout(() => resolve('denied'), 45_000);
		notification.once('show', () => { clearTimeout(timer); resolve('allowed'); });
		notification.once('failed', () => { clearTimeout(timer); resolve('denied'); });
		notification.show();
	});
}

// #endregion
