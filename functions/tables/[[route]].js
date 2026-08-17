/**
 * カブコン Table API 互換レイヤー (Cloudflare Pages Functions + D1)
 * ─────────────────────────────────────────────
 * Genspark環境の RESTful Table API (`tables/{table}` / `tables/{table}/{id}`) を
 * 自分のCloudflareアカウント(Pages + D1)上で再現する。
 *
 * セットアップ:
 *   1. D1作成:        wrangler d1 create kabucon-db
 *   2. スキーマ適用:   wrangler d1 execute kabucon-db --remote --file=schema.sql
 *   3. Pagesの設定 → Functions → D1バインディングで 変数名「DB」に kabucon-db を紐付け
 *
 * データは汎用テーブル records(table_name, id, data JSON) に格納する。
 */
'use strict';

const TABLES = new Set(['users', 'recordings', 'tick_chunks', 'sessions', 'trades', 'settings']);

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });

function rowToRecord(row) {
  const rec = JSON.parse(row.data);
  rec.id = row.id;
  rec.created_at = row.created_at;
  rec.updated_at = row.updated_at;
  return rec;
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const db = env.DB;
  if (!db) return json({ error: 'D1 binding "DB" not configured' }, 500);

  const segs = Array.isArray(params.route) ? params.route : [params.route];
  const table = segs[0];
  const id = segs[1] || null;
  if (!TABLES.has(table)) return json({ error: 'unknown table: ' + table }, 404);

  const method = request.method.toUpperCase();

  try {
    /* ── 一覧 GET tables/{table} ── */
    if (method === 'GET' && !id) {
      const url = new URL(request.url);
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
      const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10)));
      const search = url.searchParams.get('search');
      const offset = (page - 1) * limit;

      let where = 'table_name = ?1 AND deleted = 0';
      const binds = [table];
      if (search) {
        where += ' AND data LIKE ?2';
        binds.push('%' + search.replace(/[%_]/g, '') + '%');
      }
      const totalRow = await db.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${where}`)
        .bind(...binds).first();
      const rows = await db.prepare(
        `SELECT id, data, created_at, updated_at FROM records WHERE ${where}
         ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
      ).bind(...binds).all();

      return json({
        data: (rows.results || []).map(rowToRecord),
        total: totalRow ? totalRow.n : 0,
        page, limit, table
      });
    }

    /* ── 単体 GET tables/{table}/{id} ── */
    if (method === 'GET' && id) {
      const row = await db.prepare(
        'SELECT id, data, created_at, updated_at FROM records WHERE table_name=?1 AND id=?2 AND deleted=0'
      ).bind(table, id).first();
      if (!row) return json({ error: 'not found' }, 404);
      return json(rowToRecord(row));
    }

    /* ── 作成 POST ── */
    if (method === 'POST' && !id) {
      const body = await request.json();
      const rid = body.id || crypto.randomUUID();
      body.id = rid;
      const now = Date.now();
      await db.prepare(
        'INSERT INTO records (table_name, id, data, created_at, updated_at, deleted) VALUES (?1,?2,?3,?4,?4,0)'
      ).bind(table, rid, JSON.stringify(body), now).run();
      return json({ ...body, created_at: now, updated_at: now }, 201);
    }

    /* ── 全置換 PUT ── */
    if (method === 'PUT' && id) {
      const body = await request.json();
      body.id = id;
      delete body.created_at; delete body.updated_at;
      delete body.gs_project_id; delete body.gs_table_name;
      const now = Date.now();
      const r = await db.prepare(
        'UPDATE records SET data=?3, updated_at=?4 WHERE table_name=?1 AND id=?2 AND deleted=0'
      ).bind(table, id, JSON.stringify(body), now).run();
      if (!r.meta.changes) return json({ error: 'not found' }, 404);
      return json({ ...body, updated_at: now });
    }

    /* ── 部分更新 PATCH ── */
    if (method === 'PATCH' && id) {
      const patch = await request.json();
      const row = await db.prepare(
        'SELECT data FROM records WHERE table_name=?1 AND id=?2 AND deleted=0'
      ).bind(table, id).first();
      if (!row) return json({ error: 'not found' }, 404);
      const merged = { ...JSON.parse(row.data), ...patch, id };
      delete merged.created_at; delete merged.updated_at;
      delete merged.gs_project_id; delete merged.gs_table_name;
      const now = Date.now();
      await db.prepare(
        'UPDATE records SET data=?3, updated_at=?4 WHERE table_name=?1 AND id=?2'
      ).bind(table, id, JSON.stringify(merged), now).run();
      return json({ ...merged, updated_at: now });
    }

    /* ── 削除 DELETE (ソフトデリート) ── */
    if (method === 'DELETE' && id) {
      await db.prepare(
        'UPDATE records SET deleted=1, updated_at=?3 WHERE table_name=?1 AND id=?2'
      ).bind(table, id, Date.now()).run();
      return new Response(null, { status: 204 });
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
