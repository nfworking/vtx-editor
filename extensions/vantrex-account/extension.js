// Vantrex Account: signs the IDE in to a Vantrex account and shows who is signed in.
//
// Sign-in uses the platform's device flow, the same one `vtx login` uses: the IDE asks the dashboard for a code, opens the approval page
// in the browser, waits until it is approved, and trades the short-lived session token for an API key. That key is the session's
// access token: Settings Sync sends it as a bearer token to {API}/sync, and the API checks it like any other key. The key is kept in
// the operating system's secret storage, never in settings or on disk in the clear.
//
// This file is plain JavaScript on purpose: it is a small built-in extension that needs no build step.

'use strict';

const vscode = require('vscode');
const os = require('os');

const PROVIDER_ID = 'vantrex';
const CLIENT_ID = 'vtx-ide'; // registered in apps/web/lib/auth.ts
const SECRET_KEY = 'vantrex.account.sessions';
const SCOPES = ['sync'];

// Better Auth limits an API key's name to 32 characters: keep it short, with as much of the machine's name as fits.
function keyName() {
	const host = os.hostname().replace(/\.local$/, '');
	return `IDE ${host}`.slice(0, 32);
}

const cfg = () => vscode.workspace.getConfiguration('vantrex.account');
const authUrl = () => String(cfg().get('authUrl') || 'https://app.vantrex.cloud').replace(/\/+$/, '');

async function postJson(url, body, bearer) {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(20000),
	});
	let data = null;
	try { data = await res.json(); } catch { /* an empty or non-JSON answer */ }
	return { status: res.status, data };
}

/** Runs the device flow. Resolves to the session token; `report` shows the code to the person. */
async function deviceLogin(token, report) {
	const base = authUrl();
	const start = await postJson(`${base}/api/auth/device/code`, { client_id: CLIENT_ID });
	if (start.status !== 200 || !start.data || !start.data.device_code) {
		throw new Error(`Could not start sign-in (the dashboard at ${base} answered ${start.status}). Is the platform running?`);
	}
	const dc = start.data;
	const verify = dc.verification_uri_complete || dc.verification_uri;
	report(dc.user_code, verify);
	await vscode.env.openExternal(vscode.Uri.parse(verify));

	let interval = Math.max(dc.interval || 5, 1) * 1000;
	const deadline = Date.now() + Math.max(dc.expires_in || 600, 60) * 1000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, interval));
		if (token.isCancellationRequested) { throw new Error('Sign-in was cancelled.'); }
		const t = await postJson(`${base}/api/auth/device/token`, {
			grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: dc.device_code, client_id: CLIENT_ID,
		});
		const d = t.data || {};
		if (d.access_token) { return d.access_token; }
		switch (d.error) {
			case 'authorization_pending': break;
			case 'slow_down': interval += 5000; break;
			case 'access_denied': throw new Error('Sign-in was denied in the browser.');
			case 'expired_token': throw new Error('The sign-in code expired. Try again.');
			default: throw new Error(`Sign-in failed (${d.error || t.status}).`);
		}
	}
	throw new Error('Sign-in timed out.');
}

class VantrexAuthProvider {
	constructor(context) {
		this.context = context;
		this._onDidChange = new vscode.EventEmitter();
		this.onDidChangeSessions = this._onDidChange.event;
	}

	async read() {
		try {
			const raw = await this.context.secrets.get(SECRET_KEY);
			const list = raw ? JSON.parse(raw) : [];
			return Array.isArray(list) ? list : [];
		} catch {
			return [];
		}
	}

	async write(list) {
		if (list.length) { await this.context.secrets.store(SECRET_KEY, JSON.stringify(list)); }
		else { await this.context.secrets.delete(SECRET_KEY); }
	}

	async getSessions(scopes) {
		const all = await this.read();
		return scopes && scopes.length ? all.filter((s) => scopes.every((x) => s.scopes.includes(x))) : all;
	}

	async createSession(scopes) {
		const session = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Sign in to Vantrex', cancellable: true },
			async (progress, token) => {
				const sessionToken = await deviceLogin(token, (code) => progress.report({ message: `Approve the sign-in in your browser. Code: ${code}` }));
				const base = authUrl();
				progress.report({ message: 'Finishing...' });

				const key = await postJson(`${base}/api/auth/api-key/create`, { name: keyName() }, sessionToken);
				if (key.status !== 200 || !key.data || !key.data.key) { throw new Error(`Could not create the IDE's access key (${key.status}).`); }

				// Who signed in: the label of the account, read once with the session token.
				let user = {};
				try {
					const res = await fetch(`${base}/api/auth/get-session`, { headers: { authorization: `Bearer ${sessionToken}` }, signal: AbortSignal.timeout(15000) });
					user = ((await res.json()) || {}).user || {};
				} catch { /* the label falls back below */ }

				return {
					id: `vantrex-${user.id || Date.now()}`,
					accessToken: key.data.key,
					account: { id: user.id || 'unknown', label: user.email || user.name || 'Vantrex account' },
					scopes: scopes && scopes.length ? scopes : SCOPES,
					profile: { name: user.name || '', email: user.email || '', image: user.image || '' },
				};
			},
		);
		// One account at a time: signing in again replaces the previous session.
		const old = await this.read();
		await this.write([session]);
		this._onDidChange.fire({ added: [session], removed: old, changed: [] });
		return session;
	}

	async removeSession(sessionId) {
		const all = await this.read();
		const gone = all.filter((s) => s.id === sessionId);
		await this.write(all.filter((s) => s.id !== sessionId));
		if (gone.length) { this._onDidChange.fire({ added: [], removed: gone, changed: [] }); }
	}
}

function activate(context) {
	const provider = new VantrexAuthProvider(context);
	context.subscriptions.push(vscode.authentication.registerAuthenticationProvider(PROVIDER_ID, 'Vantrex', provider, { supportsMultipleAccounts: false }));

	// ---- status bar: who is signed in
	const item = vscode.window.createStatusBarItem('vantrex.account', vscode.StatusBarAlignment.Left, 100);
	item.name = 'Vantrex Account';
	item.command = 'vantrex.account.menu';
	context.subscriptions.push(item);

	async function current() { return (await provider.read())[0]; }

	async function refresh() {
		const s = await current();
		if (s) {
			item.text = `$(account) ${s.account.label}`;
			item.tooltip = 'Vantrex account';
		} else {
			item.text = '$(account) Sign in';
			item.tooltip = 'Sign in to your Vantrex account';
		}
		item.show();
	}
	context.subscriptions.push(provider.onDidChangeSessions(refresh));
	void refresh();

	async function signIn() {
		try {
			return await vscode.authentication.getSession(PROVIDER_ID, SCOPES, { createIfNone: true });
		} catch (e) {
			vscode.window.showErrorMessage(e && e.message ? e.message : String(e));
			return undefined;
		}
	}

	async function signOut() {
		const s = await current();
		if (s) { await provider.removeSession(s.id); vscode.window.showInformationMessage('Signed out of Vantrex.'); }
	}

	async function manage() {
		await vscode.env.openExternal(vscode.Uri.parse(`${authUrl()}/account`));
	}

	async function menu() {
		const s = await current();
		if (!s) { await signIn(); return; }
		const p = s.profile || {};
		const items = [
			{ label: p.name || s.account.label, description: p.name ? s.account.label : '', kind: vscode.QuickPickItemKind.Separator },
			{ label: '$(link-external) Manage Account', id: 'manage', detail: 'Open your account in the dashboard' },
			{ label: '$(sync) Turn On Settings Sync', id: 'syncOn', detail: 'Keep settings, keybindings, snippets, extensions and profiles in step across your machines' },
			{ label: '$(sync-ignored) Turn Off Settings Sync', id: 'syncOff' },
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: '$(sign-out) Sign Out', id: 'out' },
		];
		const pick = await vscode.window.showQuickPick(items, { title: 'Vantrex Account', placeHolder: s.account.label });
		if (!pick) { return; }
		if (pick.id === 'manage') { await manage(); }
		else if (pick.id === 'syncOn') { await vscode.commands.executeCommand('workbench.userDataSync.actions.turnOn'); }
		else if (pick.id === 'syncOff') { await vscode.commands.executeCommand('workbench.userDataSync.actions.turnOff'); }
		else if (pick.id === 'out') { await signOut(); }
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('vantrex.account.signIn', signIn),
		vscode.commands.registerCommand('vantrex.account.signOut', signOut),
		vscode.commands.registerCommand('vantrex.account.menu', menu),
		vscode.commands.registerCommand('vantrex.account.manage', manage),
	);
}

function deactivate() { }

module.exports = { activate, deactivate };
