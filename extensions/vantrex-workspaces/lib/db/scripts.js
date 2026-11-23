// The scripts of a database project as files: `vtxdb://<project id>/query.sql` and whatever else is saved beside it. They live in the
// extension's storage on this machine (the database itself holds only data), so the editor, tabs and restore-on-restart work as for any folder.

'use strict';

const vscode = require('vscode');

const STARTER = `-- Run with Cmd+Enter (Ctrl+Enter). The selection runs if there is one, otherwise the whole file.
-- Statements run as the project's owner role.
select now() as now, current_database() as database, version() as version;
`;

class ScriptFileSystem {
	constructor(context) {
		this.root = vscode.Uri.joinPath(context.globalStorageUri, 'db');
		this._changes = new vscode.EventEmitter();
		this.onDidChangeFile = this._changes.event;
	}

	watch() { return new vscode.Disposable(() => { }); }

	_real(uri) { return vscode.Uri.joinPath(this.root, uri.authority, uri.path); }

	async ensure(authority) {
		const dir = vscode.Uri.joinPath(this.root, authority);
		await vscode.workspace.fs.createDirectory(dir);
		const q = vscode.Uri.joinPath(dir, 'query.sql');
		try { await vscode.workspace.fs.stat(q); } catch { await vscode.workspace.fs.writeFile(q, Buffer.from(STARTER)); }
	}

	async stat(uri) { await this.ensure(uri.authority); return vscode.workspace.fs.stat(this._real(uri)); }
	async readDirectory(uri) { await this.ensure(uri.authority); return vscode.workspace.fs.readDirectory(this._real(uri)); }
	createDirectory(uri) { return vscode.workspace.fs.createDirectory(this._real(uri)); }
	async readFile(uri) { await this.ensure(uri.authority); return vscode.workspace.fs.readFile(this._real(uri)); }
	async writeFile(uri, content) { await this.ensure(uri.authority); await vscode.workspace.fs.writeFile(this._real(uri), content); this._changes.fire([{ type: vscode.FileChangeType.Changed, uri }]); }
	delete(uri, options) { return vscode.workspace.fs.delete(this._real(uri), options); }
	rename(from, to, options) { return vscode.workspace.fs.rename(this._real(from), this._real(to), options); }
}

module.exports = { ScriptFileSystem };
