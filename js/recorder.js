/* ═══ カブコン 株価レコーダー(④) ═══
 * データソースからのイベントをメモリにバッファし、
 * 500イベントごとに tick_chunks テーブルへチャンク保存する。
 */
'use strict';

const CHUNK_SIZE = 500;

class Recorder {
  constructor() {
    this.active = false;
    this.recording = null;   // recordings行
    this.source = null;
    this.buffer = [];
    this.tickCount = 0;
    this.boardCount = 0;
    this.chunkSeq = 0;
    this.startPrice = null;
    this.lastPrice = null;
    this.startedAt = 0;
    this.onUpdate = null;    // UI更新コールバック(ev)
    this._saving = Promise.resolve();
    this._saveErrors = [];
  }

  async start({ sourceKind, sourceOpts, symbol, symbolName, recDate }) {
    if (this.active) throw new Error('既に記録中です');
    const rec = await api.create('recordings', {
      id: uuid(),
      user_id: Auth.user.id,
      name: `${symbol} ${symbolName} ${recDate}`,
      symbol, symbol_name: symbolName,
      source: sourceKind === 'bridge' ? 'moomoo' : sourceKind,
      rec_date: recDate,
      interval_ms: 0,
      tick_count: 0, chunk_count: 0,
      start_price: 0, end_price: 0,
      status: 'recording', meta: '{}'
    });
    this.recording = rec;
    this.buffer = [];
    this.tickCount = 0; this.boardCount = 0; this.chunkSeq = 0;
    this.startPrice = null; this.lastPrice = null;
    this.startedAt = Date.now();
    this.active = true;
    this._saveErrors = [];

    this.source = createSource(sourceKind, { ...sourceOpts, symbol });
    this.source.onEvent = (ev) => this._onEvent(ev);
    this.source.onError = (err) => { if (this.onUpdate) this.onUpdate({ type: 'error', message: err.message }); };
    if (this.source instanceof JQuantsSource) {
      this.source.onDone = () => { if (this.onUpdate) this.onUpdate({ type: 'gen-done' }); };
    }
    try {
      await this.source.start();
    } catch (e) {
      // ソース起動失敗: 作りかけの記録行を削除し、元のエラーをそのまま表示
      this.active = false;
      try { await api.remove('recordings', rec.id); } catch (_) { /* ignore */ }
      throw e;
    }
    return rec;
  }

  _onEvent(ev) {
    if (!this.active) return;
    this.buffer.push(ev);
    if (ev.type === 'tick') {
      this.tickCount++;
      if (this.startPrice == null) this.startPrice = ev.p;
      this.lastPrice = ev.p;
    } else if (ev.type === 'board') {
      this.boardCount++;
    }
    if (this.buffer.length >= CHUNK_SIZE) this._flush();
    if (this.onUpdate) this.onUpdate(ev);
  }

  _flush() {
    if (!this.buffer.length) return;
    const chunk = this.buffer;
    this.buffer = [];
    const seq = this.chunkSeq++;
    // 直列化して保存(順序保証)
    this._saving = this._saving.then(() =>
      api.create('tick_chunks', {
        id: uuid(),
        recording_id: this.recording.id,
        seq,
        tick_count: chunk.length,
        data: JSON.stringify(chunk)
      })
    ).catch(e => {
      console.error('chunk save failed', e);
      this._saveErrors.push(`chunk#${seq}: ${e.message}`);
    });
  }

  async stop() {
    if (!this.active) return null;
    this.active = false;
    if (this.source) this.source.stop();
    this._flush();
    await this._saving;
    if (this._saveErrors.length) {
      // チャンク保存に失敗があった場合は明示的にエラーにする
      const msg = this._saveErrors.slice(0, 3).join(' / ');
      await api.patch('recordings', this.recording.id, { status: 'error', meta: JSON.stringify({ errors: this._saveErrors }) }).catch(() => {});
      this.recording = null; this.source = null;
      throw new Error('チャンク保存失敗: ' + msg);
    }
    const rec = await api.patch('recordings', this.recording.id, {
      status: 'done',
      tick_count: this.tickCount,
      chunk_count: this.chunkSeq,
      start_price: this.startPrice || 0,
      end_price: this.lastPrice || 0,
      interval_ms: this.tickCount > 1 ? Math.round((Date.now() - this.startedAt) / this.tickCount) : 0
    });
    const done = this.recording;
    this.recording = null;
    this.source = null;
    return rec || done;
  }
}

/* 記録の全イベントをロード(リプレイ用) */
async function loadRecordingEvents(recordingId) {
  const chunks = await api.listAll('tick_chunks', { search: recordingId });
  const mine = chunks.filter(c => c.recording_id === recordingId && !c.deleted);
  mine.sort((a, b) => a.seq - b.seq);
  let events = [];
  for (const c of mine) {
    try { events = events.concat(JSON.parse(c.data)); } catch (e) { /* skip broken */ }
  }
  events.sort((a, b) => a.t - b.t);
  return events;
}

const recorder = new Recorder();
