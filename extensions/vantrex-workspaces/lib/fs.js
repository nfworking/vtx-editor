// The workspace's files as a VS Code file system, `vtxws://<workspace id>/path`, on top of the runner's fs API. Everything the editor,
// the explorer, search and quick open do with files goes through here; the runner confines every path to the checkout.

'use strict';

const vscode = require('vscode');
const { call, ws, ApiError } = require('./api');

const { FileType, FileSystemError } = vscode;

function toFsError(e, uri) {
	if (!(e instanceof ApiError)) { return FileSystemError.Unavailable(e && e.message ? e.message : String(e)); }
	switch (e.status) {
		case 401: return FileSystemError.NoPermissions('Sign in to Vantrex to use this workspace.');
		case 404: return FileSystemError.FileNotFound(uri);
		case 409: return /exist/i.test(e.message) ? FileSystemError.FileExists(uri) : FileSystemError.Unavailable(e.message);
		case 413: return FileSystemError.Unavailable('This file is too large for the workspace.');
		case 400: return FileSystemError.NoPermissions(e.message);
		default: return FileSystemError.Unavailable(e.message);
	}
}

const rel = (uri) => uri.path.replace(/^\/+|\/+$/g, '');
const parentOf = (p) => p.split('/').slice(0, -1).join('/');

class WorkspaceFileSystem {
	constructor() {
		this._changes = new vscode.EventEmitter();
		this.onDidChangeFile = this._changes.event;
		this._touched = new vscode.EventEmitter();
		/** Fires with the workspace-relative path of every file or folder the person changed (for the Commit command). */
		this.onDidTouch = this._touched.event;
		this._lists = new Map(); // `${id}:${dir}` -> { at, entries }
		this._mtimes = new Map(); // uri string -> ms of the last write we made or read
		this._versions = new Map(); // uri string -> X-Vtx-Version of the last read, so a save can detect a change underneath
		this._made = new Set(); // folders created and still empty: the runner has no mkdir, a folder exists once a file is in it
	}

	watch() { return new vscode.Disposable(() => { }); }

	async _list(uri, fresh) {
		const id = uri.authority;
		const dir = rel(uri);
		const key = `${id}:${dir}`;
		const hit = this._lists.get(key);
		if (!fresh && hit && Date.now() - hit.at < 1500) { return hit.entries; }
		try {
			const r = await call('GET', `${ws(id)}/fs/list`, { query: { path: dir } });
			const entries = Array.isArray(r.data) ? r.data : [];
			for (const m of this._made) {
				const [mid, mdir] = m.split('|');
				if (mid === id && parentOf(mdir) === dir && !entries.some((x) => x.name === mdir.split('/').pop())) { entries.push({ name: mdir.split('/').pop(), dir: true, size: 0 }); }
			}
			this._lists.set(key, { at: Date.now(), entries });
			return entries;
		} catch (e) {
			throw toFsError(e, uri);
		}
	}

	_forget(uri) {
		const id = uri.authority;
		this._lists.delete(`${id}:${parentOf(rel(uri))}`);
	}

	/** Forgets what was listed, so the next stat or listing asks the runner (after a task that wrote files). */
	invalidate() { this._lists.clear(); this._changes.fire([]); }

	async stat(uri) {
		const p = rel(uri);
		if (p === '') { return { type: FileType.Directory, ctime: 0, mtime: 0, size: 0 }; }
		if (this._made.has(`${uri.authority}|${p}`)) { return { type: FileType.Directory, ctime: 0, mtime: 0, size: 0 }; }
		const entries = await this._list(vscode.Uri.from({ scheme: uri.scheme, authority: uri.authority, path: '/' + parentOf(p) }));
		const name = p.split('/').pop();
		const e = entries.find((x) => x.name === name);
		if (!e) { throw FileSystemError.FileNotFound(uri); }
		// The listing has no modification times, and a time that changed between the editor's stat and its read would look like a
		// conflict on save: the editor tells versions apart by size.
		return { type: (e.dir ? FileType.Directory : FileType.File) | (e.link ? FileType.SymbolicLink : 0), ctime: 0, mtime: 0, size: e.size || 0 };
	}

	async readDirectory(uri) {
		return (await this._list(uri, true)).map((e) => [e.name, (e.dir ? FileType.Directory : FileType.File) | (e.link ? FileType.SymbolicLink : 0)]);
	}

	async createDirectory(uri) {
		this._made.add(`${uri.authority}|${rel(uri)}`);
		this._forget(uri);
		this._touched.fire(rel(uri));
		this._changes.fire([{ type: vscode.FileChangeType.Created, uri }]);
	}

	async readFile(uri) {
		try {
			const r = await call('GET', `${ws(uri.authority)}/fs/file`, { query: { path: rel(uri) } });
			const v = r.headers.get('x-vtx-version');
			if (v) { this._versions.set(uri.toString(), v); const m = /-(\d+)$/.exec(v); if (m) { this._mtimes.set(uri.toString(), Math.floor(Number(m[1]) / 1e6)); } }
			return new Uint8Array(r.buf);
		} catch (e) {
			throw toFsError(e, uri);
		}
	}

	async writeFile(uri, content, options) {
		const p = rel(uri);
		const exists = this._versions.has(uri.toString()) || this._mtimes.has(uri.toString());
		if (!exists) {
			// Creating: refuse to overwrite a file that is already there unless the editor said to.
			let there = true;
			try { await this.stat(uri); } catch { there = false; }
			if (there && options && options.create && !options.overwrite) { throw FileSystemError.FileExists(uri); }
			if (!there && options && !options.create) { throw FileSystemError.FileNotFound(uri); }
		}
		try {
			const r = await call('PUT', `${ws(uri.authority)}/fs/file`, { query: { path: p }, raw: Buffer.from(content) });
			const v = r.data && r.data.version;
			if (v) { this._versions.set(uri.toString(), v); const m = /-(\d+)$/.exec(v); if (m) { this._mtimes.set(uri.toString(), Math.floor(Number(m[1]) / 1e6)); } }
		} catch (e) {
			throw toFsError(e, uri);
		}
		this._forget(uri);
		for (const m of [...this._made]) { if (m.startsWith(`${uri.authority}|`) && p.startsWith(m.split('|')[1] + '/')) { this._made.delete(m); } }
		this._touched.fire(p);
		this._changes.fire([{ type: exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
	}

	async delete(uri) {
		const p = rel(uri);
		if (p === '') { throw FileSystemError.NoPermissions('The workspace root cannot be deleted.'); }
		try {
			await call('DELETE', `${ws(uri.authority)}/fs/file`, { query: { path: p } });
		} catch (e) {
			if (!(e instanceof ApiError && e.status === 404)) { throw toFsError(e, uri); }
		}
		this._made.delete(`${uri.authority}|${p}`);
		this._forget(uri);
		this._touched.fire(p);
		this._changes.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
	}

	async rename(from, to, options) {
		if (!(options && options.overwrite)) {
			let there = true;
			try { await this.stat(to); } catch { there = false; }
			if (there) { throw FileSystemError.FileExists(to); }
		} else {
			try { await this.delete(to); } catch { /* nothing to replace */ }
		}
		try {
			await call('POST', `${ws(from.authority)}/fs/rename`, { query: { from: rel(from), to: rel(to) } });
		} catch (e) {
			throw toFsError(e, from);
		}
		this._forget(from);
		this._forget(to);
		this._touched.fire(rel(from));
		this._touched.fire(rel(to));
		this._changes.fire([{ type: vscode.FileChangeType.Deleted, uri: from }, { type: vscode.FileChangeType.Created, uri: to }]);
	}
}

module.exports = { WorkspaceFileSystem };
