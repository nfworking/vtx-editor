// Source Control for a Vantrex workspace: the files you changed, each one's difference from the branch, and a Commit & Push button
// that sends them to GitHub (see commit.js: the commit is made with your own GitHub account, on the branch or a new one, with an
// optional pull request). A workspace is a virtual folder with no .git, so the editor's own Git support has nothing to show here.

'use strict';

const vscode = require('vscode');
const { call } = require('./api');
const { collect } = require('./commit');

const ORIGINAL = 'vtxorig';
const isMac = process.platform === 'darwin';

const STATUS = {
	modified: { letter: 'M', label: 'Modified', color: 'gitDecoration.modifiedResourceForeground' },
	added: { letter: 'A', label: 'Added', color: 'gitDecoration.addedResourceForeground' },
	deleted: { letter: 'D', label: 'Deleted', color: 'gitDecoration.deletedResourceForeground' },
};

/** Creates the Source Control view for the workspace in `S`. `commitNow(message)` runs the commit and resolves when it is done. */
function createWorkspaceScm(S, fs, commitNow) {
	const root = vscode.Uri.from({ scheme: 'vtxws', authority: S.id, path: '/' });
	const sc = vscode.scm.createSourceControl('vantrex', `Vantrex: ${S.name}`, root);
	sc.inputBox.placeholder = `Message (${isMac ? '⌘' : 'Ctrl+'}Enter to commit to GitHub)`;
	sc.acceptInputCommand = { command: 'vantrex.workspace.scmCommit', title: 'Commit' };
	sc.statusBarCommands = [{ command: 'vantrex.workspace.menu', title: `$(git-branch) ${S.branch}`, tooltip: `Branch ${S.branch}: workspace menu` }];
	const group = sc.createResourceGroup('changes', 'Changes');
	group.hideWhenEmpty = true;

	const decorations = new vscode.EventEmitter();
	const byPath = new Map(); // workspace path -> status key
	const fileUri = (p) => vscode.Uri.from({ scheme: 'vtxws', authority: S.id, path: '/' + p });
	const originalUri = (p) => vscode.Uri.from({ scheme: ORIGINAL, path: '/' + p, query: new URLSearchParams({ project: S.projectId, sha: S.baseline.files.get(p) || '' }).toString() });

	const disposables = [
		sc, decorations,
		// The branch's version of a file, from GitHub, for the side-by-side view and the gutter marks.
		vscode.workspace.registerTextDocumentContentProvider(ORIGINAL, {
			async provideTextDocumentContent(uri) {
				const q = new URLSearchParams(uri.query);
				if (!q.get('sha')) { return ''; }
				const r = await call('GET', `editor/projects/${encodeURIComponent(q.get('project'))}/blob/${encodeURIComponent(q.get('sha'))}`);
				return r.buf.toString('utf8');
			},
		}),
		vscode.window.registerFileDecorationProvider({
			onDidChangeFileDecorations: decorations.event,
			provideFileDecoration(uri) {
				if (uri.scheme !== 'vtxws' || uri.authority !== S.id) { return undefined; }
				const st = STATUS[byPath.get(uri.path.replace(/^\/+/, ''))];
				return st ? { badge: st.letter, tooltip: st.label, color: new vscode.ThemeColor(st.color) } : undefined;
			},
		}),
	];
	sc.quickDiffProvider = { provideOriginalResource: (uri) => (uri.scheme === 'vtxws' && uri.authority === S.id && S.baseline.files.has(uri.path.replace(/^\/+/, '')) ? originalUri(uri.path.replace(/^\/+/, '')) : undefined) };

	let timer;
	let running = false;
	let again = false;

	async function refresh() {
		if (running) { again = true; return; }
		running = true;
		try {
			const changes = S.baseline.touched.size ? await collect(S.baseline, S.id) : [];
			const states = changes.map((c) => {
				const key = c.delete ? 'deleted' : S.baseline.files.has(c.path) ? 'modified' : 'added';
				const uri = fileUri(c.path);
				byPath.set(c.path, key);
				return {
					resourceUri: uri,
					contextValue: key,
					decorations: { tooltip: STATUS[key].label, strikeThrough: key === 'deleted' },
					command: key === 'modified' ? { command: 'vscode.diff', title: 'Open Changes', arguments: [originalUri(c.path), uri, `${c.path.split('/').pop()} (Changes)`] }
						: key === 'added' ? { command: 'vscode.open', title: 'Open', arguments: [uri] }
							: undefined,
				};
			});
			for (const p of [...byPath.keys()]) { if (!changes.some((c) => c.path === p)) { byPath.delete(p); } }
			group.resourceStates = states;
			sc.count = states.length;
			sc.actionButton = {
				command: { command: 'vantrex.workspace.scmCommit', title: '$(cloud-upload) Commit & Push', tooltip: 'Commit your changes to GitHub: on this branch or a new one, with an optional pull request' },
				enabled: states.length > 0,
			};
			decorations.fire(undefined);
		} catch { /* a commit says why it could not find the changes */ } finally {
			running = false;
			if (again) { again = false; schedule(); }
		}
	}

	/** Looks again soon: edits arrive in bursts. */
	function schedule() { clearTimeout(timer); timer = setTimeout(refresh, 800); }

	/** Puts a file back as the branch has it (and removes one that is new). */
	async function discard(state) {
		const uri = state.resourceUri;
		const p = uri.path.replace(/^\/+/, '');
		const key = byPath.get(p);
		const sure = await vscode.window.showWarningMessage(`Discard the changes to ${p}?`, { modal: true, detail: 'This cannot be undone.' }, 'Discard');
		if (!sure) { return; }
		if (key === 'added') {
			await vscode.workspace.fs.delete(uri);
		} else {
			const sha = S.baseline.files.get(p);
			const blob = await call('GET', `editor/projects/${encodeURIComponent(S.projectId)}/blob/${encodeURIComponent(sha)}`);
			await vscode.workspace.fs.writeFile(uri, new Uint8Array(blob.buf));
		}
		await refresh();
	}

	async function commitFromBox() {
		const message = sc.inputBox.value;
		if (!message.trim()) { sc.inputBox.focus?.(); void vscode.window.showInformationMessage('Type a commit message first.'); return; }
		const out = await commitNow(message);
		if (out) { sc.inputBox.value = ''; }
		await refresh();
	}

	return {
		refresh, schedule, discard, commitFromBox,
		dispose() { clearTimeout(timer); disposables.forEach((d) => d.dispose()); group.dispose(); },
	};
}

module.exports = { createWorkspaceScm };
