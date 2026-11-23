// The preview browser inside the IDE.
//
// The workspace's dev server is private: it is reachable only through the API, with the owner's key. So the IDE runs a tiny
// proxy on 127.0.0.1 that forwards to {API}/v1/workspaces/{id}/preview/... with that key (including WebSocket upgrades, so hot reload
// works), and the preview panel shows the proxy's address. The proxy answers only requests addressed to 127.0.0.1 or localhost, so a
// web page cannot reach it through a rebound hostname.

'use strict';

const vscode = require('vscode');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { apiBase, token, ws } = require('./api');

/** Loaded into every HTML page the preview serves: reports the address and title to the panel and obeys its back/forward/reload. */
const BRIDGE = `<script>(function(){
if(window.__vtxBridge)return;window.__vtxBridge=1;
function send(){try{parent.postMessage({vtx:'page',url:location.pathname+location.search+location.hash,title:document.title},'*')}catch(e){}}
['pushState','replaceState'].forEach(function(k){var o=history[k];history[k]=function(){var r=o.apply(this,arguments);setTimeout(send);return r}});
addEventListener('popstate',send);addEventListener('hashchange',send);addEventListener('load',send);
new MutationObserver(send).observe(document.documentElement,{childList:true,subtree:true,characterData:true});
addEventListener('message',function(e){var m=e.data||{};if(m.vtx!=='cmd')return;
if(m.cmd==='back')history.back();else if(m.cmd==='forward')history.forward();else if(m.cmd==='reload')location.reload();else if(m.cmd==='go'&&typeof m.url==='string'&&m.url[0]==='/')location.href=m.url;});
send();})();</script>`;

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'host', 'authorization', 'cookie', 'content-length']);

class PreviewProxy {
	constructor(workspaceId) {
		this.id = workspaceId;
		this.server = http.createServer((req, res) => void this._handle(req, res));
		this.server.on('upgrade', (req, socket, head) => void this._upgrade(req, socket, head));
		this.port = 0;
	}

	async listen() {
		await new Promise((resolve, reject) => {
			this.server.once('error', reject);
			this.server.listen(0, '127.0.0.1', resolve);
		});
		this.port = this.server.address().port;
		return this.origin;
	}

	get origin() { return `http://127.0.0.1:${this.port}`; }

	dispose() { this.server.close(); this.server.closeAllConnections?.(); }

	_hostOk(req) {
		const h = String(req.headers.host || '');
		return h === `127.0.0.1:${this.port}` || h === `localhost:${this.port}`;
	}

	_target(req) {
		const base = new URL(apiBase());
		const lib = base.protocol === 'https:' ? https : http;
		const prefix = `/v1/${ws(this.id)}/preview`;
		const path = prefix + (req.url.startsWith('/') ? req.url : '/' + req.url);
		return { lib, base, path: base.pathname.replace(/\/$/, '') + path };
	}

	async _headers(req) {
		const headers = {};
		for (const [k, v] of Object.entries(req.headers)) { if (!HOP.has(k)) { headers[k] = v; } }
		headers.authorization = `Bearer ${await token(false)}`;
		headers['accept-encoding'] = 'identity'; // HTML is rewritten below, so it must arrive uncompressed
		return headers;
	}

	async _handle(req, res) {
		if (!this._hostOk(req)) { res.writeHead(421).end('Misdirected request'); return; }
		let t, headers;
		try { t = this._target(req); headers = await this._headers(req); } catch (e) { res.writeHead(401).end('Sign in to Vantrex first.'); return; }
		const up = t.lib.request({ protocol: t.base.protocol, hostname: t.base.hostname, port: t.base.port || undefined, method: req.method, path: t.path, headers }, (ures) => {
			const out = {};
			for (const [k, v] of Object.entries(ures.headers)) { if (!HOP.has(k) && k !== 'content-security-policy' && k !== 'x-frame-options') { out[k] = v; } }
			if (typeof out.location === 'string') { out.location = out.location.replace(/^https?:\/\/[^/]+/, ''); }
			const html = /text\/html/i.test(String(ures.headers['content-type'] || '')) && ures.statusCode === 200;
			if (!html) { res.writeHead(ures.statusCode || 502, out); ures.pipe(res); return; }
			const chunks = [];
			ures.on('data', (c) => chunks.push(c));
			ures.on('end', () => {
				let body = Buffer.concat(chunks).toString('utf8');
				body = /<head[^>]*>/i.test(body) ? body.replace(/<head[^>]*>/i, (m) => m + BRIDGE) : BRIDGE + body;
				const buf = Buffer.from(body, 'utf8');
				out['content-length'] = String(buf.length);
				res.writeHead(200, out).end(buf);
			});
		});
		up.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); } res.end('The dev server is not reachable.'); });
		req.pipe(up);
	}

	async _upgrade(req, socket, head) {
		if (!this._hostOk(req)) { socket.destroy(); return; }
		let t, headers;
		try { t = this._target(req); headers = await this._headers(req); } catch { socket.destroy(); return; }
		headers.connection = 'Upgrade';
		headers.upgrade = req.headers.upgrade;
		delete headers['accept-encoding'];
		for (const k of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) { if (req.headers[k]) { headers[k] = req.headers[k]; } }
		delete headers.origin; // the browser's own origin means nothing to the dev server
		const up = t.lib.request({ protocol: t.base.protocol, hostname: t.base.hostname, port: t.base.port || undefined, method: 'GET', path: t.path, headers });
		up.on('upgrade', (ures, usock, uhead) => {
			let text = `HTTP/1.1 101 Switching Protocols\r\n`;
			for (const [k, v] of Object.entries(ures.headers)) { text += `${k}: ${v}\r\n`; }
			socket.write(text + '\r\n');
			if (uhead && uhead.length) { socket.write(uhead); }
			if (head && head.length) { usock.write(head); }
			usock.pipe(socket).pipe(usock);
			usock.on('error', () => socket.destroy());
			socket.on('error', () => usock.destroy());
		});
		up.on('response', (ures) => { socket.end(`HTTP/1.1 ${ures.statusCode} ${ures.statusMessage}\r\n\r\n`); });
		up.on('error', () => socket.destroy());
		up.end();
	}
}

const WIDTHS = [['Fit', 0], ['Mobile 390', 390], ['Tablet 768', 768], ['Laptop 1280', 1280]];

/** The preview panel: an address bar, history, reload, device widths and "open in browser" around an iframe of the proxy. */
class PreviewPanel {
	constructor(proxy, title) {
		this.proxy = proxy;
		this.panel = vscode.window.createWebviewPanel('vantrex.preview', title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
		this.disposed = false;
		this.panel.onDidDispose(() => { this.disposed = true; });
		this.panel.webview.onDidReceiveMessage((m) => {
			if (m && m.type === 'external') { void vscode.env.openExternal(vscode.Uri.parse(proxy.origin + (typeof m.path === 'string' && m.path.startsWith('/') ? m.path : '/'))); }
			if (m && m.type === 'probe') { void this.waitForServer(); }
		});
		this.panel.webview.html = this._html();
		void this.waitForServer();
	}

	reveal() { this.panel.reveal(vscode.ViewColumn.Beside, true); }
	onDispose(fn) { this.panel.onDidDispose(fn); }

	/** The dev server takes a while to come up after the workspace starts: ask the proxy until it answers with something other than a gateway error. */
	async waitForServer() {
		this.panel.webview.postMessage({ type: 'status', text: 'Waiting for the dev server...' });
		const deadline = Date.now() + 180000;
		while (!this.disposed && Date.now() < deadline) {
			const status = await new Promise((resolve) => {
				const r = http.get({ host: '127.0.0.1', port: this.proxy.port, path: '/', headers: { host: `127.0.0.1:${this.proxy.port}` }, timeout: 8000 }, (res) => { res.resume(); resolve(res.statusCode || 0); });
				r.on('error', () => resolve(0));
				r.on('timeout', () => { r.destroy(); resolve(0); });
			});
			if (status && status < 500 && status !== 401) { this.panel.webview.postMessage({ type: 'load' }); return; }
			if (status === 401) { this.panel.webview.postMessage({ type: 'status', text: 'Sign in to Vantrex to see the preview.' }); return; }
			await new Promise((r) => setTimeout(r, 2000));
		}
		if (!this.disposed) { this.panel.webview.postMessage({ type: 'status', text: 'The dev server did not answer. Start it from the workspace menu, then press reload.', retry: true }); }
	}

	_html() {
		const nonce = crypto.randomBytes(16).toString('base64');
		const origin = this.proxy.origin;
		const widths = WIDTHS.map(([l, w]) => `<option value="${w}">${l}</option>`).join('');
		return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
:root{color-scheme:dark;--edge:rgba(255,255,255,.13);--fill:rgba(255,255,255,.07);--fill-hi:rgba(255,255,255,.13);--spring:cubic-bezier(.34,1.4,.64,1);--smooth:cubic-bezier(.32,.72,0,1)}
*{box-sizing:border-box}
body{margin:0;height:100vh;display:flex;flex-direction:column;gap:8px;padding:8px;background:#000;color:#f2f2f2;font:12px/1.4 -apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',system-ui,sans-serif;letter-spacing:-.011em}
.bar{display:flex;gap:6px;align-items:center;padding:5px 6px;border:1px solid var(--edge);border-radius:999px;background:var(--fill);box-shadow:0 1px 0 rgba(255,255,255,.2) inset,0 -1px 0 rgba(0,0,0,.35) inset,0 10px 30px rgba(0,0,0,.45);-webkit-backdrop-filter:blur(26px) saturate(190%) brightness(1.08);backdrop-filter:blur(26px) saturate(190%) brightness(1.08)}
button,select{background:transparent;color:#f2f2f2;border:0;border-radius:999px;height:26px;min-width:26px;padding:0 9px;font:inherit;cursor:pointer;transition:background-color .3s var(--smooth),scale .5s var(--spring)}
button:hover:not(:disabled),select:hover{background:var(--fill-hi);scale:1.06}button:active:not(:disabled){scale:.92}
select{padding:0 6px;appearance:none;-webkit-appearance:none}select option{background:#161618;color:#f2f2f2}
input{flex:1;min-width:0;height:26px;background:rgba(0,0,0,.4);color:#f2f2f2;border:1px solid var(--edge);border-radius:999px;padding:0 12px;font:12px/1 ui-monospace,'JetBrains Mono',Menlo,monospace}
input:focus{outline:none;border-color:rgba(255,90,63,.8);box-shadow:0 0 0 3px rgba(255,90,63,.18)}
.stage{flex:1;position:relative;overflow:auto;display:flex;justify-content:center;border:1px solid var(--edge);border-radius:16px;background:#050505}
iframe{border:0;background:#fff;height:100%;width:100%}
.msg{position:absolute;inset:0;display:flex;flex-direction:column;gap:14px;align-items:center;justify-content:center;color:#9a9a9a;background:#000;font-size:13px}
.msg::before{content:'';width:8px;height:8px;border-radius:50%;background:#ff5a3f;box-shadow:0 0 14px rgba(255,90,63,.8);animation:ping 1.6s var(--smooth) infinite}
@keyframes ping{0%{scale:.7;opacity:.6}50%{scale:1.3;opacity:1}100%{scale:.7;opacity:.6}}
.msg.hide{display:none}
#retry{border:1px solid var(--edge);background:var(--fill);padding:0 16px;height:30px}
@media (prefers-reduced-motion:reduce){*{transition-duration:.01ms!important;animation:none!important}}
</style></head><body>
<div class="bar">
<button id="back" title="Back">&larr;</button><button id="fwd" title="Forward">&rarr;</button><button id="reload" title="Reload">&#8635;</button>
<input id="addr" value="/" spellcheck="false" autocomplete="off"><select id="w" title="Width">${widths}</select><button id="ext" title="Open in your browser">&#8599;</button>
</div>
<div class="stage" id="stage"><iframe id="f" title="Preview" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-pointer-lock"></iframe>
<div class="msg" id="msg"><span id="txt">Starting...</span><button id="retry" hidden>Try again</button></div></div>
<script nonce="${nonce}">
const vs=acquireVsCodeApi(),f=document.getElementById('f'),addr=document.getElementById('addr'),msg=document.getElementById('msg'),txt=document.getElementById('txt'),retry=document.getElementById('retry');
const ORIGIN=${JSON.stringify(origin)};let cur='/';
const q=(id)=>document.getElementById(id);
function show(p){cur=p;addr.value=p}
function cmd(c){f.contentWindow&&f.contentWindow.postMessage({vtx:'cmd',cmd:c},ORIGIN)}
function go(p){if(!p.startsWith('/'))p='/'+p;f.src=ORIGIN+p;show(p)}
window.addEventListener('message',(e)=>{
 const m=e.data||{};
 if(e.source===f.contentWindow&&m.vtx==='page'){show(m.url);return}
 if(m.type==='load'){msg.classList.add('hide');f.src=ORIGIN+cur}
 if(m.type==='status'){msg.classList.remove('hide');txt.textContent=m.text;retry.hidden=!m.retry}
});
q('back').onclick=()=>{cmd('back')};q('fwd').onclick=()=>{cmd('forward')};q('reload').onclick=()=>{cmd('reload');if(!f.contentWindow||!f.src)vs.postMessage({type:'probe'})};
addr.addEventListener('keydown',(e)=>{if(e.key==='Enter')go(addr.value.trim()||'/')});
q('ext').onclick=()=>vs.postMessage({type:'external',path:cur});retry.onclick=()=>vs.postMessage({type:'probe'});
q('w').onchange=(e)=>{const w=Number(e.target.value);f.style.width=w?w+'px':'100%'};
</script></body></html>`;
	}
}

module.exports = { PreviewProxy, PreviewPanel };
