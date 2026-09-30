# 運用手順

## 構成と起動

`infra/compose.yaml` はこのプロジェクト専用。既存サーバーの他サービスを変更しない。
Web(Nginx)、API、ワーカー、PostgreSQL18、日次バックアップを個別コンテナで運用する。
全サービスは `restart: unless-stopped`、ログは10MB×3世代。DBはnamed volumeに永続化。
API/ワーカーは起動時にチェックサム付きSQLマイグレーションを適用する。
同時起動時はDBロックで重複適用しない。

```sh
docker compose --env-file .env -f infra/compose.yaml up -d --build
docker compose --env-file .env -f infra/compose.yaml ps
docker compose --env-file .env -f infra/compose.yaml logs --tail=50 worker
curl --fail http://127.0.0.1:4381/healthz
```

開発では全 `up` 操作に `-f infra/compose.dev.yaml` を追加する。DBの公開ポートは127.0.0.1:55439のみ。
ホストから実行するDBスクリプトは `.env` の `DATABASE_URL` を使用する。
本番構成でDBポートを開かずに実行する場合は、APIコンテナ内で `./node_modules/.bin/tsx scripts/<script>.ts` を実行する。
`backup:verify` は現時点では開発用localhost接続で実行する。検証中も実DBの書込を止めず、同一エクスポートスナップショットと復元DBを比較する。

## 管理画面

`/admin` で `.env` の `ADMIN_TOKEN` を入力する。キーはブラウザのメモリのみで保持し、永続ストレージへ保存しない。
管理APIは全操作にBearer認証を要求する。外部公開時は必ずHTTPSを使用する。

- 対象グループの追加・収集停止/再開。停止後も過去の観測を残す。既に実行中のジョブは完了する場合がある。
- TicketDive公式ページURLの追加。対応アーティストは12時間ごとに公式公演ページも自動発見。
- 公式公演との対応づけが曖昧なものは、日付・時刻・会場・券種を元ページで確認し、根拠を記入して確認または却下。
- 登録済み公式情報の対応づけも取り消し・再確認できる。各判断の根拠は追記型の履歴に残す。新しい公式情報が取得済みの場合は古い版を承認できない。
- 取得失敗・公演発見失敗・制限・公式ページのエラーを確認。

`MAX_ACTIVE_EVENTS` は初期値5。対象拡大はこの上限とグループ設定で行う。
通知は公開画面内の運用通知・管理画面・JSONログ。メールやチャットへの外部通知先は設定していない。
ワーカーは1分ごとに生存確認、未解決の取得失敗、90分以上の観測停止、アクセス制限、公式取得失敗を監視する。
API自体が停止した場合は画面の取得エラーとDocker healthcheckで確認する。外部死活監視は未接続。

## 観測を再分類・再集計

```sh
npm run reprocess
npm run reaggregate
```

再分類は `NORMALIZATION_VERSION` ごとに未処理の観測を処理し、原観測を変更しない。
解析方法を変更する場合はバージョンを上げる。再集計は保存済み観測から表示用集計を再構築する。
取得時の解釈を変えるパーサー改修は過去HTMLが必要とは限らないため、保存した最小原文から再現できる範囲を検証する。
元HTMLは常時全保存しない。

## 制限・障害対応

403/401/認証リダイレクト/アクセス確認画面は取得元を停止。429はRetry-Afterに従い最低1時間待機する。
制限の回避は行わない。原因を調べ、許可が確認できるまで手動解除しない。
公開公演へのリダイレクトは失敗として扱い、成約と見なさない。

取得失敗はジョブが最大2回再試行。保存済み時間枠は重複記録しない。
HTML構造変更や総件数の不一致は部分取得とし、その観測では掲載終了を判定しない。
復旧後に `npm run readiness` と画面の観測履歴を確認する。失われた時間帯を後日の価格で埋めない。

## バックアップと復元

バックアップコンテナが起動直後と以降24時間ごとにカスタム形式 `pg_dump` を保存する。
失敗時は30分後に再試行。14日保持。書込中は `.partial`、正常終了したもののみ `.dump`。
保存先は `.local/backups/`、所有者限定パーミッション。26時間以内のバックアップがなければhealthcheck失敗。
同一SSD内のバックアップであり、ディスク故障対策となる別媒体コピーは未設定。

```sh
# 即時バックアップ
docker compose --env-file .env -f infra/compose.yaml exec backup sh /scripts/backup-once.sh
# 別DBへ実際に復元し、全publicテーブルの件数と行内容のダイジェストを比較
npm run backup:verify
```

検証スクリプトは毎回一意の復元用DBを作り、比較後にそのDBのみ削除する。元DBと既存volumeは変更しない。
検証記録は `.local/evidence/backup-verification.json`、使用したdumpも保持する。
災害復旧時は新しい空DB/volumeへdumpを復元し、検証してから接続先を切り替える。
既存DBへ上書きする `pg_restore --clean` や `docker compose down -v` は通常手順に含めない。
`.env` の秘密値はdumpに含まれないため、別に安全な場所で保管する。

## 公開の条件

現状はlocalhost限定。既存ホームサーバーの公開用リバースプロキシ/トンネルから `http://127.0.0.1:4381` へ接続する。
DB・APIの内部ポートは公開しない。新しいドメインのDNS・HTTPS・公開経路の追加先は未決定。
既存Genesiaや他サービスの経路を上書きしない。

公開前に `docs/verification.md` の未完了項目を解消し、48時間以上の実稼働と欠測・部分取得を確認する。
公開URLでトップ、詳細URL直アクセス、API、管理APIの未認証拒否、スマートフォン表示、HTTPSを検証する。
取得・再利用の条件と公開項目を再確認し、出品者のプロフィール・画像・説明全文を公開しない。
