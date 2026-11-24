// What the database webviews share: the page frame and the glass styling (the same Apple-style layer as the rest of the IDE).

'use strict';

const crypto = require('crypto');

const CSS = `
:root{color-scheme:dark;--edge:rgba(255,255,255,.13);--fill:rgba(255,255,255,.05);--fill-hi:rgba(255,255,255,.1);--accent:#fafafa;--muted:#8c8c8c;--spring:cubic-bezier(.34,1.4,.64,1);--smooth:cubic-bezier(.32,.72,0,1)}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{height:100%}
body{margin:0;background:#000;color:#f2f2f2;font:12.5px/1.45 -apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',system-ui,sans-serif;letter-spacing:-.011em;display:flex;flex-direction:column}
button,select,input{font:inherit;color:inherit}
button{background:var(--fill);border:1px solid var(--edge);border-radius:999px;height:26px;padding:0 12px;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.14);transition:background .3s var(--smooth),scale .5s var(--spring)}
button:hover:not(:disabled){background:var(--fill-hi);scale:1.03}button:active:not(:disabled){scale:.96}button:disabled{opacity:.4;cursor:default}
button.primary{background:var(--accent);color:#0a0c0d;border-color:transparent;font-weight:600;box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 6px 18px rgba(255,255,255,.25)}
button.danger{color:#ff6b6b}
button.ghost{background:transparent;border-color:transparent;box-shadow:none}
input,select{background:rgba(0,0,0,.5);border:1px solid var(--edge);border-radius:10px;height:26px;padding:0 9px;outline:none}
input:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(255,255,255,.2)}
select option{background:#161618}
.bar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--edge);flex-wrap:wrap}
.grow{flex:1}.muted{color:var(--muted)}.mono{font-family:'JetBrains Mono',ui-monospace,Menlo,monospace}
.seg{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--edge);border-radius:999px;background:rgba(0,0,0,.4)}
.seg button{border:0;background:transparent;box-shadow:none;height:22px}.seg button[aria-pressed=true]{background:var(--fill-hi);box-shadow:inset 0 1px 0 rgba(255,255,255,.16)}
.scroll{flex:1;overflow:auto;min-height:0}
table{border-collapse:separate;border-spacing:0;font-size:12px;min-width:100%}
th,td{padding:5px 12px;text-align:left;white-space:nowrap;max-width:420px;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid rgba(255,255,255,.06)}
th{position:sticky;top:0;background:#0b0b0c;font-weight:600;color:#bdbdbd;border-bottom:1px solid var(--edge);user-select:none;z-index:2}
th.sort{cursor:pointer}th.sort:hover{color:#fff}
td{font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;font-size:11.5px}
tr:hover td{background:rgba(255,255,255,.035)}
td.null{color:#5a5a5a;font-style:italic}
td.num{text-align:right}
td.edit{padding:2px 6px}td.edit input{width:100%;min-width:140px;height:24px;border-radius:7px}
.tabs{display:flex;gap:4px;padding:6px 12px;border-bottom:1px solid var(--edge);overflow-x:auto}
.tabs button{border-color:transparent;background:transparent;box-shadow:none}.tabs button[aria-selected=true]{background:var(--fill-hi);border-color:var(--edge)}
.msg{padding:14px 16px}
.err{margin:10px 12px;padding:9px 12px;border:1px solid rgba(255,255,255,.5);background:rgba(255,255,255,.1);border-radius:12px;white-space:pre-wrap}
.ok{color:#46a758}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent);margin-right:6px;box-shadow:0 0 8px rgba(255,255,255,.7)}
.card{border:1px solid var(--edge);border-radius:16px;background:var(--fill);box-shadow:inset 0 1px 0 rgba(255,255,255,.12);margin:12px}
.pop{position:absolute;z-index:20;margin-top:6px;padding:12px;background:rgba(18,18,20,.92);border:1px solid var(--edge);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.6);display:grid;gap:8px;min-width:300px;-webkit-backdrop-filter:blur(26px);backdrop-filter:blur(26px)}
.rel{position:relative}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.55);display:grid;place-items:center;z-index:30;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.modal>div{width:min(520px,92vw);max-height:86vh;overflow:auto;padding:18px;background:rgba(18,18,20,.94);border:1px solid var(--edge);border-radius:20px;display:grid;gap:10px}
.modal label{display:grid;gap:3px;color:var(--muted)}.modal input{width:100%}
@media (prefers-reduced-motion:reduce){*{transition-duration:.01ms!important}}
`;

/** A webview page: the shared styles, one nonce for the styles and script, a CSP that allows nothing else. */
function page(title, body, script) {
	const nonce = crypto.randomBytes(16).toString('base64');
	return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">${CSS}</style></head><body>${body}<script nonce="${nonce}">${script}</script></body></html>`;
}

module.exports = { page };
