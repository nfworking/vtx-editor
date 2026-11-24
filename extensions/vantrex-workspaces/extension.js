// Vantrex Workspaces: develop inside a Vantrex workspace from the IDE.
//
// A workspace is a hardened container on a Vantrex runner holding a checkout of one branch of a project, with its dev server. This
// extension is the IDE side of what the dashboard's /editor does: it opens the checkout as a folder (`vtxws://<id>/`, see lib/fs.js),
// runs the package manager tasks in a terminal (lib/terminal.js), shows the running app in a preview panel (lib/preview.js) and
// commits changes to GitHub (lib/commit.js). Everything goes through the Vantrex API with the key from Vantrex Account.
//
// This file is plain JavaScript on purpose: it is a small built-in extension that needs no build step.

'use strict';

const vscode = require('vscode');
const { call, ApiError, ws, dashboardBase } = require('./lib/api');
const { WorkspaceFileSystem } = require('./lib/fs');
const { WorkspaceTerminal } = require('./lib/terminal');
const { PreviewProxy, PreviewPanel } = require('./lib/preview');
const { Baseline, commit } = require('./lib/commit');
const { createWorkspaceScm } = require('./lib/scm');
const tasks = require('./lib/tasks');
const { activateDb, SCHEME: DB_SCHEME } = require('./lib/db');
const dbApi = require('./lib/db/api');

const SCHEME = 'vtxws';
const errText = (e) => (e instanceof ApiError ? e.message : (e && e.message) || String(e));

/** What this window is attached to, if it has a workspace folder open. */
let S;

function activate(context) {
	const fs = new WorkspaceFileSystem();
	let wasSignedIn; // whether this window has had an account since it started
	const output = vscode.window.createOutputChannel('Vantrex Workspace');
	const status = vscode.window.createStatusBarItem('vantrex.workspace', vscode.StatusBarAlignment.Left, 90);
	status.name = 'Vantrex Workspace';
	status.command = 'vantrex.workspace.menu';
	const changes = vscode.window.createStatusBarItem('vantrex.workspace.changes', vscode.StatusBarAlignment.Left, 89);
	changes.name = 'Vantrex Workspace Changes';
	changes.command = 'vantrex.workspace.commit';
	context.subscriptions.push(
		vscode.workspace.registerFileSystemProvider(SCHEME, fs, { isCaseSensitive: true }),
		output, status, changes,
		fs.onDidTouch((p) => { if (S && S.baseline) { S.baseline.touch(p); renderChanges(); if (S.scm) { S.scm.schedule(); } } }),
	);

	function render(text, tip) {
		status.text = text;
		status.tooltip = tip || 'Vantrex workspace';
		status.show();
	}

	function renderChanges() {
		const n = S && S.baseline ? S.baseline.touched.size : 0;
		if (!n) { changes.hide(); return; }
		changes.text = `$(git-commit) ${n} changed`;
		changes.tooltip = 'Commit your changes to GitHub';
		changes.show();
	}

	// ---- picking and starting a workspace

	/** Database projects, or why there are none to list: the platform may not offer databases, or the account may not have any. */
	async function listDatabases() {
		try { return { projects: await dbApi.projects() }; } catch (e) { return { projects: [], error: errText(e) }; }
	}

	/** Code projects (a GitHub repository, opened as a workspace) and database projects, in one list. */
	async function pickProject(only) {
		const [code, dbs] = await Promise.all([
			only === 'db' ? Promise.resolve([]) : call('GET', 'projects').then((r) => r.data || []),
			only === 'code' ? Promise.resolve({ projects: [] }) : listDatabases(),
		]);
		const repos = code.filter((p) => p.repo_full_name);
		const items = [];
		if (only !== 'db') {
			items.push({ label: 'Code', kind: vscode.QuickPickItemKind.Separator });
			for (const p of repos) { items.push({ label: `$(code) ${p.name}`, description: p.repo_full_name, detail: p.slug, kind: 'code', project: p }); }
			if (!repos.length) { items.push({ label: '$(info) No project is linked to a GitHub repository yet', description: 'Link one in the dashboard', kind: 'dashboard', path: '/projects' }); }
		}
		if (only !== 'code') {
			items.push({ label: 'Databases', kind: vscode.QuickPickItemKind.Separator });
			for (const p of dbs.projects) { items.push({ label: `$(database) ${p.name}`, description: p.state, detail: p.endpoint, kind: 'db', project: p }); }
			if (dbs.error) { items.push({ label: '$(warning) Databases could not be listed', description: dbs.error, kind: 'message', text: `Databases could not be listed: ${dbs.error}` }); }
			else if (!dbs.projects.length) { items.push({ label: '$(add) No database projects yet', description: 'Create one in the dashboard', kind: 'dashboard', path: '/databases' }); }
		}
		const pick = await vscode.window.showQuickPick(items, { title: only === 'db' ? 'Open a Database Project' : 'Open a Vantrex Workspace', placeHolder: 'Choose a project' });
		if (!pick) { return undefined; }
		if (pick.kind === 'dashboard') { await vscode.env.openExternal(vscode.Uri.parse(`${dashboardBase()}${pick.path}`)); return undefined; }
		if (pick.kind === 'message') { vscode.window.showWarningMessage(pick.text); return undefined; }
		return Object.assign({ kind: pick.kind }, pick.project);
	}

	async function pickBranch(project) {
		const r = await call('GET', `editor/projects/${encodeURIComponent(project.id)}`);
		const info = r.data;
		const branches = [info.prod_branch, ...(info.branches || []).filter((b) => b !== info.prod_branch)];
		const pick = await vscode.window.showQuickPick(branches.map((b) => ({ label: b, description: b === info.prod_branch ? 'production' : '' })), { title: `${project.name}: branch`, placeHolder: 'Which branch do you want to work on?' });
		return pick && pick.label;
	}

	/** Finds the branch's workspace or makes one, and makes sure it is running. Workspaces are capped per runner, so a full runner offers to stop one. */
	async function ensureWorkspace(project, branch) {
		for (let attempt = 0; attempt < 2; attempt++) {
			const all = (await call('GET', 'workspaces')).data || [];
			let w = all.find((x) => x.project_id === project.id && x.branch === branch);
			try {
				if (w && w.state === 'stopped') { w = (await call('POST', `${ws(w.id)}/resume`)).data; }
				if (!w) { w = (await call('POST', `editor/projects/${encodeURIComponent(project.id)}/workspaces`, { body: { branch } })).data; }
				return w;
			} catch (e) {
				if (!(e instanceof ApiError) || (e.status !== 429 && e.code !== 'workspace_cap') || attempt) { throw e; }
				const active = all.filter((x) => x.state !== 'stopped');
				const pick = await vscode.window.showQuickPick(active.map((x) => ({ label: x.branch, description: x.project_id, id: x.id })), { title: 'Too many workspaces are running', placeHolder: 'Stop one to make room' });
				if (!pick) { return undefined; }
				await call('POST', `${ws(pick.id)}/stop`);
			}
		}
		return undefined;
	}

	async function openWorkspace(only) {
		try {
			await vscode.authentication.getSession('vantrex', ['sync'], { createIfNone: true });
			fs.restore();
			const project = await pickProject(typeof only === 'string' ? only : undefined);
			if (!project) { return; }
			if (project.kind === 'db') {
				// A database project has no files: the window becomes the database editor (lib/db).
				const here = (vscode.workspace.workspaceFolders || []).length === 0;
				await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({ scheme: DB_SCHEME, authority: project.id, path: '/' }), { forceNewWindow: !here });
				return;
			}
			const branch = await pickBranch(project);
			if (!branch) { return; }
			const w = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Opening ${project.name} (${branch})` }, async (progress) => {
				progress.report({ message: 'Starting the workspace...' });
				return ensureWorkspace(project, branch);
			});
			if (!w) { return; }
			const folder = vscode.Uri.from({ scheme: SCHEME, authority: w.id, path: '/' });
			if (S && S.id === w.id) { return; }
			const here = (vscode.workspace.workspaceFolders || []).length === 0;
			await vscode.commands.executeCommand('vscode.openFolder', folder, { forceNewWindow: !here });
		} catch (e) {
			vscode.window.showErrorMessage(`Could not open the workspace: ${errText(e)}`);
		}
	}

	// ---- attaching this window to the workspace it has open

	const folderId = () => {
		const f = (vscode.workspace.workspaceFolders || []).find((x) => x.uri.scheme === SCHEME);
		return f && f.uri.authority;
	};

	async function attach() {
		const id = folderId();
		if (!id || (S && S.id === id)) { return; }
		render('$(sync~spin) Workspace', 'Connecting to the workspace');
		let detail;
		try {
			detail = (await call('GET', ws(id))).data;
		} catch (e) {
			render('$(warning) Workspace', errText(e));
			if (e instanceof ApiError && e.status === 404) {
				vscode.window.showWarningMessage('This workspace no longer exists. Open it again from the Vantrex menu.');
			} else if (e instanceof ApiError && e.status === 401) {
				// Without an account the workspace must not stay open: sign in, or it is closed.
				void vscode.window.showWarningMessage('Sign in to Vantrex to use this workspace.', 'Sign In', 'Close Workspace').then(async (p) => {
					if (p === 'Sign In') { await vscode.commands.executeCommand('vantrex.account.signIn'); fs.restore(); void attach(); } else { void lockOut(false); }
				});
			}
			return;
		}
		const w = detail.workspace;
		wasSignedIn = true;
		S = { id, workspace: w, projectId: w.project_id, branch: w.branch, scripts: detail.scripts || [], name: w.branch, phase: 'starting', abort: new AbortController() };
		try {
			const info = (await call('GET', `editor/projects/${encodeURIComponent(w.project_id)}`)).data;
			S.info = info;
			S.name = info.project.name;
		} catch { /* the status bar still works without the project's name */ }
		void vscode.commands.executeCommand('setContext', 'vantrex.workspace', true);
		updateStatus();

		S.baseline = new Baseline(w.project_id, w.branch);
		S.scm = createWorkspaceScm(S, fs, (message) => commitChanges(message));
		S.baseline.load().then(() => { renderChanges(); S.scm.refresh(); }, () => { /* a commit then says why */ });
		S.beat = setInterval(() => { call('POST', `${ws(id)}/touch`).catch(() => { }); }, 30000);

		void start(detail);
	}

	function updateStatus() {
		if (!S) { return; }
		const icon = { starting: '$(sync~spin)', installing: '$(sync~spin)', 'starting-dev': '$(sync~spin)', dev: '$(vm-running)', 'no-dev': '$(vm)', error: '$(warning)' }[S.phase] || '$(vm)';
		const label = { starting: 'starting', installing: 'installing', 'starting-dev': 'starting dev server', dev: 'running', 'no-dev': 'no dev script', error: 'problem' }[S.phase] || S.phase;
		render(`${icon} ${S.name} · ${S.branch} · ${label}`, `Vantrex workspace ${S.id}`);
	}

	function setPhase(phase) { if (S) { S.phase = phase; updateStatus(); } }

	/** Runs a task and writes its output to the Output panel; resolves to whether it succeeded. */
	async function runLogged(label, req) {
		output.show(true);
		output.appendLine(`\n> ${label}`);
		const t = await tasks.start(S.id, req);
		const end = await tasks.follow(S.id, t.id, (text) => output.append(tasks.cleanOutput(text)), S.abort.signal);
		output.appendLine(end.ok ? `\n${label}: done` : `\n${label}: ${end.error || 'failed'}`);
		return { ok: end.ok, task: t.id };
	}

	/** The same steps as the dashboard editor: resume, load the development variables, install if needed, start the dev server, open the preview. */
	async function start(first) {
		const id = S.id;
		try {
			let detail = first;
			if (detail.workspace.state === 'stopped') {
				await call('POST', `${ws(id)}/resume`);
				detail = (await call('GET', ws(id))).data;
			}
			setPhase('starting');
			try {
				const e = (await call('POST', `${ws(id)}/env/sync`)).data;
				if (e) { output.appendLine(`Development environment variables loaded: ${e.count}${e.skipped ? ` (${e.skipped} skipped)` : ''}`); }
			} catch (e) { output.appendLine(`Environment variables were not loaded: ${errText(e)}`); }

			if (detail.has_package && !detail.installed) {
				setPhase('installing');
				const r = await runLogged('install', { kind: 'install' });
				fs.invalidate();
				if (!r.ok) { setPhase('error'); vscode.window.showErrorMessage('Installing dependencies failed. See the Vantrex Workspace output.'); return; }
			}
			const scripts = detail.scripts || [];
			S.scripts = scripts;
			if (!scripts.includes('dev')) { setPhase('no-dev'); return; }
			await ensureDev();
			if (vscode.workspace.getConfiguration('vantrex.workspace').get('autoPreview')) { await openPreview(true); }
		} catch (e) {
			setPhase('error');
			vscode.window.showErrorMessage(`The workspace could not start: ${errText(e)}`);
		}
	}

	async function ensureDev() {
		const running = (await tasks.list(S.id)).find((t) => t.running && t.request && t.request.kind === 'dev');
		if (running) { S.dev = running.id; setPhase('dev'); void followDev(running.id); return; }
		setPhase('starting-dev');
		const t = await tasks.start(S.id, { kind: 'dev' });
		S.dev = t.id;
		setPhase('dev');
		void followDev(t.id);
	}

	async function followDev(task) {
		const id = S && S.id;
		if (!id) { return; }
		try {
			const end = await tasks.follow(id, task, (text) => output.append(tasks.cleanOutput(text)), S.abort.signal);
			if (S && S.dev === task) { S.dev = undefined; if (S.phase === 'dev') { setPhase('no-dev'); } }
			if (!end.ok && end.error !== 'stopped') { output.appendLine(`\nThe dev server stopped: ${end.error || 'it exited'}`); }
		} catch { /* the window is closing or the connection is gone; the next action says so */ }
	}

	// ---- preview

	async function openPreview(quiet) {
		if (!S) { if (!quiet) { vscode.window.showInformationMessage('Open a Vantrex workspace first.'); } return; }
		if (S.panel && !S.panel.disposed) { S.panel.reveal(); return; }
		if (!S.proxy) {
			S.proxy = new PreviewProxy(S.id);
			await S.proxy.listen();
		}
		S.panel = new PreviewPanel(S.proxy, `Preview · ${S.name}`);
	}

	// ---- terminal

	function openTerminal() {
		if (!S) { vscode.window.showInformationMessage('Open a Vantrex workspace first.'); return; }
		const pty = new WorkspaceTerminal(S.id, `${S.name} · ${S.branch}`, (line, ok) => { fs.invalidate(); if (ok && /\b(install|add|remove)\b/.test(line)) { void vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer'); } });
		const term = vscode.window.createTerminal({ name: 'Vantrex', pty, iconPath: new vscode.ThemeIcon('vm') });
		term.show();
	}

	// ---- commands

	/** Commits the changes to GitHub (asking where they go), from the command or from the Source Control view. */
	async function commitChanges(message) {
		if (!S.baseline.head) { await S.baseline.load(); }
		const out = await commit(S.baseline, S.id, S.info && S.info.prod_branch, () => renderChanges(), { message });
		renderChanges();
		if (S.scm) { await S.scm.refresh(); }
		return out;
	}

	async function needWorkspace() {
		if (S) { return true; }
		const pick = await vscode.window.showInformationMessage('This window has no Vantrex workspace open.', 'Open Workspace...');
		if (pick) { void openWorkspace(); }
		return false;
	}

	async function runTaskCommand() {
		if (!(await needWorkspace())) { return; }
		const scripts = S.scripts || [];
		const items = [
			{ label: 'install', description: 'Install dependencies', req: { kind: 'install' } },
			{ label: 'add', description: 'Add a package', ask: 'add' },
			{ label: 'remove', description: 'Remove a package', ask: 'remove' },
			...['dev', 'build', 'test', 'lint', 'typecheck'].filter((k) => scripts.includes(k)).map((k) => ({ label: k, description: `Run the ${k} script`, req: { kind: k } })),
			...scripts.filter((s) => !['dev', 'build', 'test', 'lint', 'typecheck'].includes(s)).map((s) => ({ label: s, description: 'Run this script', req: { kind: 'script', name: s } })),
		];
		const pick = await vscode.window.showQuickPick(items, { title: 'Run a Workspace Task' });
		if (!pick) { return; }
		let req = pick.req;
		if (pick.ask) {
			const name = await vscode.window.showInputBox({ title: pick.ask === 'add' ? 'Add a package' : 'Remove a package', prompt: 'Package name, with an optional @version', validateInput: (v) => (v.trim() ? undefined : 'Enter a package name') });
			if (!name) { return; }
			const [base, version] = name.trim().replace(/^(@[^@/]+\/[^@]+|[^@]+)@?(.*)$/, '$1 $2').split(' ');
			req = { kind: pick.ask, name: base, ...(version ? { version } : {}) };
		}
		try {
			if (req.kind === 'dev') { await ensureDev(); await openPreview(true); return; }
			const r = await runLogged(pick.label, req);
			fs.invalidate();
			if (r.ok && ['install', 'add', 'remove'].includes(req.kind)) { await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer'); }
		} catch (e) { vscode.window.showErrorMessage(errText(e)); }
	}

	async function menu() {
		if (!S) { await openWorkspace(); return; }
		const items = [
			{ label: '$(browser) Open Preview', id: 'vantrex.workspace.preview' },
			{ label: '$(terminal) Open Terminal', id: 'vantrex.workspace.terminal' },
			{ label: '$(play) Run Task...', id: 'vantrex.workspace.runTask' },
			{ label: S.dev ? '$(debug-stop) Stop Dev Server' : '$(debug-start) Start Dev Server', id: S.dev ? 'vantrex.workspace.stopDev' : 'vantrex.workspace.startDev' },
			{ label: '$(git-commit) Commit Changes...', id: 'vantrex.workspace.commit' },
			{ label: '$(key) Sync Environment Variables', id: 'vantrex.workspace.syncEnv' },
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: '$(link-external) Open Project in the Dashboard', id: 'vantrex.workspace.dashboard' },
			{ label: '$(folder-opened) Open Another Workspace...', id: 'vantrex.workspace.open' },
			{ label: '$(database) Open Database Project...', id: 'vantrex.db.open' },
			{ label: '$(debug-pause) Stop Workspace', id: 'vantrex.workspace.stop' },
			{ label: '$(trash) Delete Workspace...', id: 'vantrex.workspace.delete' },
		];
		const pick = await vscode.window.showQuickPick(items, { title: `${S.name} · ${S.branch}` });
		if (pick) { await vscode.commands.executeCommand(pick.id); }
	}

	const guarded = (fn) => async () => { if (!(await needWorkspace())) { return; } try { await fn(); } catch (e) { vscode.window.showErrorMessage(errText(e)); } };

	context.subscriptions.push(
		vscode.commands.registerCommand('vantrex.workspace.open', openWorkspace),
		vscode.commands.registerCommand('vantrex.workspace.menu', menu),
		vscode.commands.registerCommand('vantrex.workspace.preview', guarded(() => openPreview(false))),
		vscode.commands.registerCommand('vantrex.workspace.terminal', openTerminal),
		vscode.commands.registerCommand('vantrex.workspace.runTask', runTaskCommand),
		vscode.commands.registerCommand('vantrex.workspace.startDev', guarded(async () => { await ensureDev(); await openPreview(true); })),
		vscode.commands.registerCommand('vantrex.workspace.stopDev', guarded(async () => {
			if (S.dev) { await tasks.stop(S.id, S.dev); S.dev = undefined; setPhase('no-dev'); }
		})),
		vscode.commands.registerCommand('vantrex.workspace.syncEnv', guarded(async () => {
			const r = (await call('POST', `${ws(S.id)}/env/sync`)).data;
			vscode.window.showInformationMessage(`${r.count} development variable${r.count === 1 ? '' : 's'} loaded${r.count ? '. Restart the dev server to use them.' : '. Add some in the project settings.'}`);
		})),
		vscode.commands.registerCommand('vantrex.workspace.commit', guarded(async () => { await commitChanges(); })),
		vscode.commands.registerCommand('vantrex.workspace.scmCommit', guarded(async () => { await S.scm.commitFromBox(); })),
		vscode.commands.registerCommand('vantrex.workspace.scmRefresh', guarded(async () => { await S.baseline.load().catch(() => { }); await S.scm.refresh(); })),
		vscode.commands.registerCommand('vantrex.workspace.scmDiscard', guarded(async (state) => { if (state) { await S.scm.discard(state); } })),
		vscode.commands.registerCommand('vantrex.db.open', () => openWorkspace('db')),
		vscode.commands.registerCommand('vantrex.workspace.stop', guarded(async () => {
			await call('POST', `${ws(S.id)}/stop`);
			setPhase('stopped');
			vscode.window.showInformationMessage('The workspace was stopped. Open it again to resume.');
		})),
		vscode.commands.registerCommand('vantrex.workspace.delete', guarded(async () => {
			const sure = await vscode.window.showWarningMessage('Delete this workspace?', { modal: true, detail: 'Uncommitted changes in it are lost. The repository on GitHub is not touched.' }, 'Delete');
			if (!sure) { return; }
			await call('DELETE', ws(S.id));
			await vscode.commands.executeCommand('workbench.action.closeFolder');
		})),
		vscode.commands.registerCommand('vantrex.workspace.dashboard', guarded(async () => {
			const slug = S.info && S.info.project && S.info.project.slug;
			await vscode.env.openExternal(vscode.Uri.parse(`${dashboardBase()}/projects${slug ? '/' + encodeURIComponent(slug) : ''}`));
		})),
		vscode.workspace.onDidChangeWorkspaceFolders(() => { if (S && folderId() !== S.id) { detach(); } void attach(); }),
	);

	/**
	 * Signing out takes the workspace away: nothing in it may stay readable or writable. The editors are closed, the file system refuses
	 * every request, and the window leaves the folder (which reloads it), so what was open cannot be reached any more.
	 */
	async function lockOut(announce) {
		fs.revoke();
		const open = (vscode.workspace.workspaceFolders || []).some((f) => f.uri.scheme === SCHEME || f.uri.scheme === DB_SCHEME);
		if (S) { detach(); }
		if (!open) { return; }
		if (announce) { void vscode.window.showInformationMessage('You signed out of Vantrex, so the workspace was closed.'); }
		// Leaving the folder reloads the window. Editors are not closed one by one: with unsaved edits that would ask a question nobody
		// is there to answer, whereas leaving the folder keeps them in the editor's backup like any other window change.
		await vscode.commands.executeCommand('workbench.action.closeFolder');
	}

	async function signedIn() {
		try { return !!(await vscode.authentication.getSession('vantrex', ['sync'], { silent: true })); } catch { return false; }
	}

	// Only a real sign-out locks the workspace: a window that starts without an account is asked to sign in instead (see attach).
	void signedIn().then((v) => { if (wasSignedIn === undefined) { wasSignedIn = v; } });
	context.subscriptions.push(vscode.authentication.onDidChangeSessions(async (e) => {
		if (e.provider.id !== 'vantrex') { return; }
		const now = await signedIn();
		const before = wasSignedIn;
		wasSignedIn = now;
		if (now) { fs.restore(); if (!S && folderId()) { void attach(); } return; }
		if (S || before) { await lockOut(true); } // an attached workspace proves there was an account
	}));

	function detach() {
		if (!S) { return; }
		clearInterval(S.beat);
		S.abort.abort();
		if (S.scm) { S.scm.dispose(); }
		if (S.proxy) { S.proxy.dispose(); }
		S = undefined;
		status.hide();
		changes.hide();
		void vscode.commands.executeCommand('setContext', 'vantrex.workspace', false);
	}
	context.subscriptions.push({ dispose: detach });

	activateDb(context);

	// Signed out or not, the status bar entry is only for windows that have a workspace; the menu command opens one from anywhere.
	void attach();

	// A window that comes back with a database project open (that has no workspace to attach to) still needs an account.
	setTimeout(async () => {
		const open = (vscode.workspace.workspaceFolders || []).some((f) => f.uri.scheme === DB_SCHEME);
		if (open && !(await signedIn())) {
			const pick = await vscode.window.showWarningMessage('Sign in to Vantrex to use this database project.', 'Sign In', 'Close');
			if (pick === 'Sign In') { await vscode.commands.executeCommand('vantrex.account.signIn'); } else { void lockOut(false); }
		}
	}, 4000);
}

function deactivate() { }

module.exports = { activate, deactivate };
