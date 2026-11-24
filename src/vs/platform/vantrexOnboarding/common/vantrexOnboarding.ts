/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How a window shows the desktop through itself:
 * - `native`: the system's Liquid Glass (macOS 26 or later with Metal), drawn by the system on the GPU.
 * - `vibrancy`: the older blurred material of macOS (before 26, or no Metal).
 * - `acrylic`: Windows 11's acrylic material.
 * - `none`: no see-through window (Linux, older Windows): the page paints a solid surface instead.
 */
export type GlassMode = 'native' | 'vibrancy' | 'acrylic' | 'none';

/** What applying glass to a window did. */
export interface IGlassResult {
	readonly mode: GlassMode;
	/** The window was not created see-through, so glass cannot show until it is reopened. */
	readonly needsRestart: boolean;
}

/** The size of the window while the flow is showing. */
export const ONBOARDING_SIZE = { width: 780, height: 540 };

export type VantrexThemeChoice = 'dark' | 'light' | 'glass';

/** The color theme each choice in the onboarding stands for. */
export const VANTREX_THEME_IDS: Record<VantrexThemeChoice, string> = {
	dark: 'Vantrex Dark',
	light: 'Vantrex Light',
	glass: 'Vantrex Liquid Glass',
};

export type OnboardingNotifications = 'allowed' | 'denied' | 'unknown';

export interface IVantrexOnboardingResult {
	/** The window was closed, or Escape was pressed, before the flow finished. */
	readonly cancelled?: boolean;
	readonly theme?: VantrexThemeChoice;
	readonly notifications?: OnboardingNotifications;
	readonly email?: string | null;
}

/** The transparency of the glass the flow and the Liquid Glass theme start with: clear glass at 49%. */
export const DEFAULT_GLASS_TRANSPARENCY = 49;

export interface IGlassTint {
	readonly r: number;
	readonly g: number;
	readonly b: number;
	/** 0 is no tint. */
	readonly a: number;
	readonly appearance: 'dark' | 'light';
}

/**
 * The colour laid over the glass for a theme. The glass is always the clear style; the tint is what makes it less see-through.
 * `transparency` is a percentage: 0 is solid, 100 is untinted glass.
 */
export function getGlassTint(theme: VantrexThemeChoice, transparency: number): IGlassTint {
	const strength = 1 - Math.max(0, Math.min(100, transparency)) / 100;
	switch (theme) {
		case 'light':
			return { r: 1, g: 1, b: 1, a: strength * 0.9, appearance: 'light' };
		case 'glass':
			return { r: 0, g: 0, b: 0, a: strength * 0.35, appearance: 'dark' };
		default:
			return { r: 0, g: 0, b: 0, a: strength * 0.9, appearance: 'dark' };
	}
}
