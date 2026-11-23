// The Vantrex Databases API (internal/api/databases.go), as the IDE uses it. Statements always run as the project's owner role, the
// way the dashboard's database editor does.

'use strict';

const { call } = require('../api');

const ROLE = 'owner';

/** A quoted identifier, and a quoted string literal (standard_conforming_strings is on). */
const qi = (s) => `"${String(s).replace(/"/g, '""')}"`;
const ql = (s) => `'${String(s).replace(/'/g, "''")}'`;
const qt = (schema, table) => `${qi(schema)}.${qi(table)}`;

const projects = async () => ((await call('GET', 'db/projects')).data || {}).projects || [];
const detail = async (id) => (await call('GET', `db/projects/${encodeURIComponent(id)}`)).data;
const wake = (id) => call('POST', `db/projects/${encodeURIComponent(id)}/wake`);
const history = async (id) => ((await call('GET', `db/projects/${encodeURIComponent(id)}/history`, { query: { limit: 100 } })).data || {}).history || [];
const connection = async (id, role, database) => (await call('GET', `db/projects/${encodeURIComponent(id)}/roles/${encodeURIComponent(role)}/connection`, { query: { database } })).data;

/**
 * Runs SQL. Resolves to `{ ok, results, error, ms }`: `results` has one entry per statement ({ columns, rows, command, affected }); `error` is
 * the database's own message when a later statement failed after earlier ones ran.
 */
async function query(id, database, sql) {
	const t0 = Date.now();
	try {
		const r = await call('POST', `db/projects/${encodeURIComponent(id)}/query`, { body: { database, role: ROLE, sql }, signal: AbortSignal.timeout(120000) });
		const d = r.data || {};
		return { ok: true, results: d.results || [], error: d.error, ms: d.ms ?? Date.now() - t0 };
	} catch (e) {
		return { ok: false, results: [], error: e.message || String(e), ms: Date.now() - t0 };
	}
}

/** Rows of the first result as plain arrays; throws the error text when the statement failed. */
async function rows(id, database, sql) {
	const r = await query(id, database, sql);
	if (!r.ok || r.error) { throw new Error(r.error || 'The query failed.'); }
	return (r.results[0] && r.results[0].rows) || [];
}

module.exports = { ROLE, qi, ql, qt, projects, detail, wake, history, connection, query, rows };
