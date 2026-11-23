// The Database view in the side bar: schemas and their tables, views and sequences-free (tables and views only), straight from the catalog.

'use strict';

const vscode = require('vscode');
const db = require('./api');

class DatabaseTree {
	constructor(getState) {
		this.getState = getState; // () => { projectId, database } | undefined
		this._change = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._change.event;
	}

	refresh() { this._change.fire(); }

	getTreeItem(node) { return node.item; }

	async getChildren(node) {
		const s = this.getState();
		if (!s || !s.database) { return []; }
		try {
			if (!node) {
				const schemas = await db.rows(s.projectId, s.database, `select schema_name from information_schema.schemata where schema_name not in ('information_schema') and schema_name not like 'pg\\_%' order by 1`);
				return schemas.map(([name]) => {
					const item = new vscode.TreeItem(name, name === 'public' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
					item.iconPath = new vscode.ThemeIcon('symbol-namespace');
					item.contextValue = 'schema';
					return { kind: 'schema', schema: name, item };
				});
			}
			if (node.kind === 'schema') {
				const tables = await db.rows(s.projectId, s.database, `select table_name, table_type, coalesce((select reltuples::bigint from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = t.table_schema and c.relname = t.table_name), 0)::text from information_schema.tables t where table_schema = ${db.ql(node.schema)} order by 1`);
				if (!tables.length) { return [{ kind: 'empty', item: Object.assign(new vscode.TreeItem('No tables'), { description: 'create one from the SQL editor' }) }]; }
				return tables.map(([name, type, est]) => {
					const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
					const isView = type === 'VIEW';
					item.iconPath = new vscode.ThemeIcon(isView ? 'eye' : 'table');
					item.description = isView ? 'view' : Number(est) > 0 ? `~${Number(est).toLocaleString()} rows` : '';
					item.contextValue = isView ? 'view' : 'table';
					item.command = { command: 'vantrex.db.openTable', title: 'Open Table', arguments: [{ schema: node.schema, table: name }] };
					return { kind: 'table', schema: node.schema, table: name, item };
				});
			}
		} catch (e) {
			return [{ kind: 'error', item: Object.assign(new vscode.TreeItem(e.message || 'Could not read the database'), { iconPath: new vscode.ThemeIcon('warning') }) }];
		}
		return [];
	}
}

module.exports = { DatabaseTree };
