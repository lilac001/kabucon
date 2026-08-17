/* ═══ カブコン 描画(板・チャート・歩み値) ═══ */
'use strict';

const Views = {
  /* ── 板 ── */
  renderBoard(el, market, onPriceClick) {
    const b = market.board;
    if (!b) { el.innerHTML = '<p class="empty">板情報待ち…</p>'; return; }
    const maxQ = Math.max(...b.asks.map(a => a[1]), ...b.bids.map(x => x[1]), 1);
    let html = `<div class="bl-over"><span>OVER ${b.over.toLocaleString()}</span><span></span></div>`;
    html += `<div class="bl-head"><span class="h-ask">売数量</span><span>値段</span><span class="h-bid">買数量</span></div>`;
    // 売り気配は高い方から
    const asks = [...b.asks].sort((x, y) => y[0] - x[0]);
    for (const [p, q] of asks) {
      const w = Math.min(100, q / maxQ * 100);
      html += `<div class="bl-row" data-price="${p}">
        <div class="bl-ask"><div class="bl-bar" style="width:${w}%"></div><span class="bl-qty">${q.toLocaleString()}</span></div>
        <div class="bl-price">${fmtPrice(p)}</div>
        <div class="bl-bid"></div></div>`;
    }
    // 現在値行
    html += `<div class="bl-row"><div class="bl-ask"></div><div class="bl-price ltp">${fmtPrice(market.ltp)}</div><div class="bl-bid"></div></div>`;
    for (const [p, q] of b.bids) {
      const w = Math.min(100, q / maxQ * 100);
      html += `<div class="bl-row" data-price="${p}">
        <div class="bl-ask"></div>
        <div class="bl-price">${fmtPrice(p)}</div>
        <div class="bl-bid"><div class="bl-bar" style="width:${w}%"></div><span class="bl-qty">${q.toLocaleString()}</span></div></div>`;
    }
    html += `<div class="bl-over"><span></span><span>UNDER ${b.under.toLocaleString()}</span></div>`;
    el.innerHTML = html;
    el.querySelectorAll('.bl-row[data-price]').forEach(row => {
      row.addEventListener('click', () => onPriceClick(parseFloat(row.dataset.price)));
    });
  },

  /* ── 歩み値 ── */
  renderTape(el, tape) {
    el.innerHTML = tape.map(t =>
      `<div class="t-${t.dir}"><span class="t-time">${fmtTime(t.t)}</span>${fmtPrice(t.p)}<span class="t-qty">${t.q.toLocaleString()}</span></div>`
    ).join('');
  },

  /* ── ローソク足チャート(canvas直描画) ── */
  renderChart(canvas, volCanvas, market, frame, engine) {
    const candles = market.candles.get(frame) || [];
    const ctx = this._setupCanvas(canvas);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);
    if (candles.length < 2) {
      ctx.fillStyle = '#5a6378'; ctx.font = '13px Inter';
      ctx.fillText('データ待ち…', W / 2 - 34, H / 2);
      if (volCanvas) { const v = this._setupCanvas(volCanvas); v.clearRect(0, 0, volCanvas.clientWidth, volCanvas.clientHeight); }
      return;
    }
    const view = candles.slice(-80);
    const padR = 58, padT = 10, padB = 18;
    const cw = (W - padR) / view.length;
    let lo = Math.min(...view.map(c => c.l)), hi = Math.max(...view.map(c => c.h));
    const vwap = market.vwap;
    if (vwap) { lo = Math.min(lo, vwap); hi = Math.max(hi, vwap); }
    const span = Math.max(hi - lo, tickSize(hi) * 4);
    lo -= span * 0.06; hi += span * 0.06;
    const y = p => padT + (hi - p) / (hi - lo) * (H - padT - padB);

    // グリッド + 右軸
    ctx.strokeStyle = '#1a2030'; ctx.fillStyle = '#5a6378'; ctx.font = '10px JetBrains Mono';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const p = lo + (hi - lo) * i / 4;
      const yy = y(p);
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
      ctx.fillText(fmtPrice(roundToTick(p)), W - padR + 5, yy + 3);
    }

    // MA計算
    const closes = candles.map(c => c.c);
    const ma = (n, idxInView) => {
      const gi = candles.length - view.length + idxInView;
      if (gi < n - 1) return null;
      let s = 0; for (let k = gi - n + 1; k <= gi; k++) s += closes[k];
      return s / n;
    };

    // ローソク
    for (let i = 0; i < view.length; i++) {
      const c = view[i];
      const x = i * cw + cw / 2;
      const up = c.c >= c.o;
      ctx.strokeStyle = up ? '#ff5a68' : '#28d59a';
      ctx.fillStyle = up ? '#ff5a68' : '#28d59a';
      ctx.beginPath(); ctx.moveTo(x, y(c.h)); ctx.lineTo(x, y(c.l)); ctx.stroke();
      const bw = Math.max(2, cw * 0.6);
      const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
      ctx.fillRect(x - bw / 2, top, bw, Math.max(1, bot - top));
    }

    // MA5 / MA25 / VWAP ライン
    const lines = [[5, '#4f8cff'], [25, '#b565ff']];
    for (const [n, color] of lines) {
      ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.beginPath();
      let started = false;
      for (let i = 0; i < view.length; i++) {
        const v = ma(n, i);
        if (v == null) continue;
        const x = i * cw + cw / 2;
        if (!started) { ctx.moveTo(x, y(v)); started = true; } else ctx.lineTo(x, y(v));
      }
      ctx.stroke();
    }
    if (vwap) {
      ctx.strokeStyle = '#ffb020'; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(0, y(vwap)); ctx.lineTo(W - padR, y(vwap)); ctx.stroke();
      ctx.setLineDash([]);
    }

    // 現在値ライン
    if (market.ltp != null) {
      const yy = y(market.ltp);
      ctx.strokeStyle = '#dbe2f0'; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(W - padR, yy); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = market.ltp >= (market.openPrice || market.ltp) ? '#ff5a68' : '#28d59a';
      ctx.fillRect(W - padR + 1, yy - 8, padR - 2, 16);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 10px JetBrains Mono';
      ctx.fillText(fmtPrice(market.ltp), W - padR + 5, yy + 3);
    }

    // 建玉平均線
    if (engine) {
      for (const p of engine.positions) {
        const yy = y(p.avgPrice);
        if (yy < padT || yy > H - padB) continue;
        ctx.strokeStyle = p.type === 'margin_short' ? '#22c58b' : '#ff4d5e';
        ctx.setLineDash([6, 4]); ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(W - padR, yy); ctx.stroke(); ctx.setLineDash([]);
      }
    }

    // 出来高
    if (volCanvas) {
      const vc = this._setupCanvas(volCanvas);
      const VW = volCanvas.clientWidth, VH = volCanvas.clientHeight;
      vc.clearRect(0, 0, VW, VH);
      const maxV = Math.max(...view.map(c => c.v), 1);
      for (let i = 0; i < view.length; i++) {
        const c = view[i];
        const x = i * cw + cw / 2;
        const bw = Math.max(2, cw * 0.6);
        const h = Math.max(1, c.v / maxV * (VH - 6));
        vc.fillStyle = c.c >= c.o ? 'rgba(255,90,104,.55)' : 'rgba(40,213,154,.55)';
        vc.fillRect(x - bw / 2, VH - h, bw, h);
      }
    }
  },

  _setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  },

  /* ── スパークライン(レコーダーモニター) ── */
  renderSpark(canvas, prices) {
    const ctx = this._setupCanvas(canvas);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);
    if (prices.length < 2) return;
    const view = prices.slice(-400);
    const lo = Math.min(...view), hi = Math.max(...view);
    const span = Math.max(hi - lo, 1);
    ctx.strokeStyle = '#4f8cff'; ctx.lineWidth = 1.5; ctx.beginPath();
    view.forEach((p, i) => {
      const x = i / (view.length - 1) * W;
      const y = 6 + (hi - p) / span * (H - 12);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  },

  /* ── 建玉一覧 ── */
  renderPositions(el, engine, market) {
    if (!engine.positions.length) { el.innerHTML = '<p class="empty">建玉なし</p>'; return; }
    const tagMap = { spot: ['tag-spot', '現物'], margin_long: ['tag-long', '信用買'], margin_short: ['tag-short', '信用売'] };
    el.innerHTML = engine.positions.map(p => {
      const upnl = p.type === 'margin_short' ? (p.avgPrice - market.ltp) * p.qty : (market.ltp - p.avgPrice) * p.qty;
      const cls = upnl >= 0 ? 'pnl-pos' : 'pnl-neg';
      const [tagCls, tagLabel] = tagMap[p.type];
      return `<div class="pos-row" data-pid="${p.id}">
        <div class="pos-head"><span><span class="tag ${tagCls}">${tagLabel}</span> ${p.qty}株</span><span class="${cls}">${yen(upnl, true)}</span></div>
        <div class="pos-sub"><span>平均 ${fmtPrice(p.avgPrice)}</span><span>現在 ${fmtPrice(market.ltp)}</span></div>
        <button class="btn btn-ghost btn-xs btn-close-pos" data-pid="${p.id}">決済</button>
      </div>`;
    }).join('');
  },

  renderOrders(el, engine) {
    if (!engine.orders.length) { el.innerHTML = '<p class="empty">なし</p>'; return; }
    el.innerHTML = engine.orders.map(o =>
      `<div class="oo-row" style="display:flex;justify-content:space-between;align-items:center">
        <span>${o.side === 'buy' ? '<span style="color:var(--buy)">買</span>' : '<span style="color:var(--sell)">売</span>'} ${o.qty}株 @${fmtPrice(o.price)}</span>
        <button class="btn btn-ghost btn-xs btn-cancel-order" data-oid="${o.id}">取消</button>
      </div>`).join('');
  }
};
