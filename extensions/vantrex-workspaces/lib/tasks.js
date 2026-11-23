// Tasks: the runner starts only a fixed set (install, add, remove, dev, build, test, lint, typecheck, script), never a shell.
// Their output arrives as server-sent events that carry a byte offset, so a dropped connection resumes where it stopped.

'use strict';

const { call, stream, ws } = require('./api');

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Output with colour and cursor sequences removed, for the Output panel (the terminal keeps them). */
function cleanOutput(s) {
	return s.replace(ANSI, '').replace(/\r(?!\n)/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

const start = async (id, req) => (await call('POST', `${ws(id)}/tasks`, { body: req })).data;
const list = async (id) => (await call('GET', `${ws(id)}/tasks`)).data || [];
const stop = (id, task) => call('DELETE', `${ws(id)}/tasks/${encodeURIComponent(task)}`);

/**
 * Follows a task's output. `onText` gets each chunk; the promise resolves with `{ ok, error }` when the task ends and rejects if the
 * connection cannot be kept. Reconnects from the last offset a few times when the stream drops.
 */
async function follow(id, task, onText, signal) {
	let from = 0;
	let failures = 0;
	while (!signal.aborted) {
		try {
			const res = await stream(`${ws(id)}/tasks/${encodeURIComponent(task)}/output`, { from }, signal);
			const reader = res.body.getReader();
			const dec = new TextDecoder();
			let buf = '';
			for (; ;) {
				const { done, value } = await reader.read();
				if (done) { break; }
				buf += dec.decode(value, { stream: true });
				let i;
				while ((i = buf.indexOf('\n\n')) >= 0) {
					const block = buf.slice(0, i);
					buf = buf.slice(i + 2);
					let event = 'message';
					let data = '';
					for (const line of block.split('\n')) {
						if (line.startsWith('event:')) { event = line.slice(6).trim(); }
						else if (line.startsWith('data:')) { data += line.slice(5).trim(); }
					}
					if (!data) { continue; }
					let json;
					try { json = JSON.parse(data); } catch { continue; }
					if (event === 'end') { return { ok: !!json.ok, error: json.error }; }
					if (typeof json.t === 'string') { onText(json.t); from = json.o; failures = 0; }
				}
			}
		} catch (e) {
			if (signal.aborted) { break; }
			if (e && e.status === 404) { return { ok: false, error: 'The task is gone.' }; }
			if (++failures > 5) { throw e; }
		}
		await new Promise((r) => setTimeout(r, 1000 * failures));
	}
	return { ok: false, error: 'stopped' };
}

module.exports = { cleanOutput, start, list, stop, follow };
