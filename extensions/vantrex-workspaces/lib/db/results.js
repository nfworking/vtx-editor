// The Results panel: one tab per statement, a row count and the time it took, like the dashboard's SQL editor.

'use strict';

const vscode = require('vscode');
const { page } = require('./ui');

const BODY = `
<div class="bar"><span id="state" class="muted">Run a query with Cmd+Enter.</span><span class="grow"></span><span id="ms" class="muted"></span><button id="csv" class="ghost" hidden>Copy CSV</button></div>
<div id="tabs" class="tabs" hidden></div>
<div id="err" class="err" hidden></div>
<div class="scroll" id="out"></div>`;

const SCRIPT = `
const vs = acquireVsCodeApi();
let data = null, cur = 0;
const $ = (id) => document.getElementById(id);
const label = (i, r) => { const w = (r.command || '').split(' ')[0] || 'OK'; const n = w === 'SELECT' || (r.columns && r.columns.length) ? r.rows.length : ['INSERT','UPDATE','DELETE','MERGE','COPY','MOVE','FETCH'].includes(w) ? r.affected : null; return (i + 1) + ': ' + w + (n === null ? '' : ' ' + n); };
function cell(v) { const td = document.createElement('td'); if (v === null) { td.className = 'null'; td.textContent = 'NULL'; } else { td.textContent = v; if (/^-?\\d+(\\.\\d+)?$/.test(v)) td.className = 'num'; td.title = v; } return td; }
function render() {
  const out = $('out'); out.textContent = '';
  if (!data) return;
  const rs = data.results || [];
  $('tabs').hidden = rs.length < 2;
  $('tabs').textContent = '';
  rs.forEach((r, i) => { const b = document.createElement('button'); b.textContent = label(i, r); b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', i === cur); b.onclick = () => { cur = i; render(); }; $('tabs').appendChild(b); });
  $('err').hidden = !data.error; $('err').textContent = data.error || '';
  $('ms').textContent = data.ms != null ? data.ms + ' ms' : '';
  const r = rs[cur];
  $('csv').hidden = !(r && r.columns && r.columns.length);
  if (!r) { $('state').innerHTML = data.error ? 'Failed' : 'No result'; return; }
  if (!r.columns || !r.columns.length) { $('state').textContent = (r.command || 'OK') + (r.affected ? ' · ' + r.affected + ' row' + (r.affected === 1 ? '' : 's') + ' affected' : ''); const p = document.createElement('p'); p.className = 'msg ok'; p.textContent = 'Statement ran.'; out.appendChild(p); return; }
  $('state').innerHTML = '<span class="ok">●</span> ' + r.rows.length + ' row' + (r.rows.length === 1 ? '' : 's') + (r.truncated ? ' (truncated)' : '') + ' · ' + data.database;
  const t = document.createElement('table'); const h = t.createTHead().insertRow();
  r.columns.forEach((c) => { const th = document.createElement('th'); th.textContent = c; h.appendChild(th); });
  const body = t.createTBody();
  r.rows.forEach((row) => { const tr = body.insertRow(); row.forEach((v) => tr.appendChild(cell(v))); });
  out.appendChild(t);
}
$('csv').onclick = () => { const r = data.results[cur]; const esc = (v) => v === null ? '' : /[",\\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; vs.postMessage({ type: 'copy', text: [r.columns.map(esc).join(',')].concat(r.rows.map((x) => x.map(esc).join(','))).join('\\n') }); };
window.addEventListener('message', (e) => { const m = e.data; if (m.type === 'results') { data = m; cur = Math.max(0, (m.results || []).length - 1); render(); } if (m.type === 'busy') { $('state').textContent = 'Running...'; $('err').hidden = true; } });
vs.postMessage({ type: 'ready' });`;

class ResultsView {
	constructor() { this.view = undefined; this.last = undefined; }

	resolveWebviewView(view) {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = page('Results', BODY, SCRIPT);
		view.webview.onDidReceiveMessage((m) => {
			if (m.type === 'ready' && this.last) { view.webview.postMessage(this.last); }
			if (m.type === 'copy') { void vscode.env.clipboard.writeText(m.text).then(() => vscode.window.setStatusBarMessage('Copied as CSV', 2000)); }
		});
		view.onDidDispose(() => { this.view = undefined; });
	}

	busy() { if (this.view) { this.view.webview.postMessage({ type: 'busy' }); } }

	async show(payload) {
		this.last = Object.assign({ type: 'results' }, payload);
		await vscode.commands.executeCommand('vantrex.db.results.focus', { preserveFocus: true });
		if (this.view) { this.view.webview.postMessage(this.last); }
	}
}

module.exports = { ResultsView };
