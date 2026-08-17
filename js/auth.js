/* ═══ カブコン 簡易認証 ═══
 * クライアントサイドの簡易認証(SHA-256ハッシュ照合)。
 * 本番公開時は Hosted Deploy のアクセス制御(authenticated/allowlist)を併用すること。
 */
'use strict';

const Auth = {
  user: null,

  async init() {
    const saved = sessionStorage.getItem('kabucon_user');
    if (saved) {
      try {
        const u = JSON.parse(saved);
        const fresh = await api.get('users', u.id);
        if (fresh && !fresh.deleted) { this.user = fresh; return true; }
      } catch (e) { /* ignore */ }
      sessionStorage.removeItem('kabucon_user');
    }
    return false;
  },

  async login(username, password) {
    if (!username || !password) throw new Error('ユーザーIDとパスワードを入力してください');
    const all = await api.listAll('users');
    const hash = await sha256(password + ':kabucon');
    const u = all.find(x => x.username === username && !x.deleted);
    if (!u) throw new Error('ユーザーが見つかりません');
    if (u.password_hash !== hash) throw new Error('パスワードが違います');
    this.user = u;
    sessionStorage.setItem('kabucon_user', JSON.stringify({ id: u.id }));
    return u;
  },

  async register(username, password) {
    if (!username || username.length < 3) throw new Error('ユーザーIDは3文字以上にしてください');
    if (!password || password.length < 4) throw new Error('パスワードは4文字以上にしてください');
    const all = await api.listAll('users');
    if (all.some(x => x.username === username && !x.deleted)) {
      throw new Error('そのユーザーIDは既に使われています');
    }
    const hash = await sha256(password + ':kabucon');
    const u = await api.create('users', {
      id: uuid(), username, password_hash: hash,
      display_name: username, created: new Date().toISOString()
    });
    this.user = u;
    sessionStorage.setItem('kabucon_user', JSON.stringify({ id: u.id }));
    return u;
  },

  logout() {
    this.user = null;
    sessionStorage.removeItem('kabucon_user');
  }
};
