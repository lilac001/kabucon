/* ═══ カブコン utils ═══ */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

function yen(v, sign = false) {
  const n = Math.round(v);
  const abs = Math.abs(n).toLocaleString('ja-JP');
  if (n < 0) return '-¥' + abs;
  return (sign && n > 0 ? '+¥' : '¥') + abs;
}

function fmtPrice(p) {
  if (p == null || isNaN(p)) return '--';
  return p % 1 === 0 ? p.toLocaleString('ja-JP') : p.toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function fmtTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* 東証呼値(簡易版: TOPIX500以外の一般銘柄) */
function tickSize(price) {
  if (price <= 3000) return 1;
  if (price <= 5000) return 5;
  if (price <= 30000) return 10;
  if (price <= 50000) return 50;
  if (price <= 300000) return 100;
  return 500;
}
function roundToTick(price) {
  const t = tickSize(price);
  return Math.round(price / t) * t;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ── Table API wrapper ── */
const api = {
  async list(table, params = {}) {
    const q = new URLSearchParams({ limit: 100, ...params });
    let r = await fetch(`tables/${table}?${q}`);
    if (!r.ok && 'search' in params) {
      // 一部環境(Hosted/D1)はsearch未対応のため、searchなしで再試行
      const { search, ...rest } = params;
      const q2 = new URLSearchParams({ limit: 100, ...rest });
      r = await fetch(`tables/${table}?${q2}`);
    }
    if (!r.ok) throw new Error(`${table} 読み込み失敗 (HTTP ${r.status})`);
    return r.json();
  },
  async listAll(table, params = {}) {
    let page = 1, out = [];
    for (;;) {
      const res = await this.list(table, { ...params, page, limit: 100 });
      out = out.concat(res.data || []);
      if (out.length >= (res.total || 0) || !(res.data || []).length) break;
      page++;
    }
    return out;
  },
  async get(table, id) {
    const r = await fetch(`tables/${table}/${id}`);
    if (!r.ok) return null;
    return r.json();
  },
  async create(table, data) {
    const r = await fetch(`tables/${table}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!r.ok) throw new Error(`${table} create failed`);
    return r.json();
  },
  async patch(table, id, data) {
    let r = await fetch(`tables/${table}/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!r.ok) {
      // PATCH未対応環境(Hosted/D1)向けフォールバック: GET→マージ→PUT
      const cur = await this.get(table, id);
      if (cur) {
        const merged = { ...cur, ...data };
        delete merged.gs_project_id; delete merged.gs_table_name;
        r = await fetch(`tables/${table}/${id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(merged)
        });
      }
    }
    if (!r.ok) throw new Error(`${table} 更新失敗 (HTTP ${r.status})`);
    try { return await r.json(); } catch (e) { return { id, ...data }; }
  },
  async remove(table, id) {
    await fetch(`tables/${table}/${id}`, { method: 'DELETE' });
  }
};
