# カブコン (kabucon)

デイトレード練習・サポートのための統合ツール。日本国内株式対応。

## 🎯 プロジェクト構成(4本柱)

| #   | 機能                                                       | 状態                                    |
| --- | ---------------------------------------------------------- | --------------------------------------- |
| ④   | **株価レコーダー** — 板・歩み値をリアルタイム記録          | ✅ 実装済                               |
| ①   | **練習アプリ** — 記録データをリプレイし仮想売買(現物/信用) | ✅ 実装済                               |
| ②   | **デイトレサポート** — ライブ表示+AI分析+仮想売買          | ✅ 実装済(分析はローカルルールエンジン) |
| ③   | **株取引アプリ** — kabu.com/moomoo実売買連携               | ⏳ 後回し(UIスイッチのみ配置済)         |

## ✅ 実装済み機能

### 認証

- 簡易ログイン/新規登録(SHA-256ハッシュ、sessionStorage保持)
- ※本番公開時は Hosted Deploy のアクセス制御(authenticated/allowlist)併用を推奨

### ④ 株価レコーダー

- データソース4種:
  - **内蔵シミュレーター**: 擬似板・歩み値生成(トレンド/平均回帰/大口出来高)
  - **kabu STATION API**: `localhost:18080` トークン取得→銘柄登録→PUSH WebSocket受信
  - **汎用WSブリッジ**: `ws://localhost:8765` — moomoo OpenD等を共通JSONに中継するサーバに接続
  - **J-Quants**: 過去日付を指定し日足OHLCVから場中ティックを擬似再構成(Pages Function経由のAPI v2取得 or CSV貼付)
- 共通イベント形式 `{t,type:'tick',p,q,side}` / `{t,type:'board',asks,bids,over,under}`
- 500イベント毎にチャンク保存(tick_chunks)、記録モニター(現在値/スパークライン/歩み値)

### トレード画面(楽天証券「武蔵」参考の3カラム)

- **板(気配値ラダー)**: 10本気配+OVER/UNDER、数量バー、クリックで指値セット
- **チャート**: ローソク足(10秒/1分/5分足)、MA5/MA25/VWAP、建玉平均線、出来高、canvas自前描画
- **歩み値**: ティック方向色分け
- **注文パネル**: 現物/信用買/信用売 × 成行/指値、100株単位、余力・実現損益・評価損益
- **建玉管理**: 個別決済/全決済、待機指値の約定監視・取消

### ① 練習モード(青)

- 記録データのリプレイ再生(再生/一時停止/シーク/速度×1〜×10)
- クイックスタート(シミュレーターで即ライブ練習)
- セッション終了時に結果(損益/勝率)をモーダル表示し記録

### ② サポートモード(紫)

- ライブデータ表示しつつAIアシスタントパネルが3秒毎に市況分析
  - VWAP乖離/モメンタム/板需給バイアス/レンジ位置からシグナル(BUY/SELL/NEUTRAL)
  - 建玉への利確・損切りアドバイス
- ※静的サイトのためLLM API直呼びはせず決定論的ルールエンジンで実装(差替え可能な構造)

### 成績画面

- 累計損益/セッション数/決済回数/勝率、セッション履歴一覧

## 🌐 エントリーポイント

- `index.html` — SPA(ログイン→ホーム[レコーダー/ライブラリ/成績]→トレード画面)

## 🗄 データモデル(Table API / Hosted DeployではD1)

| テーブル      | 用途                                       |
| ------------- | ------------------------------------------ |
| `users`       | 簡易認証ユーザー                           |
| `recordings`  | 記録メタ(銘柄/ソース/日付/ティック数/状態) |
| `tick_chunks` | ティック・板イベントの500件チャンク(JSON)  |
| `sessions`    | 練習/サポートセッション(損益/勝率)         |
| `trades`      | 個別約定履歴                               |
| `settings`    | ユーザー設定(将来用)                       |

## 🔌 外部連携メモ

- **kabu STATION API**: kabuステーション起動+API設定有効化が必要。ブラウザから `http://localhost:18080` へ直接アクセスするため、**httpsで公開した場合はMixed Content制限で接続不可 → localhost運用またはブリッジ経由を推奨**
- **moomoo**: OpenD(ローカルゲートウェイ)はブラウザから直接繋げないため、共通イベントJSONを流す中継WSサーバ(ws://localhost:8765)方式。ブリッジ仕様: 接続後 `{cmd:'subscribe',symbol,market:'JP'}` を受け、共通イベントJSONを送信するだけ
- **J-Quants**: 日足OHLCVを `functions/jquants/daily.js` の同一オリジン中継経由でAPI v2から取得します。画面で入力したIDトークンのほか、`JQUANTS_TOKEN` 環境変数を利用できます。静的HTTPサーバーではFunctionが動作しないため、`wrangler pages dev` またはCloudflare Pagesで起動してください。CSV貼付も利用できます。

## ⏳ 未実装・今後

1. ③実取引モード(kabu.com発注API / moomoo連携)
2. moomooブリッジサーバ実装(Node.js, リポジトリ同梱予定)
3. J-Quantsのリフレッシュトークン自動更新
4. 逆指値(ストップ)注文、OCO
5. 板の価格帯別出来高(価格帯別約定量)表示
6. 練習リプレイの「ここから開始」ブックマーク
7. LLM APIによる本格AI分析(サーバレスFunctions経由)

## 🚀 デプロイ

### A. Genspark環境

- Publishタブから公開(プレビューDB使用)
- Hosted Deploy(Cloudflare Workers + D1)対応済み

### B. 自分のCloudflareアカウント (kabucon.pages.dev)

リポジトリに **Pages Functions製のTable API互換レイヤー** (`functions/tables/[[route]].js`)を同梱済み。GitHubへpushしてPagesに接続すればそのまま動く。

手順:

1. **GitHubへpush**
   ```bash
   git init && git add -A && git commit -m "kabucon initial"
   git remote add origin https://github.com/<あなたのID>/kabucon.git
   git push -u origin main
   ```
2. **D1作成 + スキーマ適用**(要 Node.js / wrangler)
   ```bash
   npx wrangler login
   npx wrangler d1 create kabucon-db        # 出力されたdatabase_idをwrangler.tomlに記入
   npx wrangler d1 execute kabucon-db --remote --file=schema.sql
   ```
3. **Cloudflareダッシュボード → Workers & Pages → Create → Pages → Connect to Git** で本リポジトリを選択
   - プロジェクト名: `kabucon` (→ kabucon.pages.dev)
   - Build command: なし / Output directory: `/`
4. **Pages → Settings → Bindings → D1 database** で 変数名 `DB` に `kabucon-db` を紐付け → 再デプロイ

ローカル開発:

1. `.dev.vars.example` を `.dev.vars` にコピーし、`JQUANTS_TOKEN` にJ-QuantsのIDトークンを設定します。`.dev.vars` はGit管理対象外です。
2. 以下で起動します。

```powershell
Copy-Item .dev.vars.example .dev.vars
npx wrangler pages dev .
```

`wrangler pages dev` のD1バインディングはローカルD1エミュレーターです。Cloudflare上の本番D1をそのまま使うローカル実行はできないため、本番データを使う場合はCloudflare PagesへデプロイしたURLを開いてください。ローカルD1の初期化は以下で行えます。

```powershell
npx wrangler d1 execute kabucon-db --local --file=schema.sql
```

本番のJ-QuantsトークンはPages Secretとして設定します。

```powershell
npx wrangler pages secret put JQUANTS_TOKEN --project-name kabucon
```

※ 自アカウント版のデータは `records` 汎用テーブル(table_name + id + JSON)1本に全テーブルを格納する設計。

## ⚠️ セキュリティ

- チャットに貼られたCloudflare APIトークン等は**使用していません。必ず失効・再発行してください**
