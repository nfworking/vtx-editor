/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/vantrexOnboarding.css';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { GlassMode, IVantrexOnboardingResult, OnboardingNotifications, VantrexThemeChoice } from '../../../../platform/vantrexOnboarding/common/vantrexOnboarding.js';

export interface IOnboardingCallbacks {
	/** The theme tile that was picked: the glass behind the flow follows it. */
	setTheme(theme: VantrexThemeChoice): void;
	requestNotifications(): Promise<'allowed' | 'denied'>;
	signIn(): Promise<string | undefined>;
	/** The flow is over: "Open Vantrex", or skipped with Escape (`cancelled`). */
	finish(result: IVantrexOnboardingResult): void;
}

const STEPS = 6; // welcome, theme, notifications, sign in, features, done
const THEME_NAMES: Record<VantrexThemeChoice, string> = { dark: 'Dark', light: 'Light', glass: 'Liquid Glass' };
const FEATURES: readonly [string, string, string][] = [
	['package', 'Workspaces', 'Open any project and branch from the platform and edit it in place.'],
	['globe', 'Live preview', 'Your running app sits beside the editor.'],
	['git-branch', 'Commit from the editor', 'Send your changes to GitHub in one step.'],
	['database', 'Database editor', 'Browse tables, edit rows and run SQL.'],
	['sync', 'Settings sync', 'Settings, keybindings and snippets follow you.'],
	['cloud-download', 'Updates that just happen', 'New versions install themselves, with release notes.'],
];

type Child = Node | string;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, children: Child[] = []): HTMLElementTagNameMap[K] {
	const element = mainWindow.document.createElement(tag);
	if (className) {
		element.className = className;
	}
	for (const child of children) {
		element.append(child);
	}
	return element;
}

/**
 * The onboarding flow: six screens drawn over the editor window. It uses no innerHTML (the editor only allows trusted types).
 */
export class VantrexOnboardingOverlay extends Disposable {

	readonly element: HTMLElement;

	private readonly frame: HTMLElement;
	private stepElement: HTMLElement;
	private readonly dots: HTMLElement;
	private readonly backButton: HTMLButtonElement;

	private step: number;
	private theme: VantrexThemeChoice | undefined;
	private notifications: OnboardingNotifications = 'unknown';
	private signIn: { pending?: boolean; email?: string; failed?: boolean } | undefined;

	constructor(
		private readonly callbacks: IOnboardingCallbacks,
		mode: GlassMode,
		start: { step?: number; theme?: VantrexThemeChoice } = {},
	) {
		super();
		this.step = Math.max(0, Math.min(STEPS - 1, start.step ?? 0));
		this.theme = start.theme;

		this.stepElement = el('div', 'vtx-ob-step');
		this.dots = el('div', 'dots');
		this.backButton = el('button', 'icon-button', ['‹']);
		this.backButton.setAttribute('aria-label', 'Back');
		this.backButton.addEventListener('click', () => this.go(this.step - 1));
		this.frame = el('div', 'vtx-ob-frame', [this.stepElement, el('footer', undefined, [this.backButton, this.dots, el('span', 'spacer')])]);

		this.element = el('div', 'vtx-ob', [this.frame]);
		this.element.dataset.glass = mode === 'native' ? 'native' : mode === 'vibrancy' ? 'vibrancy' : mode === 'acrylic' ? 'acrylic' : 'css';
		this.element.dataset.theme = this.theme ?? 'dark';
		mainWindow.document.body.appendChild(this.element);

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				this.callbacks.finish({ cancelled: true });
			}
		};
		mainWindow.addEventListener('keydown', onKeyDown);
		this._register({ dispose: () => mainWindow.removeEventListener('keydown', onKeyDown) });

		this.render();
	}

	/** Fades the flow out; the editor behind it is revealed meanwhile. */
	fadeOut(): Promise<void> {
		this.element.classList.add('leaving');
		return new Promise(resolve => setTimeout(resolve, 420));
	}

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}

	private go(step: number): void {
		this.step = Math.max(0, Math.min(STEPS - 1, step));
		this.render();
	}

	private button(label: string, onClick: () => void, options: { primary?: boolean; disabled?: boolean } = {}): HTMLButtonElement {
		const button = el('button', `button${options.primary ? ' primary' : ''}`, [label]);
		button.disabled = !!options.disabled;
		button.addEventListener('click', onClick);
		return button;
	}

	private heading(title: string, subtitle: string): HTMLElement {
		return el('div', 'heading', [el('h1', undefined, [title]), el('p', 'lede', [subtitle])]);
	}

	private icon(name: string, big = false): HTMLElement {
		return el('span', `codicon codicon-${name}${big ? ' big-icon' : ''}`);
	}

	private mark(): SVGElement {
		const ns = 'http://www.w3.org/2000/svg';
		const svg = mainWindow.document.createElementNS(ns, 'svg');
		svg.setAttribute('class', 'mark');
		svg.setAttribute('viewBox', '0 0 32 32');
		const path = mainWindow.document.createElementNS(ns, 'path');
		path.setAttribute('d', 'M5 8l11 16L27 8');
		path.setAttribute('fill', 'none');
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', '3.2');
		const dot = mainWindow.document.createElementNS(ns, 'circle');
		dot.setAttribute('cx', '16');
		dot.setAttribute('cy', '24');
		dot.setAttribute('r', '3');
		dot.setAttribute('fill', '#ff5a3f');
		svg.append(path, dot);
		return svg;
	}

	private ok(text: string): HTMLElement {
		return el('div', 'ok', [this.icon('pass-filled'), text]);
	}

	private render(): void {
		this.element.dataset.theme = this.theme ?? 'dark';
		this.backButton.classList.toggle('hidden', this.step === 0 || this.step === STEPS - 1);
		this.dots.replaceChildren(...Array.from({ length: STEPS }, (_, i) => el('i', i === this.step ? 'on' : '')));

		// A fresh element restarts the entrance animation.
		const next = el('div', 'vtx-ob-step', this.buildStep());
		this.stepElement.replaceWith(next);
		this.stepElement = next;
	}

	private buildStep(): Child[] {
		switch (this.step) {
			case 0:
				return [this.mark(), this.heading('Welcome to Vantrex', 'Build, commit and ship, from one fast editor that knows your platform.'), this.button('Get started', () => this.go(1), { primary: true })];

			case 1: {
				const tiles = (['dark', 'light', 'glass'] as const).map(choice => {
					const tile = el('button', 'theme', [el('div', `swatch ${choice}`, [el('i'), el('i'), el('i')]), el('span', undefined, [THEME_NAMES[choice]])]);
					tile.setAttribute('aria-pressed', String(this.theme === choice));
					tile.addEventListener('click', () => {
						this.theme = choice;
						this.callbacks.setTheme(choice);
						this.render();
					});
					return tile;
				});
				return [this.heading('Pick a look', 'The window glass follows your choice. You can change it any time from the command bar.'), el('div', 'themes', tiles), this.button('Continue', () => this.go(2), { primary: true, disabled: !this.theme })];
			}

			case 2: {
				const head = [this.icon('bell', true), this.heading('Build notifications', 'Get a quick note when a deployment finishes or fails, even when Vantrex is in the background.')];
				if (this.notifications === 'allowed') {
					return [...head, this.ok('Notifications are on'), this.button('Continue', () => this.go(3), { primary: true })];
				}
				if (this.notifications === 'denied') {
					return [...head, el('p', 'muted', ['Notifications are off. You can turn them on in your system settings whenever you like.']), this.button('Continue', () => this.go(3), { primary: true })];
				}
				return [...head, el('div', 'row', [
					this.button('Not now', () => this.go(3)),
					this.button('Allow notifications', async () => {
						this.notifications = await this.callbacks.requestNotifications();
						this.render();
					}, { primary: true }),
				])];
			}

			case 3: {
				const head = [this.icon('account', true), this.heading('Sign in to Vantrex', 'Open your projects and databases, and keep your settings in step across your machines.')];
				const state = this.signIn;
				if (state?.pending) {
					return [...head, el('div', 'pending', [el('strong', undefined, ['Check your browser']), el('span', 'muted', [el('span', 'spinner'), 'Approve the sign-in to continue…'])])];
				}
				if (state?.email) {
					return [...head, this.ok(`Signed in as ${state.email}`), this.button('Continue', () => this.go(4), { primary: true })];
				}
				if (state?.failed) {
					return [...head, el('p', 'muted', ['Sign-in did not finish. You can try again later from the account menu.']), this.button('Continue', () => this.go(4), { primary: true })];
				}
				return [...head, el('div', 'row', [
					this.button('Skip for now', () => this.go(4)),
					this.button('Sign in with Vantrex', async () => {
						this.signIn = { pending: true };
						this.render();
						const email = await this.callbacks.signIn();
						this.signIn = email ? { email } : { failed: true };
						this.render();
					}, { primary: true }),
				])];
			}

			case 4:
				return [
					this.heading('What you can do', 'No AI, no telemetry. Just the tools to build and ship.'),
					el('div', 'features', FEATURES.map(([icon, title, text]) => el('div', 'feature', [this.icon(icon), el('div', undefined, [el('b', undefined, [title]), el('span', undefined, [text])])]))),
					this.button('Continue', () => this.go(5), { primary: true }),
				];

			default: {
				const summary = `Theme: ${THEME_NAMES[this.theme ?? 'dark']} · Notifications: ${this.notifications === 'allowed' ? 'on' : 'off'} · ${this.signIn?.email ? `Signed in as ${this.signIn.email}` : 'Not signed in'}`;
				return [this.icon('verified-filled', true), this.heading("You're all set", summary), this.button('Open Vantrex', () => this.callbacks.finish({ theme: this.theme, notifications: this.notifications, email: this.signIn?.email ?? null }), { primary: true })];
			}
		}
	}
}
