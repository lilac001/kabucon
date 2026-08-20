/* ═══ カブコン アプリ制御 ═══ */
'use strict'

const App = {
  mode: 'practice', // practice | support | live
  market: new MarketState(),
  engine: null,
  liveSource: null, // support/liveモードのデータソース
  playback: {
    // practiceモードのリプレイ
    events: [],
    idx: 0,
    playing: false,
    speed: 2,
    timer: null,
    startT: 0,
    endT: 0,
  },
  chartFrame: 10,
  _renderTimer: null,

  init() {
    this.engine = new TradingEngine(this.market)
    this.bindLogin()
    this.bindHome()
    this.bindTrade()
    this.boot()
  },

  async boot() {
    const ok = await Auth.init().catch(() => false)
    if (ok) this.showHome()
    else this.showScreen('screen-login')
  },

  showScreen(id) {
    $$('.screen').forEach((s) => s.classList.remove('active'))
    $('#' + id).classList.add('active')
  },

  /* ══════════ ログイン ══════════ */
  bindLogin() {
    const doAuth = async (fn) => {
      const err = $('#login-error')
      err.textContent = ''
      try {
        await fn($('#login-username').value.trim(), $('#login-password').value)
        this.showHome()
      } catch (e) {
        err.textContent = e.message
      }
    }
    $('#btn-login').addEventListener('click', () =>
      doAuth((u, p) => Auth.login(u, p)),
    )
    $('#btn-register').addEventListener('click', () =>
      doAuth((u, p) => Auth.register(u, p)),
    )
    $('#login-password').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#btn-login').click()
    })
    $('#btn-logout').addEventListener('click', () => {
      Auth.logout()
      location.reload()
    })
  },

  showHome() {
    $('#home-user').textContent = Auth.user.display_name || Auth.user.username
    this.showScreen('screen-home')
    this.loadLibrary()
    this.loadStats()
  },

  /* ══════════ ホーム ══════════ */
  bindHome() {
    $$('.home-tab').forEach((btn) =>
      btn.addEventListener('click', () => {
        $$('.home-tab').forEach((b) => b.classList.remove('active'))
        btn.classList.add('active')
        $$('.home-panel').forEach((p) => p.classList.remove('active'))
        $('#tab-' + btn.dataset.tab).classList.add('active')
        if (btn.dataset.tab === 'library') this.loadLibrary()
        if (btn.dataset.tab === 'stats') this.loadStats()
      }),
    )

    // ソース切替でオプション表示
    $('#rec-source').addEventListener('change', () => {
      const v = $('#rec-source').value
      $('#rec-sim-opts').classList.toggle('hidden', v !== 'simulator')
      $('#rec-kabu-opts').classList.toggle('hidden', v !== 'kabu')
      $('#rec-bridge-opts').classList.toggle('hidden', v !== 'bridge')
      $('#rec-jq-opts').classList.toggle('hidden', v !== 'jquants')
    })
    $('#rec-jq-date').value = '2026-08-14'

    $('#btn-rec-start').addEventListener('click', () => this.startRecording())
    $('#btn-rec-stop').addEventListener('click', () => this.stopRecording())

    $('#btn-quick-practice').addEventListener('click', () =>
      this.startQuickPractice(),
    )
    $('#btn-quick-support').addEventListener('click', () =>
      this.enterTrade('support', null),
    )
  },

  /* ── レコーダー ── */
  monPrices: [],
  monTicks: [],
  async startRecording() {
    const kind = $('#rec-source').value
    const symbol = $('#rec-symbol').value.trim() || '0000'
    const statusEl = $('#rec-status')
    statusEl.className = 'rec-status'
    statusEl.textContent = '開始中…'

    const sourceOpts = {}
    let recDate = new Date().toISOString().slice(0, 10)
    if (kind === 'simulator')
      sourceOpts.basePrice = parseFloat($('#rec-base-price').value) || 3000
    if (kind === 'kabu') sourceOpts.password = $('#rec-kabu-pw').value
    if (kind === 'bridge') sourceOpts.url = $('#rec-bridge-url').value.trim()
    if (kind === 'jquants') {
      recDate = $('#rec-jq-date').value || recDate
      sourceOpts.date = recDate
      sourceOpts.pasted = $('#rec-jq-paste').value
    }

    this.monPrices = []
    this.monTicks = []
    $('#mon-price').textContent = '--'
    $('#mon-diff').textContent = ''
    $('#mon-ticks').textContent = '0'
    $('#mon-boards').textContent = '0'
    $('#mon-chunks').textContent = '0'
    $('#mon-elapsed').textContent = '0:00'
    $('#mon-summary-count').textContent = '0'
    $('#mon-summary-avg').textContent = '--'
    $('#mon-summary-period').textContent = '--'
    $('#mon-latest').innerHTML = '<p class="empty">データ待機中…</p>'
    let monBoards = 0
    recorder.onUpdate = (ev) => {
      if (ev.type === 'error') {
        statusEl.className = 'rec-status'
        statusEl.textContent = '⚠ ' + ev.message
        return
      }
      if (ev.type === 'gen-done') {
        this.stopRecording()
        return
      }
      if (ev.type === 'tick') {
        this.monPrices.push(ev.p)
        this.monTicks.push(ev)
        $('#mon-price').textContent = fmtPrice(ev.p)
        const first = this.monPrices[0]
        const diff = ev.p - first
        const dEl = $('#mon-diff')
        dEl.textContent =
          (diff >= 0 ? '+' : '') +
          fmtPrice(Math.abs(diff)) +
          ` (${((diff / first) * 100).toFixed(2)}%)`
        dEl.className =
          'mon-diff ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat')
        const avg =
          this.monPrices.reduce((sum, price) => sum + price, 0) /
          this.monPrices.length
        const firstTime = this.monTicks[0].t
        const lastTime = ev.t
        $('#mon-summary-count').textContent =
          this.monTicks.length.toLocaleString()
        $('#mon-summary-avg').textContent = fmtPrice(avg)
        $('#mon-summary-period').textContent =
          `${fmtTime(firstTime)}〜${fmtTime(lastTime)}`
        $('#mon-latest').innerHTML =
          `<table><thead><tr><th>時刻</th><th>価格</th><th>数量</th><th>方向</th></tr></thead><tbody>${this.monTicks
            .slice(-20)
            .reverse()
            .map(
              (tick) =>
                `<tr><td>${fmtTime(tick.t)}</td><td>${fmtPrice(tick.p)}</td><td>${Number(tick.q || 0).toLocaleString()}</td><td class="${tick.p >= first ? 'up' : 'down'}">${tick.side === 'buy' ? '買' : tick.side === 'sell' ? '売' : '—'}</td></tr>`,
            )
            .join('')}</tbody></table>`
        Views.renderSpark($('#mon-spark'), this.monPrices)
      } else if (ev.type === 'board') monBoards++
      $('#mon-ticks').textContent = recorder.tickCount
      $('#mon-boards').textContent = monBoards
      $('#mon-chunks').textContent = recorder.chunkSeq
      $('#mon-elapsed').textContent = fmtDur(
        (Date.now() - recorder.startedAt) / 1000,
      )
    }

    try {
      await recorder.start({
        sourceKind: kind,
        sourceOpts,
        symbol,
        symbolName: '',
        recDate,
      })
      statusEl.className = 'rec-status recording'
      statusEl.textContent =
        kind === 'jquants' ? '過去データ生成中…' : '記録中… (' + symbol + ')'
      $('#btn-rec-start').classList.add('hidden')
      $('#btn-rec-stop').classList.remove('hidden')
    } catch (e) {
      statusEl.textContent = '⚠ ' + e.message
    }
  },

  async stopRecording() {
    const statusEl = $('#rec-status')
    statusEl.className = 'rec-status'
    statusEl.textContent = '保存中…'
    $('#btn-rec-stop').disabled = true
    try {
      const rec = await recorder.stop()
      statusEl.textContent = `✅ 保存完了: ${rec ? rec.name : ''}(${recorder.tickCount}ティック)`
      this.loadLibrary()
    } catch (e) {
      statusEl.textContent = '⚠ 保存エラー: ' + e.message
    }
    $('#btn-rec-stop').disabled = false
    $('#btn-rec-stop').classList.add('hidden')
    $('#btn-rec-start').classList.remove('hidden')
  },

  /* ── ライブラリ ── */
  async loadLibrary() {
    const el = $('#library-list')
    try {
      const all = await api.listAll('recordings')
      const mine = all.filter(
        (r) => r.user_id === Auth.user.id && !r.deleted && r.status === 'done',
      )
      mine.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
      if (!mine.length) {
        el.innerHTML =
          '<p class="empty">記録がありません。レコーダーで作成するか、クイックスタートで即練習できます。</p>'
        return
      }
      const srcLabel = {
        simulator: 'シミュ',
        kabu: 'kabu',
        moomoo: 'moomoo',
        jquants: 'J-Quants',
      }
      el.innerHTML = mine
        .map(
          (r) => `
        <div class="lib-item">
          <span class="li-sym">${r.symbol}</span>
          <span class="src-badge">${srcLabel[r.source] || r.source}</span>
          <span class="li-meta">${r.rec_date} / ${r.tick_count}tick / ${fmtPrice(r.start_price)}→${fmtPrice(r.end_price)}</span>
          <div class="li-actions">
            <button class="btn btn-primary btn-sm btn-lib-practice" data-rid="${r.id}"><i class="fa-solid fa-graduation-cap"></i> 練習</button>
            <button class="btn btn-ghost btn-sm btn-lib-del" data-rid="${r.id}" title="削除"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>`,
        )
        .join('')
      el.querySelectorAll('.btn-lib-practice').forEach((b) =>
        b.addEventListener('click', () =>
          this.enterTrade('practice', b.dataset.rid),
        ),
      )
      el.querySelectorAll('.btn-lib-del').forEach((b) =>
        b.addEventListener('click', async () => {
          if (!confirm('この記録を削除しますか?')) return
          await api.remove('recordings', b.dataset.rid)
          this.loadLibrary()
        }),
      )
    } catch (e) {
      el.innerHTML = '<p class="empty">読み込みエラー</p>'
    }
  },

  /* ── 成績 ── */
  async loadStats() {
    try {
      const all = await api.listAll('sessions')
      const mine = all.filter(
        (s) =>
          s.user_id === Auth.user.id && !s.deleted && s.status === 'closed',
      )
      mine.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
      const totalPnl = mine.reduce((s, x) => s + (x.realized_pnl || 0), 0)
      const totalTrades = mine.reduce((s, x) => s + (x.trade_count || 0), 0)
      const totalWins = mine.reduce((s, x) => s + (x.win_count || 0), 0)
      const winRate = totalTrades
        ? Math.round((totalWins / totalTrades) * 100)
        : 0
      $('#stats-summary').innerHTML = `
        <div class="stat-box"><label>累計損益</label><span class="v ${totalPnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${yen(totalPnl, true)}</span></div>
        <div class="stat-box"><label>セッション数</label><span class="v">${mine.length}</span></div>
        <div class="stat-box"><label>決済回数</label><span class="v">${totalTrades}</span></div>
        <div class="stat-box"><label>勝率</label><span class="v">${winRate}%</span></div>`
      const modeLabel = { practice: '練習', support: 'サポート', live: '取引' }
      $('#stats-sessions').innerHTML =
        mine
          .slice(0, 30)
          .map(
            (s) => `
        <div class="sess-row">
          <span>${(s.started_at || '').slice(0, 16).replace('T', ' ')}</span>
          <span class="src-badge">${modeLabel[s.mode] || s.mode}</span>
          <span class="li-sym mono">${s.symbol}</span>
          <span style="flex:1"></span>
          <span>${s.trade_count}回 / 勝${s.win_count}</span>
          <span class="${(s.realized_pnl || 0) >= 0 ? 'pnl-pos' : 'pnl-neg'}">${yen(s.realized_pnl || 0, true)}</span>
        </div>`,
          )
          .join('') || '<p class="empty">セッション履歴なし</p>'
    } catch (e) {
      /* ignore */
    }
  },

  /* ══════════ トレード画面 ══════════ */
  bindTrade() {
    $('#btn-trade-back').addEventListener('click', () => this.exitTrade())

    // モード切替
    $$('.mode-btn').forEach((btn) =>
      btn.addEventListener('click', () => {
        const m = btn.dataset.mode
        if (m === 'live') {
          alert(
            '③取引モード(実売買)は今後実装予定です。kabu.com / moomoo APIと連携します。',
          )
          return
        }
        if (m === this.mode) return
        this.switchMode(m)
      }),
    )

    // 再生コントロール
    $('#pb-play').addEventListener('click', () => this.togglePlay())
    $$('.pb-speed').forEach((b) =>
      b.addEventListener('click', () => {
        $$('.pb-speed').forEach((x) => x.classList.remove('active'))
        b.classList.add('active')
        this.playback.speed = parseFloat(b.dataset.speed)
      }),
    )
    $('#pb-seek').addEventListener('input', () =>
      this.seekTo(parseInt($('#pb-seek').value)),
    )

    // チャート時間軸
    $$('.cframe').forEach((b) =>
      b.addEventListener('click', () => {
        $$('.cframe').forEach((x) => x.classList.remove('active'))
        b.classList.add('active')
        this.chartFrame = parseInt(b.dataset.frame)
        this.renderAll()
      }),
    )

    // 注文フォーム
    $$('.otype').forEach((b) =>
      b.addEventListener('click', () => {
        $$('.otype').forEach((x) => x.classList.remove('active'))
        b.classList.add('active')
      }),
    )
    $$('.qty-btn').forEach((b) =>
      b.addEventListener('click', () => {
        const el = $('#ord-qty')
        el.value = Math.max(
          100,
          (parseInt(el.value) || 100) + parseInt(b.dataset.dq),
        )
      }),
    )
    $$('input[name=ord-ptype]').forEach((r) =>
      r.addEventListener('change', () => {
        $('#ord-price').disabled =
          $('input[name=ord-ptype]:checked').value !== 'limit'
      }),
    )
    $('#btn-buy').addEventListener('click', () => this.placeOrder('buy'))
    $('#btn-sell').addEventListener('click', () => this.placeOrder('sell'))
    $('#btn-close-all').addEventListener('click', () => {
      this.engine.closeAll()
      this.renderAccount()
    })
    $('#btn-session-end').addEventListener('click', () => this.endSession())
    $('#btn-result-close').addEventListener('click', () => {
      $('#result-modal').classList.add('hidden')
      this.exitTrade()
    })

    // 建玉決済/注文取消(委譲)
    $('#positions').addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-close-pos')
      if (!btn) return
      const pos = this.engine.positions.find((p) => p.id === btn.dataset.pid)
      if (pos) {
        const side = pos.type === 'margin_short' ? 'buy' : 'sell'
        this.engine._execute(
          side,
          pos.type,
          pos.qty,
          side === 'buy' ? this.market.bestAsk() : this.market.bestBid(),
        )
        this.renderAccount()
      }
    })
    $('#open-orders').addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-cancel-order')
      if (btn) {
        this.engine.cancelOrder(btn.dataset.oid)
        this.renderAccount()
      }
    })

    // 時計
    setInterval(() => {
      const t = this.market.simTime
      $('#trade-clock').textContent = t
        ? fmtTime(t)
        : new Date().toTimeString().slice(0, 8)
    }, 500)
  },

  async startQuickPractice() {
    // シミュレーターで30秒分を即生成してリプレイなしのライブ練習
    this.enterTrade('practice-live', null)
  },

  /* mode: 'practice'(リプレイ) | 'practice-live'(シミュレータライブ) | 'support' */
  async enterTrade(mode, recordingId) {
    this.market.reset()
    this.engine.reset()
    this.stopPlayTimer()
    if (this.liveSource) {
      this.liveSource.stop()
      this.liveSource = null
    }

    let symbol = $('#rec-symbol').value.trim() || '7203'
    let symbolName = symbol

    if (mode === 'practice' && recordingId) {
      const rec = await api.get('recordings', recordingId)
      if (!rec) {
        alert('記録が見つかりません')
        return
      }
      symbol = rec.symbol
      symbolName = rec.symbol_name || symbol
      $('#playback-bar').style.display = 'flex'
      const events = await loadRecordingEvents(recordingId)
      if (!events.length) {
        alert('この記録にはデータがありません')
        return
      }
      this.playback.events = events
      this.playback.idx = 0
      this.playback.startT = events[0].t
      this.playback.endT = events[events.length - 1].t
      this.mode = 'practice'
    } else if (mode === 'practice-live') {
      $('#playback-bar').style.display = 'none'
      this.liveSource = createSource('simulator', {
        basePrice: parseFloat($('#rec-base-price').value) || 3000,
      })
      this.liveSource.onEvent = (ev) => this.onLiveEvent(ev)
      this.liveSource.start()
      symbolName = 'シミュレーター'
      this.mode = 'practice'
    } else if (mode === 'support') {
      $('#playback-bar').style.display = 'none'
      // サポートモード: レコーダーと同じソースでライブ表示(簡易版はシミュレータ)
      const kind =
        $('#rec-source').value === 'jquants'
          ? 'simulator'
          : $('#rec-source').value
      const opts = {}
      if (kind === 'simulator')
        opts.basePrice = parseFloat($('#rec-base-price').value) || 3000
      if (kind === 'kabu') opts.password = $('#rec-kabu-pw').value
      if (kind === 'bridge') opts.url = $('#rec-bridge-url').value.trim()
      this.liveSource = createSource(kind, { ...opts, symbol })
      this.liveSource.onEvent = (ev) => this.onLiveEvent(ev)
      try {
        await this.liveSource.start()
      } catch (e) {
        alert(
          'データソース接続失敗: ' +
            e.message +
            '\nシミュレーターに切り替えます。',
        )
        this.liveSource = createSource('simulator', opts)
        this.liveSource.onEvent = (ev) => this.onLiveEvent(ev)
        this.liveSource.start()
      }
      this.mode = 'support'
    }

    this.setModeUI(this.mode)
    $('#trade-symbol').textContent = symbol
    $('#trade-symbol-name').textContent = symbolName
    await this.engine.startSession(this.mode, recordingId, symbol)
    this.showScreen('screen-trade')
    this.renderAll()
    this.renderAccount()

    if (this.mode === 'practice' && recordingId) this.togglePlay(true)
    // 描画ループ
    this._renderTimer = setInterval(() => {
      this.renderAll()
      if (this.mode === 'support') Analyst.render(this.market, this.engine)
    }, 700)
  },

  switchMode(m) {
    // practice⇔support をその場で切替(セッションは継続、モードUIのみ変更)
    this.mode = m
    this.setModeUI(m)
    if (this.engine.session)
      api.patch('sessions', this.engine.session.id, { mode: m }).catch(() => {})
  },

  setModeUI(m) {
    document.body.dataset.mode = m
    $$('.mode-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.mode === m),
    )
    const banner = {
      practice: '練習モード(仮想売買)',
      support: 'サポートモード(仮想売買+AI分析)',
      live: '取引モード(実売買)',
    }
    $('#mode-banner').textContent = banner[m]
  },

  exitTrade() {
    this.stopPlayTimer()
    if (this.liveSource) {
      this.liveSource.stop()
      this.liveSource = null
    }
    clearInterval(this._renderTimer)
    if (this.engine.session) {
      // セッション放棄(記録せず閉じる)
      api
        .patch('sessions', this.engine.session.id, {
          status: 'closed',
          ended_at: new Date().toISOString(),
          end_cash: this.engine.cash,
          realized_pnl: this.engine.realizedPnl,
          trade_count: this.engine.fills.filter((f) => f.action === 'close')
            .length,
          win_count: this.engine.fills.filter(
            (f) => f.action === 'close' && f.pnl > 0,
          ).length,
        })
        .catch(() => {})
      this.engine.session = null
    }
    this.showHome()
  },

  /* ── ライブイベント ── */
  onLiveEvent(ev) {
    this.market.applyEvent(ev)
    if (ev.type === 'tick') this.engine.checkOrders()
  },

  /* ── リプレイ再生 ── */
  togglePlay(force) {
    const pb = this.playback
    pb.playing = force === true ? true : !pb.playing
    $('#pb-play').innerHTML = pb.playing
      ? '<i class="fa-solid fa-pause"></i>'
      : '<i class="fa-solid fa-play"></i>'
    if (pb.playing) this.playLoop()
    else this.stopPlayTimer()
  },

  stopPlayTimer() {
    clearTimeout(this.playback.timer)
    this.playback.timer = null
    this.playback.playing = false
  },

  playLoop() {
    const pb = this.playback
    if (!pb.playing || pb.idx >= pb.events.length) {
      if (pb.idx >= pb.events.length && pb.events.length) {
        pb.playing = false
        $('#pb-play').innerHTML = '<i class="fa-solid fa-play"></i>'
      }
      return
    }
    const ev = pb.events[pb.idx++]
    this.market.applyEvent(ev)
    if (ev.type === 'tick') this.engine.checkOrders()
    // シークバー更新
    const prog = (ev.t - pb.startT) / Math.max(1, pb.endT - pb.startT)
    $('#pb-seek').value = Math.round(prog * 1000)
    $('#pb-time').textContent =
      `${fmtDur((ev.t - pb.startT) / 1000)} / ${fmtDur((pb.endT - pb.startT) / 1000)}`
    // 次イベントまでの実時間
    const next = pb.events[pb.idx]
    let wait = next ? (next.t - ev.t) / pb.speed : 100
    wait = Math.min(Math.max(wait, 0), 2000)
    pb.timer = setTimeout(() => this.playLoop(), wait)
  },

  seekTo(permille) {
    const pb = this.playback
    if (!pb.events.length) return
    const targetT = pb.startT + ((pb.endT - pb.startT) * permille) / 1000
    // 市場状態を巻き戻して再構築
    this.market.reset()
    pb.idx = 0
    while (pb.idx < pb.events.length && pb.events[pb.idx].t <= targetT) {
      this.market.applyEvent(pb.events[pb.idx++])
    }
    this.renderAll()
  },

  /* ── 注文 ── */
  placeOrder(side) {
    const type = $('.otype.active').dataset.otype
    const qty = parseInt($('#ord-qty').value) || 0
    const priceType = $('input[name=ord-ptype]:checked').value
    const limitPrice = parseFloat($('#ord-price').value) || 0
    const r = this.engine.placeOrder({ side, type, qty, priceType, limitPrice })
    const msgEl = $('#order-msg')
    msgEl.textContent = r.msg
    msgEl.className = 'order-msg ' + (r.ok ? 'ok' : 'ng')
    this.renderAccount()
  },

  async endSession() {
    if (
      !confirm('セッションを終了して結果を記録しますか?(未決済建玉は自動決済)')
    )
      return
    this.stopPlayTimer()
    if (this.liveSource) {
      this.liveSource.stop()
      this.liveSource = null
    }
    clearInterval(this._renderTimer)
    const sum = await this.engine.endSession()
    if (sum) {
      $('#result-body').innerHTML = `
        <div class="res-grid">
          <div><label>実現損益</label><span class="v ${sum.realizedPnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${yen(sum.realizedPnl, true)}</span></div>
          <div><label>決済回数</label><span class="v">${sum.tradeCount}</span></div>
          <div><label>勝ちトレード</label><span class="v">${sum.winCount}</span></div>
          <div><label>勝率</label><span class="v">${sum.winRate}%</span></div>
        </div>
        <p style="color:var(--tx2);font-size:.8rem">${sum.realizedPnl >= 0 ? '🎉 プラスで終了!この調子で練習を続けましょう。' : '📝 マイナスで終了。エントリー根拠と損切りタイミングを振り返りましょう。'}</p>`
      $('#result-modal').classList.remove('hidden')
    } else {
      this.exitTrade()
    }
  },

  /* ── 描画 ── */
  renderAll() {
    const m = this.market
    // ヘッダー価格
    $('#trade-price').textContent = fmtPrice(m.ltp)
    if (m.ltp != null && m.openPrice != null) {
      const d = m.ltp - m.openPrice
      const el = $('#trade-diff')
      el.textContent = `${d >= 0 ? '+' : ''}${fmtPrice(Math.abs(d))} (${((d / m.openPrice) * 100).toFixed(2)}%) 始値比`
      el.className = 'price-diff ' + (d > 0 ? 'up' : d < 0 ? 'down' : 'flat')
    }
    Views.renderBoard($('#board-ladder'), m, (price) => {
      $('input[name=ord-ptype][value=limit]').checked = true
      $('#ord-price').disabled = false
      $('#ord-price').value = price
    })
    Views.renderTape($('#tape'), m.tape)
    Views.renderChart(
      $('#main-chart'),
      $('#vol-chart'),
      m,
      this.chartFrame,
      this.engine,
    )
    this.renderAccount()
  },

  renderAccount() {
    const e = this.engine
    $('#acct-cash').textContent = yen(e.cash)
    const rp = $('#acct-pnl')
    rp.textContent = yen(e.realizedPnl, true)
    rp.className =
      e.realizedPnl > 0 ? 'pnl-pos' : e.realizedPnl < 0 ? 'pnl-neg' : ''
    const up = e.unrealizedPnl()
    const ue = $('#acct-unreal')
    ue.textContent = yen(up, true)
    ue.className = up > 0 ? 'pnl-pos' : up < 0 ? 'pnl-neg' : ''
    Views.renderPositions($('#positions'), e, this.market)
    Views.renderOrders($('#open-orders'), e)
  },
}

document.addEventListener('DOMContentLoaded', () => App.init())
