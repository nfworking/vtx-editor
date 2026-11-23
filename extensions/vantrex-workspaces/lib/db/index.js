// Database projects in the IDE. Opening one from "Open Vantrex Workspace" turns the window into a database editor, the same tools as the
// dashboard's: the Database view (schemas and tables), a table editor for each table, SQL files you run with Cmd+Enter, a results panel
// and the connection strings. A database project has no files, so the window's folder is `vtxdb://<project id>/`: the SQL scripts, kept on
// this machine (scripts.js).

'use strict';

const vscode = require('vscode');
const db = require('./api');
const { ScriptFileSystem } = require('./scripts');
const { DatabaseTree } = require('./tree');
const { ResultsView } = require('./results');
const { TableEditor } = require('./table');
const { ApiError } = require('../api');

const SCHEME = 'vtxdb';
const errText = (e) => (e instanceof ApiError ? e.message : (e && e.message) || String(e));
const LABEL = { creating: 'creating', starting: 'starting', running: 'running', stopping: 'suspending', suspended: 'suspended', error: 'error' };

function activateDb(context) {
	const scripts = new ScriptFileSystem(context);
	const results = new ResultsView();
	let D; // the database project this window is attached to
	const tree = new DatabaseTree(() => (D && D.ready ? { projectId: D.id, database: D.database } : undefined));
	const tables = new Map(); // `${schema}.${table}` -> TableEditor

	const status = vscode.window.createStatusBarItem('vantrex.db', vscode.StatusBarAlignment.Left, 90);
	status.name = 'Vantrex Database';
	status.command = 'vantrex.db.menu';

	context.subscriptions.push(
		status,
		vscode.workspace.registerFileSystemProvider(SCHEME, scripts, { isCaseSensitive: true }),
		vscode.window.registerWebviewViewProvider('vantrex.db.results', results, { webviewOptions: { retainContextWhenHidden: true } }),
		// table editors are not restored across a restart (they reopen from the tree)
		vscode.window.registerWebviewPanelSerializer('vantrex.table', { deserializeWebviewPanel: async (panel) => { panel.dispose(); } }),
		vscode.window.createTreeView('vantrex.db.tree', { treeDataProvider: tree, showCollapseAll: true }),
	);

	const folderId = () => {
		const f = (vscode.workspace.workspaceFolders || []).find((x) => x.uri.scheme === SCHEME);
		return f && f.uri.authority;
	};

	function render() {
		if (!D) { status.hide(); return; }
		const busy = ['creating', 'starting', 'stopping'].includes(D.state);
		status.text = `${busy ? '$(sync~spin)' : '$(database)'} ${D.name} · ${D.database || '…'} · ${LABEL[D.state] || D.state}`;
		status.tooltip = 'Database project: switch database, connect, history';
		status.show();
	}

	async function poll() {
		if (!D) { return; }
		try {
			const d = await db.detail(D.id);
			const was = D.state;
			D.detail = d;
			D.state = d.project.state;
			D.name = d.project.name;
			if (!D.database || !d.databases.some((x) => x.name === D.database)) { D.database = (d.databases[0] || {}).name || ''; }
			if (D.state === 'running' && !D.ready) { D.ready = true; tree.refresh(); }
			if (D.state !== 'running' && was === 'running') { D.ready = false; }
			render();
		} catch (e) {
			if (D) { D.state = 'error'; render(); }
		}
	}

	async function attach() {
		const id = folderId();
		if (!id || (D && D.id === id)) { return; }
		D = { id, name: 'Database', database: '', state: 'starting', ready: false };
		void vscode.commands.executeCommand('setContext', 'vantrex.db', true);
		render();
		try { await db.wake(id); } catch { /* the state poll says what is wrong */ }
		await poll();
		D.timer = setInterval(() => void poll(), 5000);
		// the window becomes the editor: the Database view, the script, the results panel
		await new Promise((r) => setTimeout(r, 1500)); // the window restores its own layout first
		await vscode.commands.executeCommand('workbench.view.extension.vantrex-db');
		try { await vscode.window.showTextDocument(vscode.Uri.from({ scheme: SCHEME, authority: id, path: '/query.sql' }), { preview: false }); } catch { /* the folder is still opening */ }
		await vscode.commands.executeCommand('vantrex.db.results.focus', { preserveFocus: true });
	}

	function detach() {
		if (!D) { return; }
		clearInterval(D.timer);
		for (const t of tables.values()) { t.panel.dispose(); }
		tables.clear();
		D = undefined;
		status.hide();
		void vscode.commands.executeCommand('setContext', 'vantrex.db', false);
	}

	const need = () => { if (D) { return true; } vscode.window.showInformationMessage('Open a database project first (Open Vantrex Workspace).'); return false; };

	// ---- run SQL
	async function run() {
		if (!need()) { return; }
		const ed = vscode.window.activeTextEditor;
		if (!ed) { return; }
		const sel = ed.selection;
		const sql = (sel.isEmpty ? ed.document.getText() : ed.document.getText(sel)).trim();
		if (!sql) { return; }
		if (!D.ready) { vscode.window.showWarningMessage('The database is starting. Try again in a moment.'); void db.wake(D.id).catch(() => { }); return; }
		results.busy();
		await vscode.commands.executeCommand('vantrex.db.results.focus', { preserveFocus: true });
		const r = await db.query(D.id, D.database, sql);
		await results.show({ results: r.results, error: r.error, ms: r.ms, database: D.database });
		if (/\b(create|drop|alter|truncate|rename)\b/i.test(sql)) { tree.refresh(); await refreshTables(); }
	}

	// An open table editor reads its own data; a change to the schema is picked up when it is opened again.
	async function refreshTables() { /* the tree re-reads on refresh; editors reload on demand */ }

	function openTable(arg) {
		if (!need() || !arg) { return; }
		const key = `${D.database}:${arg.schema}.${arg.table}`;
		const open = tables.get(key);
		if (open) { open.reveal(); return; }
		const t = new TableEditor(D.id, D.database, arg.schema, arg.table, () => tables.delete(key));
		tables.set(key, t);
	}

	async function pickDatabase() {
		if (!need() || !D.detail) { return; }
		const pick = await vscode.window.showQuickPick(D.detail.databases.map((d) => ({ label: d.name, description: d.name === D.database ? 'current' : '' })), { title: 'Switch Database' });
		if (!pick) { return; }
		D.database = pick.label;
		render();
		tree.refresh();
	}

	async function connect() {
		if (!need() || !D.detail) { return; }
		const roles = D.detail.roles || [];
		const role = roles.length > 1 ? await vscode.window.showQuickPick(roles.map((r) => ({ label: r.name, description: r.template })), { title: 'Connect as which role?' }) : { label: (roles[0] || { name: 'owner' }).name };
		if (!role) { return; }
		const kind = await vscode.window.showQuickPick([{ label: 'Pooled', description: 'for serverless code', value: 'pooled' }, { label: 'Direct', description: 'for migrations and long-lived servers', value: 'direct' }], { title: 'Connection type' });
		if (!kind) { return; }
		try {
			const c = await db.connection(D.id, role.label, D.database);
			await vscode.env.clipboard.writeText(c.connection[kind.value]);
			vscode.window.showInformationMessage(`The ${kind.label.toLowerCase()} connection string for ${role.label} on ${D.database} is on your clipboard.`);
		} catch (e) { vscode.window.showErrorMessage(errText(e)); }
	}

	async function showHistory() {
		if (!need()) { return; }
		try {
			const h = await db.history(D.id);
			if (!h.length) { vscode.window.showInformationMessage('Nothing has been run on this project yet.'); return; }
			const pick = await vscode.window.showQuickPick(h.map((x) => ({ label: x.sql.replace(/\s+/g, ' ').slice(0, 110), description: `${x.database} · ${x.ok ? '' : 'failed · '}${x.ms} ms`, detail: new Date(x.ran_at).toLocaleString(), sql: x.sql })), { title: 'SQL History', matchOnDetail: true });
			if (pick) { await appendScript(pick.sql); }
		} catch (e) { vscode.window.showErrorMessage(errText(e)); }
	}

	async function appendScript(sql) {
		const uri = vscode.Uri.from({ scheme: SCHEME, authority: D.id, path: '/query.sql' });
		const doc = await vscode.workspace.openTextDocument(uri);
		const ed = await vscode.window.showTextDocument(doc, { preview: false });
		const end = doc.lineAt(doc.lineCount - 1).range.end;
		await ed.edit((b) => b.insert(end, `${doc.getText().endsWith('\n') ? '' : '\n'}\n${sql.trim()}\n`));
		const last = ed.document.lineCount - 2;
		ed.selection = new vscode.Selection(last - sql.trim().split('\n').length + 1, 0, last, ed.document.lineAt(last).text.length);
	}

	async function selectTop(node) {
		if (!need() || !node) { return; }
		await appendScript(`select * from ${db.qt(node.schema || node.item.command.arguments[0].schema, node.table || node.item.command.arguments[0].table)} limit 100;`);
		await run();
	}

	async function newScript() {
		if (!need()) { return; }
		const name = await vscode.window.showInputBox({ title: 'New SQL Script', prompt: 'File name', value: 'script.sql', validateInput: (v) => (/^[\w.-]+\.sql$/.test(v) ? undefined : 'Use a name ending in .sql') });
		if (!name) { return; }
		const uri = vscode.Uri.from({ scheme: SCHEME, authority: D.id, path: `/${name}` });
		await vscode.workspace.fs.writeFile(uri, Buffer.from('-- New script\n'));
		await vscode.window.showTextDocument(uri, { preview: false });
	}

	async function menu() {
		if (!need()) { return; }
		const items = [
			{ label: '$(play) Run SQL', id: 'vantrex.db.run' },
			{ label: '$(database) Switch Database...', id: 'vantrex.db.switchDatabase' },
			{ label: '$(plug) Copy Connection String...', id: 'vantrex.db.connect' },
			{ label: '$(history) SQL History...', id: 'vantrex.db.history' },
			{ label: '$(new-file) New SQL Script...', id: 'vantrex.db.newScript' },
			{ label: '$(refresh) Refresh Tables', id: 'vantrex.db.refresh' },
			{ label: '$(zap) Wake Database', id: 'vantrex.db.wake' },
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: '$(folder-opened) Open Another Workspace...', id: 'vantrex.workspace.open' },
		];
		const pick = await vscode.window.showQuickPick(items, { title: `${D.name} · ${D.database}` });
		if (pick) { await vscode.commands.executeCommand(pick.id); }
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('vantrex.db.run', run),
		vscode.commands.registerCommand('vantrex.db.openTable', openTable),
		vscode.commands.registerCommand('vantrex.db.refresh', () => tree.refresh()),
		vscode.commands.registerCommand('vantrex.db.switchDatabase', pickDatabase),
		vscode.commands.registerCommand('vantrex.db.connect', connect),
		vscode.commands.registerCommand('vantrex.db.history', showHistory),
		vscode.commands.registerCommand('vantrex.db.selectTop', selectTop),
		vscode.commands.registerCommand('vantrex.db.newScript', newScript),
		vscode.commands.registerCommand('vantrex.db.menu', menu),
		vscode.commands.registerCommand('vantrex.db.wake', async () => { if (need()) { try { await db.wake(D.id); await poll(); } catch (e) { vscode.window.showErrorMessage(errText(e)); } } }),
		vscode.workspace.onDidChangeWorkspaceFolders(() => { if (D && folderId() !== D.id) { detach(); } void attach(); }),
		{ dispose: detach },
	);

	void attach();
	return { SCHEME };
}

module.exports = { activateDb, SCHEME };
