// The workspace terminal. The runner never gives out a shell: a line typed here is parsed on the server into one of the allowed
// package manager tasks (`npm install`, `pnpm add zod`, `yarn dev`, `bun run build`...) and anything else is refused. This
// pseudo-terminal does the line editing locally, sends the line, and streams the task's output (with its colours) back.

'use strict';

const vscode = require('vscode');
const { call, ws, ApiError } = require('./api');
const tasks = require('./tasks');

const PROMPT = '\x1b[38;5;209m❯\x1b[0m ';

class WorkspaceTerminal {
	constructor(id, name, onTaskEnd) {
		this.id = id;
		this.name = name;
		this.onTaskEnd = onTaskEnd;
		this.line = '';
		this.history = [];
		this.cursor = -1;
		this.running = undefined; // { task, abort }
		this._write = new vscode.EventEmitter();
		this.onDidWrite = this._write.event;
		this._close = new vscode.EventEmitter();
		this.onDidClose = this._close.event;
	}

	open() {
		this._write.fire(`\x1b[1mVantrex workspace\x1b[0m ${this.name}\r\n`);
		this._write.fire('\x1b[2mPackage manager commands only: install, add, remove, run, dev, build, test, lint. Ctrl+C stops a running task.\x1b[0m\r\n\r\n');
		this._write.fire(PROMPT);
	}

	close() {
		if (this.running) { this.running.abort.abort(); }
	}

	handleInput(data) {
		if (this.running) {
			if (data === '\x03') { void this._cancel(); }
			return;
		}
		for (const ch of data.startsWith('\x1b') ? [data] : data) {
			if (ch === '\r') { void this._submit(); }
			else if (ch === '\x7f') { if (this.line) { this.line = this.line.slice(0, -1); this._write.fire('\b \b'); } }
			else if (ch === '\x03') { this.line = ''; this._write.fire('^C\r\n' + PROMPT); }
			else if (ch === '\x15') { this._write.fire('\b \b'.repeat(this.line.length)); this.line = ''; }
			else if (ch === '\x1b[A') { this._recall(1); }
			else if (ch === '\x1b[B') { this._recall(-1); }
			else if (ch >= ' ' && !ch.startsWith('\x1b')) { this.line += ch; this._write.fire(ch); }
		}
	}

	_recall(dir) {
		const next = this.cursor + dir;
		if (next < -1 || next >= this.history.length) { return; }
		this.cursor = next;
		const text = next === -1 ? '' : this.history[this.history.length - 1 - next];
		this._write.fire('\b \b'.repeat(this.line.length) + text);
		this.line = text;
	}

	async _cancel() {
		if (!this.running) { return; }
		this._write.fire('^C\r\n');
		try { await tasks.stop(this.id, this.running.task); } catch { /* it ended on its own */ }
	}

	async _submit() {
		const line = this.line.trim();
		this.line = '';
		this.cursor = -1;
		this._write.fire('\r\n');
		if (!line) { this._write.fire(PROMPT); return; }
		if (line === 'clear') { this._write.fire('\x1b[2J\x1b[3J\x1b[H' + PROMPT); return; }
		this.history.push(line);
		try {
			const r = await call('POST', `${ws(this.id)}/tasks`, { body: { line } });
			const task = r.data.id;
			const abort = new AbortController();
			this.running = { task, abort };
			const end = await tasks.follow(this.id, task, (t) => this._write.fire(t.replace(/\r?\n/g, '\r\n')), abort.signal);
			this._write.fire(end.ok ? '\r\n\x1b[32mDone.\x1b[0m\r\n' : `\r\n\x1b[31m${end.error ? `Stopped: ${end.error}` : 'Failed.'}\x1b[0m\r\n`);
			this.onTaskEnd(line, end.ok);
		} catch (e) {
			const msg = e instanceof ApiError ? e.message : (e && e.message) || String(e);
			this._write.fire(`\x1b[31m${msg}\x1b[0m\r\n`);
		} finally {
			this.running = undefined;
			this._write.fire(PROMPT);
		}
	}
}

module.exports = { WorkspaceTerminal };
