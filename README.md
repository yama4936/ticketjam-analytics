# Ticket Observatory

ヒロインズの公演について、出品価格・整理番号・掲載状態を毎時観測する分析サイト。
React / Vite、Fastify、独立Node.jsワーカー、pg-boss、PostgreSQL、Docker Composeで構成しています。

公演発見、履歴保存、価格・枚数・番号帯・公式券種による分析、公演間比較、公式情報の照合管理、運用通知、日次バックアップを実装しています。
成約を明示的に識別できる公開情報は未確認のため、消えた出品を「売れた」と扱いません。

**公開URL: https://tickets.yama.asia**。管理画面は `/admin`、管理キーが必要です。
公開HTTPSと認証を検証済み。48時間以上の継続稼働は検証中です。ローカル画面は http://127.0.0.1:4381 。

- [要件](docs/requirements.md)
- [検証記録・残作業](docs/verification.md)
- [収集と判定の方針](docs/collection-policy.md)
- [起動・管理・復旧の手順](docs/operations.md)

## 起動

Node.js 22.12以上、Docker Composeを使用します。

```sh
npm ci
cp .env.example .env
# .envのPOSTGRES_PASSWORDとDATABASE_URLを同じランダム値に変更
# ADMIN_TOKENは別のランダム値に変更
mkdir -p .local/backups
chmod 700 .local/backups
chmod 600 .env
docker compose --env-file .env -f infra/compose.yaml up -d --build
```

マイグレーションはAPIとワーカーが自動実行します。Webのみlocalhost:4381に公開し、DBは本番構成ではポートを公開しません。
開発時は常に `-f infra/compose.dev.yaml` も指定するとDBをlocalhost:55439から操作できます。開発と本番のCompose指定を混在させないでください。

```sh
npm run typecheck
npm test
npm run build
```

通常の `npm test` はDB依存テストをスキップします。専用テストDBを作り、`TEST_DATABASE_URL` を設定すると、実PostgreSQLでの履歴・重複・状態遷移・取得制限・公式情報更新も検証します。本番DBはテスト接続先に指定しないでください。

`.env`、`.local/`、元HTML、バックアップはGit対象外です。設定例に実際の秘密値を書かないでください。
