/* ═══ カブコン マーケット状態 & 仮想売買エンジン ═══ */
'use strict';

/* ── マーケット状態(板/歩み値/足) ── */
class MarketState {
  constructor() { this.reset(); }
  reset() {
    this.ltp = null;         // 現在値
    this.prevLtp = null;
    this.openPrice = null;
    this.board = null;       // {asks,bids,over,under}
    this.tape = [];          // 直近歩み値 [{t,p,q,side,dir}]
    this.ticks = [];         // 全ティック [{t,p,q}]
    this.candles = new Map();// frame(sec) -> [{t,o,h,l,c,v}]
    this.vwapNum = 0; this.vwapDen = 0;
    this.dayHigh = null; this.dayLow = null;
    this.totalVol = 0;
    this.simTime = null;     // 現在のデータ時刻
  }

  applyEvent(ev) {
    this.simTime = ev.t;
    if (ev.type === 'tick') {
      const dir = this.ltp == null ? 'flat' : ev.p > this.ltp ? 'up' : ev.p < this.ltp ? 'down' : 'flat';
      this.prevLtp = this.ltp;
      this.ltp = ev.p;
      if (this.openPrice == null) this.openPrice = ev.p;
      this.dayHigh = this.dayHigh == null ? ev.p : Math.max(this.dayHigh, ev.p);
      this.dayLow = this.dayLow == null ? ev.p : Math.min(this.dayLow, ev.p);
      this.totalVol += ev.q;
      this.vwapNum += ev.p * ev.q; this.vwapDen += ev.q;
      this.tape.unshift({ t: ev.t, p: ev.p, q: ev.q, side: ev.side, dir });
      if (this.tape.length > 60) this.tape.pop();
      this.ticks.push({ t: ev.t, p: ev.p, q: ev.q });
      for (const frame of [10, 60, 300]) this._addCandle(frame, ev);
    } else if (ev.type === 'board') {
      this.board = ev;
    }
  }

  _addCandle(frame, ev) {
    if (!this.candles.has(frame)) this.candles.set(frame, []);
    const arr = this.candles.get(frame);
    const bucket = Math.floor(ev.t / (frame * 1000)) * frame * 1000;
    const last = arr[arr.length - 1];
    if (last && last.t === bucket) {
      last.h = Math.max(last.h, ev.p); last.l = Math.min(last.l, ev.p);
      last.c = ev.p; last.v += ev.q;
    } else {
      arr.push({ t: bucket, o: ev.p, h: ev.p, l: ev.p, c: ev.p, v: ev.q });
      if (arr.length > 300) arr.shift();
    }
  }

  get vwap() { return this.vwapDen ? this.vwapNum / this.vwapDen : null; }
  bestAsk() { return this.board && this.board.asks[0] ? this.board.asks[0][0] : this.ltp; }
  bestBid() { return this.board && this.board.bids[0] ? this.board.bids[0][0] : this.ltp; }
}

/* ── 仮想売買エンジン ── */
class TradingEngine {
  constructor(market) {
    this.market = market;
    this.reset();
  }
  reset(startCash = 10_000_000) {
    this.startCash = startCash;
    this.cash = startCash;
    this.realizedPnl = 0;
    this.positions = [];   // {id,type,qty,avgPrice}  type: spot|margin_long|margin_short
    this.orders = [];      // 待機指値 {id,side,type,qty,price}
    this.fills = [];       // 約定履歴(ローカル) {t,side,type,qty,price,pnl,action}
    this.session = null;
    this.onFill = null;
  }

  async startSession(mode, recordingId, symbol) {
    this.session = await api.create('sessions', {
      id: uuid(), user_id: Auth.user.id, mode,
      recording_id: recordingId || '', symbol,
      start_cash: this.startCash, end_cash: 0,
      realized_pnl: 0, trade_count: 0, win_count: 0,
      status: 'open', started_at: new Date().toISOString(), ended_at: null, note: ''
    });
    return this.session;
  }

  /* 成行/指値注文。side: buy|sell, type: spot|margin_long|margin_short */
  placeOrder({ side, type, qty, priceType, limitPrice }) {
    if (!qty || qty < 100 || qty % 100 !== 0) return { ok: false, msg: '数量は100株単位で指定してください' };
    const m = this.market;
    if (m.ltp == null) return { ok: false, msg: 'まだ価格がありません' };

    if (priceType === 'limit') {
      if (!limitPrice || limitPrice <= 0) return { ok: false, msg: '指値価格を入力してください' };
      // 即時約定判定
      if (side === 'buy' && limitPrice >= m.bestAsk()) return this._execute(side, type, qty, m.bestAsk());
      if (side === 'sell' && limitPrice <= m.bestBid()) return this._execute(side, type, qty, m.bestBid());
      this.orders.push({ id: uuid(), side, type, qty, price: limitPrice });
      return { ok: true, msg: `指値注文を受付: ${side === 'buy' ? '買' : '売'} ${qty}株 @${fmtPrice(limitPrice)}` };
    }
    // 成行: 買=最良売気配, 売=最良買気配
    const px = side === 'buy' ? m.bestAsk() : m.bestBid();
    return this._execute(side, type, qty, px);
  }

  /* ティックごとに指値約定チェック */
  checkOrders() {
    if (!this.orders.length) return;
    const m = this.market;
    const remain = [];
    for (const o of this.orders) {
      const hit = (o.side === 'buy' && m.ltp <= o.price) || (o.side === 'sell' && m.ltp >= o.price);
      if (hit) this._execute(o.side, o.type, o.qty, o.price, true);
      else remain.push(o);
    }
    this.orders = remain;
  }

  cancelOrder(id) { this.orders = this.orders.filter(o => o.id !== id); }

  _execute(side, type, qty, price, fromLimit = false) {
    const m = this.market;
    let pnl = 0, action = 'open';

    if (type === 'spot') {
      if (side === 'buy') {
        const cost = price * qty;
        if (cost > this.cash) return { ok: false, msg: '現物余力不足です' };
        this.cash -= cost;
        this._addPosition('spot', qty, price);
      } else {
        const pos = this.positions.find(p => p.type === 'spot');
        if (!pos || pos.qty < qty) return { ok: false, msg: '売却する現物がありません' };
        pnl = (price - pos.avgPrice) * qty;
        this.cash += price * qty;
        this._reducePosition(pos, qty);
        this.realizedPnl += pnl;
        action = 'close';
      }
    } else if (type === 'margin_long') {
      if (side === 'buy') {
        this._addPosition('margin_long', qty, price); action = 'open';
      } else {
        const pos = this.positions.find(p => p.type === 'margin_long');
        if (!pos || pos.qty < qty) return { ok: false, msg: '返済する買建玉がありません' };
        pnl = (price - pos.avgPrice) * qty;
        this._reducePosition(pos, qty);
        this.realizedPnl += pnl; this.cash += pnl;
        action = 'close';
      }
    } else if (type === 'margin_short') {
      if (side === 'sell') {
        this._addPosition('margin_short', qty, price); action = 'open';
      } else {
        const pos = this.positions.find(p => p.type === 'margin_short');
        if (!pos || pos.qty < qty) return { ok: false, msg: '返済する売建玉がありません' };
        pnl = (pos.avgPrice - price) * qty;
        this._reducePosition(pos, qty);
        this.realizedPnl += pnl; this.cash += pnl;
        action = 'close';
      }
    }

    const fill = { t: m.simTime || Date.now(), side, type, qty, price, pnl, action };
    this.fills.push(fill);
    this._saveTrade(fill);
    if (this.onFill) this.onFill(fill);
    const label = `${type === 'spot' ? '現物' : type === 'margin_long' ? '信用買' : '信用売'} ${side === 'buy' ? '買' : '売'} ${qty}株 @${fmtPrice(price)} 約定` +
      (action === 'close' ? `(損益 ${yen(pnl, true)})` : '');
    return { ok: true, msg: (fromLimit ? '指値約定: ' : '') + label };
  }

  _addPosition(type, qty, price) {
    const pos = this.positions.find(p => p.type === type);
    if (pos) {
      pos.avgPrice = (pos.avgPrice * pos.qty + price * qty) / (pos.qty + qty);
      pos.qty += qty;
    } else {
      this.positions.push({ id: uuid(), type, qty, avgPrice: price });
    }
  }
  _reducePosition(pos, qty) {
    pos.qty -= qty;
    if (pos.qty <= 0) this.positions = this.positions.filter(p => p !== pos);
  }

  unrealizedPnl() {
    const m = this.market;
    if (m.ltp == null) return 0;
    return this.positions.reduce((sum, p) => {
      if (p.type === 'margin_short') return sum + (p.avgPrice - m.ltp) * p.qty;
      return sum + (m.ltp - p.avgPrice) * p.qty;
    }, 0);
  }

  closeAll() {
    const results = [];
    for (const p of [...this.positions]) {
      const side = p.type === 'margin_short' ? 'buy' : 'sell';
      results.push(this._execute(side, p.type, p.qty, side === 'buy' ? this.market.bestAsk() : this.market.bestBid()));
    }
    return results;
  }

  async _saveTrade(fill) {
    if (!this.session) return;
    try {
      await api.create('trades', {
        id: uuid(), user_id: Auth.user.id, session_id: this.session.id,
        mode: this.session.mode, symbol: this.session.symbol,
        side: fill.side, trade_type: fill.type, action: fill.action,
        qty: fill.qty, price: fill.price,
        exec_time: new Date(fill.t).toISOString(),
        pnl: fill.pnl, memo: ''
      });
    } catch (e) { console.error('trade save failed', e); }
  }

  async endSession() {
    if (!this.session) return null;
    // 未決済は自動決済
    this.closeAll();
    const closes = this.fills.filter(f => f.action === 'close');
    const wins = closes.filter(f => f.pnl > 0).length;
    const s = await api.patch('sessions', this.session.id, {
      status: 'closed',
      end_cash: this.cash,
      realized_pnl: this.realizedPnl,
      trade_count: closes.length,
      win_count: wins,
      ended_at: new Date().toISOString()
    });
    const summary = {
      realizedPnl: this.realizedPnl, tradeCount: closes.length, winCount: wins,
      winRate: closes.length ? Math.round(wins / closes.length * 100) : 0,
      fills: this.fills
    };
    this.session = null;
    return summary;
  }
}
