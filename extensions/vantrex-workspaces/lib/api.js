// The Vantrex API client for workspaces: bearer calls with the API key that Vantrex Account keeps for the signed-in person.

'use strict';

const vscode = require('vscode');

class ApiError extends Error {
	constructor(status, message, code) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

const apiBase = () => String(vscode.workspace.getConfiguration('vantrex.account').get('apiUrl') || 'https://api.vantrex.cloud').replace(/\/+$/, '');
const dashboardBase = () => String(vscode.workspace.getConfiguration('vantrex.account').get('authUrl') || 'https://app.vantrex.cloud').replace(/\/+$/, '');

/** The API key of the signed-in account; with `interactive` it starts the sign-in when there is none. */
async function token(interactive) {
	const s = await vscode.authentication.getSession('vantrex', ['sync'], interactive ? { createIfNone: true } : { silent: true });
	if (!s) { throw new ApiError(401, 'Sign in to Vantrex first.'); }
	return s.accessToken;
}

/**
 * Calls the API. `body` is JSON unless `raw` (a Buffer sent as it is). Resolves to `{ status, headers, data }`, where `data` is the parsed
 * JSON (or null), and throws ApiError for any status of 400 and up.
 */
async function call(method, path, { body, raw, query, signal } = {}) {
	const url = new URL(apiBase() + '/v1/' + path.replace(/^\/+/, ''));
	for (const [k, v] of Object.entries(query || {})) { url.searchParams.set(k, String(v)); }
	const headers = { authorization: `Bearer ${await token(false)}` };
	let payload;
	if (raw !== undefined) { headers['content-type'] = 'application/octet-stream'; payload = raw; }
	else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
	const res = await fetch(url, { method, headers, body: payload, signal: signal || AbortSignal.timeout(120000) });
	const buf = Buffer.from(await res.arrayBuffer());
	let data = null;
	if ((res.headers.get('content-type') || '').includes('json') && buf.length) {
		try { data = JSON.parse(buf.toString('utf8')); } catch { /* not JSON after all */ }
	}
	if (res.status >= 400) {
		const msg = (data && (data.error || data.message)) || `The API answered ${res.status}.`;
		throw new ApiError(res.status, String(msg), data && data.code);
	}
	return { status: res.status, headers: res.headers, data, buf };
}

/** Opens a streaming response (task output): the caller reads `res.body`. */
async function stream(path, query, signal) {
	const url = new URL(apiBase() + '/v1/' + path.replace(/^\/+/, ''));
	for (const [k, v] of Object.entries(query || {})) { url.searchParams.set(k, String(v)); }
	const res = await fetch(url, { headers: { authorization: `Bearer ${await token(false)}`, accept: 'text/event-stream' }, signal });
	if (res.status >= 400) { throw new ApiError(res.status, `The API answered ${res.status}.`); }
	return res;
}

const ws = (id) => `workspaces/${encodeURIComponent(id)}`;

module.exports = { ApiError, apiBase, dashboardBase, token, call, stream, ws };
