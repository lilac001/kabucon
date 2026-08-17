/* ═══ カブコン AI分析(②サポートモード) ═══
 * ローカルのテクニカル指標ベースのルールエンジンで市況コメントと
 * 売買シグナルを生成する。(静的サイトのためLLM API直呼びはせず、
 * 決定論的な分析ロジックで代替。将来的にAI APIへ差し替え可能な構造)
 */
'use strict';

const Analyst = {
  lastUpdate: 0,

  analyze(market, engine) {
    const m = market;
    if (m.ltp == null || m.ticks.length < 20) {
      return { signal: 'neutral', comment: 'データ蓄積中です。しばらくお待ちください。', metrics: {} };
    }
    const ticks = m.ticks;
    const last = m.ltp;
    const vwap = m.vwap;

    // 直近モメンタム(60ティック)
    const n = Math.min(60, ticks.length - 1);
    const past = ticks[ticks.length - 1 - n].p;
    const mom = (last - past) / past * 100;

    // ティック内訳(直近40)
    const recent = m.tape.slice(0, 40);
    const upTicks = recent.filter(t => t.dir === 'up').length;
    const downTicks = recent.filter(t => t.dir === 'down').length;

    // 板の需給
    let boardBias = 0;
    if (m.board) {
      const askSum = m.board.asks.reduce((s, a) => s + a[1], 0);
      const bidSum = m.board.bids.reduce((s, b) => s + b[1], 0);
      boardBias = (bidSum - askSum) / (bidSum + askSum); // + なら買い優勢
    }

    // VWAP乖離
    const vwapDev = vwap ? (last - vwap) / vwap * 100 : 0;

    // 日中レンジ位置 (0=安値, 1=高値)
    const rangePos = (m.dayHigh !== m.dayLow) ? (last - m.dayLow) / (m.dayHigh - m.dayLow) : 0.5;

    // スコアリング
    let score = 0;
    score += Math.max(-2, Math.min(2, mom * 2));
    score += boardBias * 2;
    score += (upTicks - downTicks) / 40 * 2;
    if (vwapDev > 0.15) score += 0.5; else if (vwapDev < -0.15) score -= 0.5;

    let signal = 'neutral', head;
    if (score > 1.6) { signal = 'buy'; head = '📈 買い優勢の地合いです。'; }
    else if (score < -1.6) { signal = 'sell'; head = '📉 売り優勢の地合いです。'; }
    else { signal = 'neutral'; head = '➖ 方向感に欠ける展開です。'; }

    const parts = [head];
    if (Math.abs(vwapDev) > 0.05) {
      parts.push(`現在値はVWAP(${fmtPrice(roundToTick(vwap))})を${vwapDev > 0 ? '上回って推移しており、買い方有利' : '下回っており、売り方有利'}な位置です(乖離${vwapDev.toFixed(2)}%)。`);
    }
    if (Math.abs(boardBias) > 0.15) {
      parts.push(`板は${boardBias > 0 ? '買い注文が厚く下値が固い' : '売り注文が厚く上値が重い'}状況(需給バイアス${(boardBias * 100).toFixed(0)}%)。`);
    }
    if (rangePos > 0.85) parts.push('本日高値圏です。ブレイクか反落かの分岐点、高値掴みに注意。');
    else if (rangePos < 0.15) parts.push('本日安値圏です。逆張りは下げ止まり確認後が無難です。');
    if (Math.abs(mom) > 0.3) {
      parts.push(`直近の勢いは${mom > 0 ? '上方向' : '下方向'}(${mom.toFixed(2)}%/直近${n}ティック)。`);
    }

    // 建玉アドバイス
    if (engine && engine.positions.length) {
      const upnl = engine.unrealizedPnl();
      if (upnl > 0 && ((signal === 'sell' && engine.positions.some(p => p.type !== 'margin_short')) || (signal === 'buy' && engine.positions.some(p => p.type === 'margin_short')))) {
        parts.push('⚠️ 含み益ポジションに逆行シグナル。利益確定を検討してください。');
      } else if (upnl < -30000) {
        parts.push('⚠️ 含み損が拡大中です。損切りラインを確認してください。');
      }
    }

    return {
      signal,
      comment: parts.join(' '),
      metrics: {
        'VWAP乖離': vwapDev.toFixed(2) + '%',
        'モメンタム': mom.toFixed(2) + '%',
        '板バイアス': (boardBias * 100).toFixed(0) + '%',
        'レンジ位置': (rangePos * 100).toFixed(0) + '%'
      }
    };
  },

  render(market, engine) {
    const now = Date.now();
    if (now - this.lastUpdate < 3000) return; // 3秒ごと
    this.lastUpdate = now;
    const r = this.analyze(market, engine);
    const sigEl = $('#ai-signal');
    sigEl.textContent = r.signal === 'buy' ? 'BUY寄り' : r.signal === 'sell' ? 'SELL寄り' : 'NEUTRAL';
    sigEl.className = 'ai-signal sig-' + r.signal;
    $('#ai-comment').textContent = r.comment;
    $('#ai-metrics').innerHTML = Object.entries(r.metrics)
      .map(([k, v]) => `<div><label>${k}</label><span>${v}</span></div>`).join('');
  }
};
