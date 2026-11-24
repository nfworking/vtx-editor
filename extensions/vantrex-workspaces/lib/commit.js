// Commit from the IDE, the way the dashboard editor does it: the files you changed go to GitHub as one atomic commit made with your own
// GitHub account (nothing is pushed from the workspace). The baseline is the branch's tree at the moment the workspace was opened;
// a file counts as changed when its content no longer matches the git id it had there.

'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const { call, ApiError, ws } = require('./api');

const MAX_FILES = 200;
const MAX_FILE = 2 * 1024 * 1024;

const gitId = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

const suggestBranch = () => {
	const d = new Date();
	const p = (n) => String(n).padStart(2, '0');
	return `vtx/edit-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

class Baseline {
	constructor(projectId, branch) {
		this.projectId = projectId;
		this.branch = branch;
		this.head = '';
		this.files = new Map(); // path -> blob sha
		this.touched = new Set();
	}

	async load(branch) {
		const r = await call('GET', `editor/projects/${encodeURIComponent(this.projectId)}/tree`, { query: { ref: branch || this.branch } });
		this.branch = branch || this.branch;
		this.head = r.data.commit;
		this.truncated = !!r.data.truncated;
		this.files = new Map((r.data.entries || []).filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
		this.touched.clear();
	}

	touch(p) { if (p) { this.touched.add(p); } }
}

/** Reads a workspace file; null when it is gone. */
async function readFile(id, path) {
	try { return (await call('GET', `${ws(id)}/fs/file`, { query: { path } })).buf; } catch (e) { if (e instanceof ApiError && e.status === 404) { return null; } throw e; }
}

async function walk(id, dir, out) {
	let r;
	try { r = await call('GET', `${ws(id)}/fs/list`, { query: { path: dir } }); } catch (e) { if (e instanceof ApiError && (e.status === 404 || e.status === 400)) { return false; } throw e; }
	for (const e of r.data || []) {
		const p = dir ? `${dir}/${e.name}` : e.name;
		if (e.dir) { await walk(id, p, out); } else { out.add(p); }
	}
	return true;
}

/** The list of changes: { path, content (Buffer) } for added or modified files, { path, delete } for removed ones. */
async function collect(base, workspaceId, progress) {
	const present = new Set(); // files that exist now under any touched path
	const gone = new Set(); // touched paths that no longer exist
	for (const p of base.touched) {
		const buf = await readFile(workspaceId, p).catch(() => null);
		if (buf) { present.add(p); continue; }
		const dir = new Set();
		if (await walk(workspaceId, p, dir)) { dir.forEach((f) => present.add(f)); } else { gone.add(p); }
	}
	const changes = [];
	for (const p of base.files.keys()) {
		const missing = [...gone].some((g) => p === g || p.startsWith(g + '/')) || ([...base.touched].some((t) => p.startsWith(t + '/')) && !present.has(p));
		if (missing) { changes.push({ path: p, delete: true }); }
	}
	let n = 0;
	for (const p of present) {
		progress && progress.report({ message: `Checking ${++n} of ${present.size}` });
		const buf = await readFile(workspaceId, p);
		if (!buf) { continue; }
		if (base.files.get(p) === gitId(buf)) { continue; }
		if (buf.length > MAX_FILE) { throw new Error(`${p} is larger than 2 MB, which the editor cannot commit.`); }
		changes.push({ path: p, content: buf });
	}
	return changes;
}

/** Asks for the message and where the commit goes, then commits. Resolves to the result or undefined when cancelled or nothing changed. */
async function commit(base, workspaceId, prodBranch, onDone, options = {}) {
	const changes = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Finding your changes' }, (progress) => collect(base, workspaceId, progress));
	if (!changes.length) { vscode.window.showInformationMessage('Nothing to commit: no file differs from the branch.'); return undefined; }
	if (changes.length > MAX_FILES) { vscode.window.showErrorMessage(`${changes.length} files changed. The editor commits up to ${MAX_FILES} at a time.`); return undefined; }

	const added = changes.filter((c) => !c.delete && !base.files.has(c.path)).length;
	const removed = changes.filter((c) => c.delete).length;
	const summary = `${changes.length} file${changes.length === 1 ? '' : 's'} (${added} new, ${removed} deleted)`;

	const message = options.message && options.message.trim() ? options.message : await vscode.window.showInputBox({ title: `Commit ${summary}`, prompt: 'Commit message', placeHolder: 'Describe the change', validateInput: (v) => (v.trim() ? undefined : 'A commit message is required') });
	if (message === undefined) { return undefined; }

	const onProd = base.branch === prodBranch;
	const newName = suggestBranch();
	const choices = onProd
		? [
			{ label: `$(git-branch) New branch ${newName}`, detail: 'Recommended: review the change before it goes live', mode: 'new' },
			{ label: `$(warning) Commit directly to ${base.branch}`, detail: 'Production deploys as soon as this lands', mode: 'direct' },
		]
		: [
			{ label: `$(git-commit) Commit to ${base.branch}`, mode: 'same' },
			{ label: `$(git-branch) New branch ${newName}`, mode: 'new' },
		];
	const dest = await vscode.window.showQuickPick(choices, { title: 'Where should the commit go?' });
	if (!dest) { return undefined; }

	let branch = base.branch;
	let createBranch = false;
	if (dest.mode === 'new') {
		const name = await vscode.window.showInputBox({ title: 'New branch', value: newName, validateInput: (v) => (/^[A-Za-z0-9._\/-]{1,200}$/.test(v) && !v.startsWith('/') && !v.endsWith('/') && !v.includes('..') ? undefined : 'Use letters, numbers and . _ - /') });
		if (!name) { return undefined; }
		branch = name;
		createBranch = true;
	}
	if (dest.mode === 'direct') {
		const sure = await vscode.window.showWarningMessage(`Commit ${summary} straight to ${base.branch}?`, { modal: true, detail: 'This deploys to production.' }, 'Commit to Production');
		if (!sure) { return undefined; }
	}
	let openPR = false;
	if (dest.mode !== 'direct') {
		const pr = await vscode.window.showQuickPick([{ label: 'Open a pull request', value: true }, { label: 'Just commit', value: false }], { title: 'Pull request' });
		if (!pr) { return undefined; }
		openPR = pr.value;
	}

	const body = {
		branch, create_branch: createBranch, base: base.branch, expected_head: base.head, message: message.trim(),
		direct_to_production: dest.mode === 'direct', open_pr: openPR,
		changes: changes.map((c) => c.delete ? { path: c.path, delete: true } : { path: c.path, content: c.content.toString('base64') }),
	};
	let res;
	try {
		res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Committing to GitHub' }, () => call('POST', `editor/projects/${encodeURIComponent(base.projectId)}/commit`, { body }));
	} catch (e) {
		const m = e instanceof ApiError ? e.message : String(e);
		if (e instanceof ApiError && e.code === 'branch_moved') { vscode.window.showErrorMessage('The branch has new commits since this workspace was opened. Open the workspace again to pick them up, then commit.'); }
		else if (e instanceof ApiError && (e.code === 'github_not_linked' || e.code === 'github_expired')) {
			vscode.window.showErrorMessage('Link your GitHub account in the dashboard to commit from the IDE.');
		} else { vscode.window.showErrorMessage(`Commit failed: ${m}`); }
		return undefined;
	}
	const out = res.data;
	// What was committed is the new baseline, so the next commit only carries what changes from here.
	try { await base.load(out.branch); } catch { base.touched.clear(); }
	const actions = out.pr ? ['Open Pull Request'] : [];
	const pick = await vscode.window.showInformationMessage(`Committed ${summary} to ${out.branch}${out.pr_error ? `. ${out.pr_error}` : ''}`, ...actions);
	if (pick && out.pr) { void vscode.env.openExternal(vscode.Uri.parse(out.pr.url)); }
	onDone && onDone(out);
	return out;
}

module.exports = { Baseline, commit, collect, gitId };
