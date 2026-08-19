/* ═══ カブコン データソース層 ═══
 * 全ソースは共通イベント形式を emit する:
 *   { t:epochMs, type:'tick',  p:価格, q:出来高, side:'B'|'S'|'' }
 *   { t:epochMs, type:'board', asks:[[price,qty]x10], bids:[[price,qty]x10], over:数量, under:数量 }
 *
 * ソース:
 *  - SimulatorSource : 内蔵の擬似マーケット(板+歩み値を生成)
 *  - KabuSource      : kabu STATION API (localhost:18080, PUSH WebSocket)
 *  - BridgeSource    : 汎用WSブリッジ(moomoo OpenD 等をJSON中継)
 *  - JQuantsSource   : 日足OHLCVから当日ティックを疑似再構成(過去日指定)
 */
'use strict'

/* ── 内蔵シミュレーター ── */
class SimulatorSource {
  constructor(opts = {}) {
    this.base = opts.basePrice || 3000
    this.price = this.base
    this.onEvent = null
    this.onError = null
    this._timer = null
    this._trend = 0
    this._vol = 0
  }
  async start() {
    this.price = roundToTick(this.base)
    this._emitBoard()
    const loop = () => {
      const wait = 120 + Math.random() * 700 // 平均~0.5秒間隔
      this._timer = setTimeout(() => {
        this._step()
        loop()
      }, wait)
    }
    loop()
  }
  stop() {
    clearTimeout(this._timer)
    this._timer = null
  }

  _step() {
    // トレンド + ノイズ + 平均回帰
    if (Math.random() < 0.02) this._trend = (Math.random() - 0.5) * 2.4 // トレンド転換
    const t = tickSize(this.price)
    const meanRev = (this.base - this.price) * 0.0004
    const noise = (Math.random() - 0.5) * 2.2
    let move = this._trend * 0.35 + noise + meanRev
    let steps = Math.round(move)
    // 出来高: たまに大口
    const big = Math.random() < 0.06
    const q =
      (big
        ? 10 + Math.floor(Math.random() * 90)
        : 1 + Math.floor(Math.random() * 9)) * 100
    this.price = Math.max(t, this.price + steps * t)
    this.price = roundToTick(this.price)
    const side =
      steps > 0 ? 'B' : steps < 0 ? 'S' : Math.random() < 0.5 ? 'B' : 'S'
    this._emit({ t: Date.now(), type: 'tick', p: this.price, q, side })
    if (Math.random() < 0.7) this._emitBoard()
  }

  _emitBoard() {
    const t = tickSize(this.price)
    const asks = [],
      bids = []
    let cumBias = this._trend // トレンドで板の厚み変化
    for (let i = 1; i <= 10; i++) {
      const askQ = Math.floor(
        (300 + Math.random() * 4000) * (1 - cumBias * 0.12) * (1 + i * 0.08),
      )
      const bidQ = Math.floor(
        (300 + Math.random() * 4000) * (1 + cumBias * 0.12) * (1 + i * 0.08),
      )
      asks.push([
        this.price + i * t,
        Math.max(100, Math.round(askQ / 100) * 100),
      ])
      bids.push([
        this.price - i * t,
        Math.max(100, Math.round(bidQ / 100) * 100),
      ])
    }
    this._emit({
      t: Date.now(),
      type: 'board',
      asks,
      bids,
      over: Math.round((30000 + Math.random() * 200000) / 100) * 100,
      under: Math.round((30000 + Math.random() * 200000) / 100) * 100,
    })
  }
  _emit(ev) {
    if (this.onEvent) this.onEvent(ev)
  }
}

/* ── kabu STATION API ──
 * https://kabucom.github.io/kabusapi/
 * 事前に kabuステーションを起動し API設定を有効化。localhost:18080。
 * ブラウザから直接 localhost へアクセスするため、本アプリをlocalhostまたは
 * https環境で開く場合はブラウザのMixed Content制限に注意。
 */
class KabuSource {
  constructor(opts = {}) {
    this.symbol = opts.symbol
    this.password = opts.password
    this.host = opts.host || 'localhost:18080'
    this.onEvent = null
    this.onError = null
    this._ws = null
  }
  async start() {
    // 1) トークン取得
    const r = await fetch(`http://${this.host}/kabusapi/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ APIPassword: this.password }),
    }).catch(() => null)
    if (!r || !r.ok)
      throw new Error(
        'kabu APIトークン取得失敗。kabuステーション起動とAPI設定を確認してください。',
      )
    const { Token } = await r.json()
    this.token = Token
    // 2) 銘柄登録
    await fetch(`http://${this.host}/kabusapi/register`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': Token },
      body: JSON.stringify({ Symbols: [{ Symbol: this.symbol, Exchange: 1 }] }),
    })
    // 3) PUSH配信 WebSocket
    this._ws = new WebSocket(`ws://${this.host}/kabusapi/websocket`)
    this._ws.onmessage = (m) => {
      try {
        this._handle(JSON.parse(m.data))
      } catch (e) {
        /* skip */
      }
    }
    this._ws.onerror = () => {
      if (this.onError) this.onError(new Error('kabu WebSocketエラー'))
    }
  }
  stop() {
    if (this._ws) this._ws.close()
    this._ws = null
  }

  _handle(d) {
    const now = Date.now()
    if (d.CurrentPrice != null) {
      this._emit({
        t: now,
        type: 'tick',
        p: d.CurrentPrice,
        q: d.TradingVolume ? 0 : d.LastQty || 0,
        side: d.CurrentPriceChangeStatus === '0058' ? 'S' : 'B',
      })
    }
    if (d.Sell1 && d.Buy1) {
      const asks = [],
        bids = []
      for (let i = 1; i <= 10; i++) {
        const s = d['Sell' + i],
          b = d['Buy' + i]
        if (s) asks.push([s.Price, s.Qty])
        if (b) bids.push([b.Price, b.Qty])
      }
      this._emit({
        t: now,
        type: 'board',
        asks,
        bids,
        over: d.OverSellQty || 0,
        under: d.UnderBuyQty || 0,
      })
    }
  }
  _emit(ev) {
    if (this.onEvent) this.onEvent(ev)
  }
}

/* ── 汎用WSブリッジ(moomoo等) ──
 * ローカルで動かす中継サーバに接続。中継サーバは moomoo OpenD などから取得した
 * データを本アプリの共通イベントJSON(上記形式)で送信するだけでよい。
 */
class BridgeSource {
  constructor(opts = {}) {
    this.url = opts.url || 'ws://localhost:8765'
    this.symbol = opts.symbol
    this.onEvent = null
    this.onError = null
    this._ws = null
  }
  async start() {
    await new Promise((resolve, reject) => {
      this._ws = new WebSocket(this.url)
      this._ws.onopen = () => {
        this._ws.send(
          JSON.stringify({
            cmd: 'subscribe',
            symbol: this.symbol,
            market: 'JP',
          }),
        )
        resolve()
      }
      this._ws.onerror = () =>
        reject(new Error('ブリッジWS接続失敗: ' + this.url))
      this._ws.onmessage = (m) => {
        try {
          const ev = JSON.parse(m.data)
          if ((ev.type === 'tick' || ev.type === 'board') && this.onEvent) {
            ev.t = ev.t || Date.now()
            this.onEvent(ev)
          }
        } catch (e) {
          /* skip */
        }
      }
    })
  }
  stop() {
    if (this._ws) this._ws.close()
    this._ws = null
  }
}

/* ── J-Quants (過去日データ→擬似ティック再構成) ──
 * J-Quants APIは日足/財務が中心のため、指定日のOHLCVから
 * 場中の値動きを確率的に再構成して練習用データを生成する。
 * Pages Function経由でAPI取得、またはCSV貼り付けデータを使用する。
 * API呼び出しを同一オリジンのFunctionへ中継するため、ブラウザのCORS制限を回避する。
 * IDトークン未入力時は、Function側の JQUANTS_TOKEN を使用する。
 */
class JQuantsSource {
  constructor(opts = {}) {
    this.symbol = opts.symbol
    this.date = opts.date // YYYY-MM-DD
    this.token = opts.token || ''
    this.pasted = opts.pasted || ''
    this.onEvent = null
    this.onError = null
    this._stopped = false
  }
  async start() {
    let ohlcv = null
    if (this.pasted.trim()) {
      ohlcv = this._parsePaste(this.pasted)
    } else {
      const code = this.symbol.length === 4 ? this.symbol + '0' : this.symbol
      const query = new URLSearchParams({ code, date: this.date || '' })
      let r
      try {
        r = await fetch(`/jquants/daily?${query}`, {
          headers: this.token ? { Authorization: 'Bearer ' + this.token } : {},
        })
      } catch (_) {
        throw new Error(
          'J-Quants中継へ接続できません。Cloudflare Pages Functionsを有効にしてデプロイしてください。',
        )
      }
      const j = await r.json().catch(() => ({}))

      if (!r.ok)
        throw new Error(j.error || `J-Quants API取得失敗 (HTTP ${r.status})`)

      // ここでquoteオブジェクトを取得
      const q = j.quote || null
      if (!q) throw new Error('指定日のデータがありません')

      ohlcv = this._quoteToOhlcv(q)
    }

    if (!ohlcv || ohlcv.o == null) throw new Error('OHLCVデータが不正です')
    this._generate(ohlcv)
  }
  stop() {
    this._stopped = true
  }

  _quoteToOhlcv(q) {
    return {
      o: Number(q.O ?? q.Open ?? q.open),
      h: Number(q.H ?? q.High ?? q.high),
      l: Number(q.L ?? q.Low ?? q.low),
      c: Number(q.C ?? q.Close ?? q.close),
      v: Number(q.Vo ?? q.Volume ?? q.volume ?? 1000000),
    }
  }

  _parsePaste(text) {
    // CSV: date,open,high,low,close,volume または APIレスポンスJSON
    try {
      const j = JSON.parse(text)
      const q = Array.isArray(j)
        ? j[0]
        : j.quote || (j.daily_quotes ? j.daily_quotes[0] : j)
      return this._quoteToOhlcv(q)
    } catch (e) {
      /* not JSON */
    }
    const line = text
      .trim()
      .split('\n')[0]
      .split(',')
      .map((s) => s.trim())
    const nums = line.filter((s) => /^[\d.]+$/.test(s)).map(Number)
    if (nums.length >= 4) {
      const [o, h, l, c, v] = nums
      return { o, h, l, c, v: v || 1000000 }
    }
    throw new Error(
      'CSV形式を解析できません(例: 2026-01-12,3000,3080,2980,3050,1234500)',
    )
  }

  /* OHLCVを満たすブラウン橋型の擬似ティック列を生成し、高速でemit(記録側が全量保存) */
  _generate(ohlcv) {
    const { o, h, l, c, v } = ohlcv
    const N = 3000 // ティック数
    const day = this.date
      ? new Date(this.date + 'T09:00:00+09:00').getTime()
      : Date.now() - 5 * 3600e3
    // 9:00-15:00 (昼休み11:30-12:30を除く5時間)
    const times = []
    for (let i = 0; i < N; i++) {
      let frac = i / (N - 1)
      let sec = frac * 5 * 3600
      let t = day + sec * 1000
      if (sec > 2.5 * 3600) t += 3600 * 1000 // 昼休みスキップ
      times.push(t)
    }
    // 価格パス: O始C終、H/Lタッチを保証
    const path = new Array(N)
    path[0] = o
    path[N - 1] = c
    const hIdx = Math.floor(N * (0.15 + Math.random() * 0.5))
    const lIdx = Math.floor(N * (0.15 + Math.random() * 0.5))
    const anchors = [
      [0, o],
      [hIdx, h],
      [lIdx, l],
      [N - 1, c],
    ].sort((a, b) => a[0] - b[0])
    for (let k = 0; k < anchors.length - 1; k++) {
      const [i0, p0] = anchors[k],
        [i1, p1] = anchors[k + 1]
      for (let i = i0; i <= i1; i++) {
        const f = i1 === i0 ? 0 : (i - i0) / (i1 - i0)
        const noiseAmp = (h - l) * 0.25 * Math.sin(Math.PI * f)
        path[i] = p0 + (p1 - p0) * f + (Math.random() - 0.5) * noiseAmp
      }
    }
    let prev = o
    const qBase = Math.max(100, Math.round(v / N / 100) * 100)
    for (let i = 0; i < N && !this._stopped; i++) {
      const p = roundToTick(Math.min(h, Math.max(l, path[i])))
      const q = Math.max(
        100,
        Math.round((qBase * (0.3 + Math.random() * 1.7)) / 100) * 100,
      )
      this._emit({
        t: times[i],
        type: 'tick',
        p,
        q,
        side: p >= prev ? 'B' : 'S',
      })
      if (i % 3 === 0) this._emit(this._mkBoard(times[i], p))
      prev = p
    }
    if (this.onDone) this.onDone()
  }
  _mkBoard(t, price) {
    const ts = tickSize(price)
    const asks = [],
      bids = []
    for (let i = 1; i <= 10; i++) {
      asks.push([
        price + i * ts,
        Math.max(100, Math.round((200 + Math.random() * 3000) / 100) * 100),
      ])
      bids.push([
        price - i * ts,
        Math.max(100, Math.round((200 + Math.random() * 3000) / 100) * 100),
      ])
    }
    return { t, type: 'board', asks, bids, over: 50000, under: 50000 }
  }
  _emit(ev) {
    if (this.onEvent) this.onEvent(ev)
  }
}

function createSource(kind, opts) {
  switch (kind) {
    case 'simulator':
      return new SimulatorSource(opts)
    case 'kabu':
      return new KabuSource(opts)
    case 'bridge':
    case 'moomoo':
      return new BridgeSource(opts)
    case 'jquants':
      return new JQuantsSource(opts)
    default:
      throw new Error('unknown source: ' + kind)
  }
}
