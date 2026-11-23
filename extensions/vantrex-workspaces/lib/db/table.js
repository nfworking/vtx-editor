// The table editor: a grid of the table's rows you can sort, filter, page, edit in place, add to and delete from, and a Structure tab
// with its columns and indexes. Everything runs as SQL through the project's query endpoint, as in the dashboard's Tables view.

'use strict';

const vscode = require('vscode');
const db = require('./api');
const { page } = require('./ui');

const PAGE = 50;
const OPS = { '=': '=', '!=': '<>', '>': '>', '<': '<' };

const BODY = `
<div class="bar">
  <strong id="name"></strong><span id="count" class="muted"></span>
  <div class="seg"><button id="tData" aria-pressed="true">Data</button><button id="tStruct" aria-pressed="false">Structure</button></div>
  <span class="grow"></span>
  <span class="rel"><button id="bFilter">Filter</button><div id="pFilter" class="pop" hidden></div></span>
  <button id="bRefresh" class="ghost" title="Refresh">Refresh</button>
  <button id="bAdd">Add row</button>
  <button id="bDel" class="danger" hidden>Delete</button>
</div>
<div id="err" class="err" hidden></div>
<div class="scroll" id="grid"></div>
<div class="bar" id="foot"><button id="prev" class="ghost">Previous</button><span id="pageNo" class="muted"></span><button id="next" class="ghost">Next</button><span class="grow"></span><span id="busy" class="muted"></span></div>
<div id="modal" class="modal" hidden></div>`;

const SCRIPT = `
const vs = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let st = { view: 'data', page: 0, sort: null, filters: [], cols: [], header: [], rows: [], more: false, picked: new Set(), indexes: [], edit: null, confirm: false };
const send = (type, extra) => vs.postMessage(Object.assign({ type }, extra));
function load() { send('load', { page: st.page, sort: st.sort, filters: st.filters }); $('busy').textContent = 'Loading...'; }
function setErr(t) { $('err').hidden = !t; $('err').textContent = t || ''; }
function td(v) { const c = document.createElement('td'); if (v === null) { c.className = 'null'; c.textContent = 'NULL'; } else { c.textContent = v; if (/^-?\\d+(\\.\\d+)?$/.test(v)) c.className = 'num'; c.title = v; } return c; }
function renderData() {
  const g = $('grid'); g.textContent = '';
  const t = document.createElement('table'); const h = t.createTHead().insertRow();
  const all = document.createElement('th'); const cb = document.createElement('input'); cb.type = 'checkbox'; cb.onchange = () => { st.picked = cb.checked ? new Set(st.rows.map((r) => r[0])) : new Set(); renderData(); }; cb.checked = st.rows.length > 0 && st.picked.size === st.rows.length; all.appendChild(cb); all.style.width = '34px'; h.appendChild(all);
  st.header.slice(1).forEach((c) => { const th = document.createElement('th'); th.className = 'sort'; const s = st.sort && st.sort.col === c ? (st.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''; const meta = st.cols.find((x) => x.name === c); th.innerHTML = ''; th.textContent = c + s; if (meta) { const sp = document.createElement('span'); sp.className = 'muted'; sp.style.cssText = 'font-weight:400;margin-left:6px'; sp.textContent = meta.type + (meta.pk ? ' · pk' : ''); th.appendChild(sp); } th.onclick = () => { st.sort = !st.sort || st.sort.col !== c ? { col: c, dir: 'asc' } : st.sort.dir === 'asc' ? { col: c, dir: 'desc' } : null; st.page = 0; load(); }; h.appendChild(th); });
  const body = t.createTBody();
  st.rows.forEach((r) => {
    const tr = body.insertRow(); const c0 = document.createElement('td'); const k = document.createElement('input'); k.type = 'checkbox'; k.checked = st.picked.has(r[0]); k.onchange = () => { k.checked ? st.picked.add(r[0]) : st.picked.delete(r[0]); st.confirm = false; $('bDel').hidden = st.picked.size === 0; $('bDel').textContent = 'Delete ' + st.picked.size; }; c0.appendChild(k); tr.appendChild(c0);
    r.slice(1).forEach((v, i) => {
      const cell = td(v); const col = st.header[i + 1];
      cell.ondblclick = () => startEdit(cell, r[0], col, v);
      tr.appendChild(cell);
    });
  });
  g.appendChild(t);
  if (!st.rows.length) { const p = document.createElement('p'); p.className = 'msg muted'; p.textContent = st.filters.length ? 'No rows match the filter.' : 'This table has no rows.'; g.appendChild(p); }
  $('pageNo').textContent = 'Page ' + (st.page + 1) + ' · ' + st.rows.length + ' row' + (st.rows.length === 1 ? '' : 's');
  $('prev').disabled = st.page === 0; $('next').disabled = !st.more;
  $('bDel').hidden = st.picked.size === 0; $('bDel').textContent = 'Delete ' + st.picked.size;
  $('bFilter').textContent = st.filters.length ? 'Filter (' + st.filters.length + ')' : 'Filter';
}
function startEdit(cell, ctid, col, value) {
  cell.className = 'edit'; cell.textContent = '';
  const i = document.createElement('input'); i.value = value === null ? '' : value; const done = (save, asNull) => { if (save) send('update', { ctid, col, value: asNull ? null : i.value }); else renderData(); };
  i.onkeydown = (e) => { if (e.key === 'Enter') done(true, false); else if (e.key === 'Escape') done(false); else if ((e.metaKey || e.ctrlKey) && e.key === 'Backspace') done(true, true); };
  i.onblur = () => setTimeout(() => { if (document.body.contains(i)) done(false); }, 120);
  cell.appendChild(i); i.focus(); i.select();
}
function renderStruct() {
  const g = $('grid'); g.textContent = '';
  const t = document.createElement('table'); const h = t.createTHead().insertRow();
  ['Column', 'Type', 'Nullable', 'Default', 'Key'].forEach((x) => { const th = document.createElement('th'); th.textContent = x; h.appendChild(th); });
  const b = t.createTBody(); st.cols.forEach((c) => { const r = b.insertRow(); [c.name, c.type, c.nullable ? 'yes' : 'no', c.default === null ? '' : c.default, c.pk ? 'primary key' : ''].forEach((v) => { const d = document.createElement('td'); d.textContent = v; r.appendChild(d); }); });
  g.appendChild(t);
  if (st.indexes.length) { const c = document.createElement('div'); c.className = 'card'; c.style.padding = '12px 14px'; const hd = document.createElement('strong'); hd.textContent = 'Indexes'; c.appendChild(hd); st.indexes.forEach((x) => { const p = document.createElement('div'); p.style.marginTop = '8px'; const n = document.createElement('div'); n.textContent = x.name; const d = document.createElement('div'); d.className = 'mono muted'; d.textContent = x.def; p.append(n, d); c.appendChild(p); }); g.appendChild(c); }
}
function view() { $('tData').setAttribute('aria-pressed', st.view === 'data'); $('tStruct').setAttribute('aria-pressed', st.view === 'struct'); $('foot').hidden = st.view !== 'data'; ['bFilter', 'bAdd'].forEach((x) => $(x).hidden = st.view !== 'data'); st.view === 'data' ? renderData() : renderStruct(); }
$('tData').onclick = () => { st.view = 'data'; view(); }; $('tStruct').onclick = () => { st.view = 'struct'; view(); };
$('bRefresh').onclick = load; $('prev').onclick = () => { st.page--; load(); }; $('next').onclick = () => { st.page++; load(); };
$('bDel').onclick = () => { if (!st.confirm) { st.confirm = true; $('bDel').textContent = 'Confirm delete ' + st.picked.size; return; } send('delete', { ctids: [...st.picked] }); st.confirm = false; };
$('bAdd').onclick = () => {
  const m = $('modal'); m.hidden = false; m.textContent = ''; const box = document.createElement('div'); const h = document.createElement('strong'); h.textContent = 'Add row'; box.appendChild(h);
  const hint = document.createElement('div'); hint.className = 'muted'; hint.textContent = 'Leave a field empty to use its default.'; box.appendChild(hint);
  const inputs = st.cols.map((c) => { const l = document.createElement('label'); l.textContent = c.name + ' · ' + c.type + (c.nullable ? '' : ' · required'); const i = document.createElement('input'); i.placeholder = c.default ? 'default: ' + c.default : ''; l.appendChild(i); box.appendChild(l); return [c.name, i]; });
  const row = document.createElement('div'); row.className = 'bar'; row.style.border = '0'; row.style.padding = '8px 0 0'; const s = document.createElement('span'); s.className = 'grow'; const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.onclick = () => { m.hidden = true; }; const save = document.createElement('button'); save.className = 'primary'; save.textContent = 'Add row'; save.onclick = () => { send('insert', { values: inputs.filter(([, i]) => i.value !== '').map(([n, i]) => [n, i.value]) }); m.hidden = true; }; row.append(s, cancel, save); box.appendChild(row); m.appendChild(box); if (inputs[0]) inputs[0][1].focus();
};
$('bFilter').onclick = () => { const p = $('pFilter'); if (!p.hidden) { p.hidden = true; return; } p.hidden = false; p.textContent = ''; const rows = st.filters.length ? st.filters.map((f) => Object.assign({}, f)) : [{ col: st.cols[0] ? st.cols[0].name : '', op: '=', value: '' }];
  const ops = [['=', 'equals'], ['!=', 'is not'], ['contains', 'contains'], ['>', 'greater than'], ['<', 'less than'], ['null', 'is empty (NULL)'], ['notnull', 'is not empty']];
  const draw = () => { p.textContent = ''; rows.forEach((f, idx) => { const r = document.createElement('div'); r.style.cssText = 'display:flex;gap:6px'; const c = document.createElement('select'); st.cols.forEach((x) => { const o = document.createElement('option'); o.textContent = x.name; o.selected = x.name === f.col; c.appendChild(o); }); c.onchange = () => { f.col = c.value; }; const o = document.createElement('select'); ops.forEach(([v, l]) => { const e = document.createElement('option'); e.value = v; e.textContent = l; e.selected = v === f.op; o.appendChild(e); }); o.onchange = () => { f.op = o.value; }; const v = document.createElement('input'); v.value = f.value; v.placeholder = 'value'; v.style.flex = '1'; v.oninput = () => { f.value = v.value; }; const x = document.createElement('button'); x.className = 'ghost'; x.textContent = '✕'; x.onclick = () => { rows.splice(idx, 1); draw(); }; r.append(c, o, v, x); p.appendChild(r); });
    const a = document.createElement('div'); a.className = 'bar'; a.style.cssText = 'border:0;padding:4px 0 0'; const add = document.createElement('button'); add.className = 'ghost'; add.textContent = '+ Add filter'; add.onclick = () => { rows.push({ col: st.cols[0].name, op: '=', value: '' }); draw(); }; const sp = document.createElement('span'); sp.className = 'grow'; const clear = document.createElement('button'); clear.textContent = 'Clear'; clear.onclick = () => { st.filters = []; st.page = 0; p.hidden = true; load(); }; const ap = document.createElement('button'); ap.className = 'primary'; ap.textContent = 'Apply'; ap.onclick = () => { st.filters = rows.filter((x) => x.col); st.page = 0; p.hidden = true; load(); }; a.append(add, sp, clear, ap); p.appendChild(a); }; draw(); };
window.addEventListener('message', (e) => { const m = e.data; if (m.type === 'init') { $('name').textContent = m.title; st.cols = m.cols; st.indexes = m.indexes; if (m.count) $('count').textContent = m.count; }
  if (m.type === 'data') { st.header = m.header; st.rows = m.rows; st.more = m.more; st.picked = new Set(); st.confirm = false; $('busy').textContent = ''; setErr(m.error); view(); }
  if (m.type === 'error') { setErr(m.error); $('busy').textContent = ''; renderData(); } });
send('ready');`;

class TableEditor {
	constructor(project, database, schema, table, onClose) {
		this.project = project;
		this.database = database;
		this.schema = schema;
		this.table = table;
		this.panel = vscode.window.createWebviewPanel('vantrex.table', table, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
		this.panel.iconPath = new vscode.ThemeIcon('table');
		this.panel.webview.html = page(table, BODY, SCRIPT);
		this.state = { page: 0, sort: null, filters: [] };
		this.panel.onDidDispose(onClose);
		this.panel.webview.onDidReceiveMessage((m) => void this.handle(m));
	}

	reveal() { this.panel.reveal(undefined, false); }

	_where(filters) {
		const parts = (filters || []).filter((f) => f.col).map((f) => {
			const c = db.qi(f.col);
			if (f.op === 'null') { return `${c} is null`; }
			if (f.op === 'notnull') { return `${c} is not null`; }
			if (f.op === 'contains') { return `${c}::text ilike ${db.ql('%' + String(f.value).replace(/[\\%_]/g, '\\$&') + '%')}`; }
			return `${c} ${OPS[f.op] || '='} ${db.ql(f.value)}`;
		});
		return parts.length ? ` where ${parts.join(' and ')}` : '';
	}

	async _structure() {
		const { project, database, schema, table } = this;
		const cols = await db.rows(project, database, `select c.column_name, c.data_type, c.is_nullable, c.column_default, coalesce((select true from information_schema.key_column_usage k join information_schema.table_constraints t on t.constraint_name = k.constraint_name and t.table_schema = k.table_schema where t.constraint_type = 'PRIMARY KEY' and k.table_schema = c.table_schema and k.table_name = c.table_name and k.column_name = c.column_name limit 1), false)::text from information_schema.columns c where c.table_schema = ${db.ql(schema)} and c.table_name = ${db.ql(table)} order by c.ordinal_position`);
		const idx = await db.rows(project, database, `select indexname, indexdef from pg_indexes where schemaname = ${db.ql(schema)} and tablename = ${db.ql(table)} order by 1`);
		return {
			cols: cols.map((r) => ({ name: r[0], type: r[1], nullable: r[2] === 'YES', default: r[3], pk: r[4] === 'true' })),
			indexes: idx.map((r) => ({ name: r[0], def: r[1] })),
		};
	}

	async _data() {
		const { page: p, sort, filters } = this.state;
		const order = sort ? ` order by ${db.qi(sort.col)} ${sort.dir === 'desc' ? 'desc' : 'asc'}` : '';
		const r = await db.query(this.project, this.database, `select ctid::text as "__ctid", * from ${db.qt(this.schema, this.table)}${this._where(filters)}${order} limit ${PAGE + 1} offset ${p * PAGE}`);
		if (!r.ok || r.error) { return { type: 'data', header: [], rows: [], more: false, error: r.error }; }
		const res = r.results[0] || { columns: [], rows: [] };
		return { type: 'data', header: res.columns, rows: res.rows.slice(0, PAGE), more: res.rows.length > PAGE };
	}

	async _post(m) { try { await this.panel.webview.postMessage(m); } catch { /* closed */ } }

	async _mutate(sql) {
		const r = await db.query(this.project, this.database, sql);
		if (!r.ok || r.error) { await this._post({ type: 'error', error: r.error }); return false; }
		return true;
	}

	async handle(m) {
		try {
			if (m.type === 'ready') {
				const s = await this._structure();
				const est = await db.rows(this.project, this.database, `select count(*)::text from ${db.qt(this.schema, this.table)}`).catch(() => null);
				await this._post({ type: 'init', title: `${this.schema}.${this.table}`, cols: s.cols, indexes: s.indexes, count: est ? ` ${Number(est[0][0]).toLocaleString()} rows` : '' });
				await this._post(await this._data());
			} else if (m.type === 'load') {
				this.state = { page: m.page || 0, sort: m.sort, filters: m.filters || [] };
				await this._post(await this._data());
			} else if (m.type === 'update') {
				if (await this._mutate(`update ${db.qt(this.schema, this.table)} set ${db.qi(m.col)} = ${m.value === null ? 'null' : db.ql(m.value)} where ctid = ${db.ql(m.ctid)}::tid`)) { await this._post(await this._data()); }
				else { await this._post(await this._data()); }
			} else if (m.type === 'insert') {
				const vals = m.values || [];
				const sql = vals.length ? `insert into ${db.qt(this.schema, this.table)} (${vals.map(([n]) => db.qi(n)).join(', ')}) values (${vals.map(([, v]) => db.ql(v)).join(', ')})` : `insert into ${db.qt(this.schema, this.table)} default values`;
				if (await this._mutate(sql)) { await this._post(await this._data()); }
			} else if (m.type === 'delete') {
				const ids = (m.ctids || []).map(db.ql).join(',');
				if (ids && await this._mutate(`delete from ${db.qt(this.schema, this.table)} where ctid = any(array[${ids}]::tid[])`)) { await this._post(await this._data()); }
			}
		} catch (e) {
			await this._post({ type: 'error', error: e.message || String(e) });
		}
	}
}

module.exports = { TableEditor };
