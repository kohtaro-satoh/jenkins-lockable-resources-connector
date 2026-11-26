# lockable-resources-remote-client-actions

[English](README.md) | 日本語

> この文書は [README.md](README.md) の日本語版です。内容が食い違う場合は英語版が正です。

Jenkins コントローラで定義されたリソース（[lockable-resources プラグイン](https://plugins.jenkins.io/lockable-resources/)）を、
GitHub Actions のジョブからロックする Action です。要求は Jenkins の `lock()` と**同じキュー**に並び、
同じ順序規則（priority、inversePrecedence）と同じ排他で扱われます。パイプラインとワークフローの間で、
実機、検証環境、ライセンスなどを安全に共有できます。

> **状態: プレリリース（0.x）。** GitHub ホストランナー（Linux、Windows、macOS）から、
> lockable-resources 1560 と 1611 を相手に E2E テストを通しています（[docs/testing.ja.md](docs/testing.ja.md)）。
> 1.0 までは入力や挙動が変わることがあります。

## 必要なもの

- Jenkins 側の lockable-resources が **1560.va_b_cd589f23eb_** 以上（`group` 入力を使うなら 1588 以上）
- Jenkins にネットワークで届くランナー（社内の Jenkins なら self-hosted runner）

### Jenkins 側の準備

プラグイン README の remote の節のとおりです。

1. remote API を有効にし、**expose label** を設定します。GitHub Actions からロックさせたいリソースに、
   そのラベルを付けます。
2. 専用ユーザーを作り、**Overall/Read** と **Lockable Resources/RemoteUse** だけを与えます。
3. そのユーザーの **API トークン**を作ります。パスワードでは動きません（CSRF crumb の検査で拒否されます）。

## 使い方

```yaml
jobs:
  flash:
    runs-on: [self-hosted, lab]
    env:
      LOCKABLE_RESOURCES_SERVER_URL: ${{ vars.LOCKABLE_RESOURCES_SERVER_URL }}
      LOCKABLE_RESOURCES_USERNAME: ${{ vars.LOCKABLE_RESOURCES_USERNAME }}
    steps:
      - uses: kohtaro-satoh/lockable-resources-remote-client-actions@<commit-sha>
        id: lock
        with:
          token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
          label: plc
          quantity: 1
          variable: PLC
          timeout-for-allocate-resource: 30

      - run: ./flash.sh "$PLC0" # ロック中

      # 必須。これが無いとロックは解放されません（下記）。
      - uses: kohtaro-satoh/lockable-resources-remote-client-actions/release@<commit-sha>
        with:
          token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
          lock-id: ${{ steps.lock.outputs.lock-id }}

      - run: ./report.sh # 解放後
```

サーバの URL とユーザー名は、組織またはリポジトリの **Variables** に置き、Action に環境変数から読ませてください。
ワークフローごとに接続先を書かずに済みます。token だけは例外で、`token` 入力からしか読みません。
ジョブの `env:` に置くと、ほかのすべてのステップ（他者の action も含む）から読めてしまうためです。

### ジョブが失敗したとき

**ロックを解放するのは release ステップだけです。** ロックを持っている間にステップが失敗したり、
ジョブがキャンセルされたりすると、release ステップは走りません。Action の post ステップは heartbeat を止めますが、
**解放はしません**。約 60 秒後に Jenkins が lease を **STALE** にし、管理者が実機を確かめて Jenkins の画面で
解放するまで、リソースを持ち続けます。失敗したジョブが実機をどんな状態で残したかは誰にも分からないので、
次のジョブに渡す前に人が確かめる、という考え方です。

Jenkins の `lock()` は、失敗してもブロックの終わりで解放します。同じ挙動にしたいときは、release ステップに
`if: always()` を付けてください。失敗のあとにリソースを確かめる必要がない場合に限って使ってください。

release ステップは、すでに STALE になった lease（ジョブの実行中に heartbeat が 60 秒途絶えたもの）の解放を拒み、
失敗します。

キューで待っている間にジョブが失敗・キャンセルされた場合は、要求を取り下げます。まだどのステップも
リソースに触れていないからです。

### skip-if-locked

```yaml
- uses: kohtaro-satoh/lockable-resources-remote-client-actions@<commit-sha>
  id: lock
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    resource: printer
    skip-if-locked: true
- if: steps.lock.outputs.acquired == 'true'
  run: ./print.sh
- uses: kohtaro-satoh/lockable-resources-remote-client-actions/release@<commit-sha>
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    lock-id: ${{ steps.lock.outputs.lock-id }}
```

リソースが使用中なら、ステップは `acquired=false` で成功します。release ステップはその lock ID を受け取り、
何もせずに成功します。

### 複数のロック

ロックごとに Action を呼び、`id`、`variable`、release ステップをそれぞれ分けます。

```yaml
- uses: kohtaro-satoh/lockable-resources-remote-client-actions@<commit-sha>
  id: board
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    label: board
    quantity: 1
    variable: BOARD
- uses: kohtaro-satoh/lockable-resources-remote-client-actions@<commit-sha>
  id: license
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    resource: compiler-license
- run: ./build-and-flash.sh "$BOARD0"
- uses: kohtaro-satoh/lockable-resources-remote-client-actions/release@<commit-sha>
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    lock-id: ${{ steps.license.outputs.lock-id }}
- uses: kohtaro-satoh/lockable-resources-remote-client-actions/release@<commit-sha>
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    lock-id: ${{ steps.board.outputs.lock-id }}
```

複数のリソースを 1 つの要求でまとめて取りたいときは、代わりに `extra` を使います。

## 入力

| 入力                            | `lock()`                     | 既定値                                |
| ------------------------------- | ---------------------------- | ------------------------------------- |
| `server-url`                    | —                            | `$LOCKABLE_RESOURCES_SERVER_URL`      |
| `username`                      | —                            | `$LOCKABLE_RESOURCES_USERNAME`        |
| `token`                         | —                            | 必須。環境変数からは読まない          |
| `client-id`                     | —                            | `github-actions:<owner>/<repo>`       |
| `resource`                      | `resource`                   |                                       |
| `label`                         | `label`                      |                                       |
| `group`                         | `group`                      |                                       |
| `quantity`                      | `quantity`                   | `0`（合うものすべて）                 |
| `variable`                      | `variable`                   |                                       |
| `inverse-precedence`            | `inversePrecedence`          | `false`                               |
| `resource-select-strategy`      | `resourceSelectStrategy`     | `SEQUENTIAL`                          |
| `skip-if-locked`                | `skipIfLocked`               | `false`                               |
| `extra`                         | `extra`                      | YAML または JSON のリスト             |
| `priority`                      | `priority`                   | `0`                                   |
| `timeout-for-allocate-resource` | `timeoutForAllocateResource` | `0`（無期限に待つ）                   |
| `timeout-unit`                  | `timeoutUnit`                | `MINUTES`                             |
| `reason`                        | `reason`                     | `<workflow> #<run> (<job>) <run URL>` |

release ステップ（`/release`）は `lock-id` と、同じ `server-url`・`username`・`token` を取ります。

Action が確かめるのは型と書式だけです。組み合わせが妥当か（`resource` と `label` の併用、`priority` と
`inverse-precedence` の併用、対象なし）はサーバが判断し、ローカルの `lock()` と同じ文言で答えます。

```yaml
extra: |
  - resource: resource4
  - label: gpu
    quantity: 2
```

`timeout-for-allocate-resource` は付けてください。待ち時間はジョブの時間上限と課金に含まれます。
また、消えたランナーが残した要求も、期限が来れば自然に消えます。

## 出力と環境変数

| 出力        | 内容                                 |
| ----------- | ------------------------------------ |
| `lock-id`   | サーバが発行した lock ID             |
| `state`     | `ACQUIRED` または `SKIPPED`          |
| `acquired`  | `true` / `false`                     |
| `resources` | ロックしたリソース名の JSON 配列     |
| `env-vars`  | サーバが返した `lockEnvVars` の JSON |

`variable: PLC` とすると、後続ステップは Jenkins の `lock()` ブロックと同じく、`PLC`、`PLC0`、
`PLC0_<プロパティ名>`、`PLC_<プロパティ名>`（1 つ目のリソースのプロパティ）… を環境変数として受け取ります。

Action はプロパティの値を表示しません。ただし runner は、`GITHUB_ENV` で設定された変数を後続の各ステップの
ログの見出しに、値ごと一覧表示します。マスクはされないので、秘密をリソースのプロパティに入れないでください。

## 制限

- ロックは 1 つのジョブの中だけで有効です。必要なジョブそれぞれでロックしてください。
- 同じジョブで同じリソースを 2 回取ると、2 回目は 1 回目を待ち続けます（`shareId` がないため）。期限を付けてください。
- `server-id`（peer mode）と `share-id` には対応していません。すべてのロックは設定した 1 台のサーバに行きます（delegated mode）。

## うまくいかないとき

| 失敗                                            | よくある原因                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| HTTP 401                                        | ユーザー名か token の誤り、または API トークンではなくパスワードを使っている               |
| HTTP 403                                        | ユーザーに Overall/Read か Lockable Resources/RemoteUse が無い、または remote API が無効   |
| HTTP 404 `UNKNOWN_RESOURCE` / `UNKNOWN_LABEL`   | リソースやラベルが存在しない、または expose label が付いていない                           |
| エラーコードの無い HTTP 404                     | `server-url` の誤り（`/jenkins` などのコンテキストパスを確かめる）、またはプラグインが古い |
| "The server redirected"                         | `server-url` が最終的な URL ではない（例: `http://` が `https://` に転送されている）       |
| `LOCK_WAIT_TIMEOUT`                             | リソースが空く前に `timeout-for-allocate-resource` が切れた                                |
| "not accepting new acquire requests"（503）     | サーバが保守のため受付を止めている。再開か期限まで Action は待つ                           |
| release ステップの "is STALE on the server"     | heartbeat が 60 秒途絶えた。管理者が確かめて lease を解放する必要がある                    |
| post ステップの失敗（ロックが解放されていない） | release ステップが走らなかった。lease は STALE になる（上記）                              |
| `token` が空                                    | fork からのプルリクエストには secrets が渡されない                                         |

## セキュリティ

- token はログでマスクされ、ディスクには書かれず、heartbeat プロセスにはコマンドライン引数ではなく環境変数で渡されます。
- `http://` の URL も動きますが、警告を出します。Basic 認証で token が平文で流れるためです。
- リダイレクトには従いません。認証情報が別の URL に送られることはありません。
- 自己署名証明書には `NODE_EXTRA_CA_CERTS` を設定してください。証明書の検証を切るオプションはありません。
- Action はタグではなくコミット SHA で固定してください。

## 仕組み

ロックのステップは要求をキューに入れ、許可されるまで 3 秒ごとにポーリングします。許可されたら、ステップより長く
生きる heartbeat プロセス（10 秒ごとに heartbeat）を起動し、環境変数を書き出して終わります。release ステップは、
lease が STALE でないことを確かめてから release を送り（heartbeat を続けたまま約 60 秒まで再送）、
heartbeat プロセスを止めます。post ステップは、heartbeat プロセスがまだ動いていれば止め、引き渡し前の要求を取り下げます。

- [docs/design.ja.md](docs/design.ja.md): 設計とその理由
- [docs/testing.ja.md](docs/testing.ja.md): 単体・結合・ランナー挙動・E2E のテストと結果
- [CHANGELOG.md](CHANGELOG.md)（英語）

## 開発

```sh
npm ci
npm run lint && npm run typecheck
npm test                 # 単体テスト
npm run package          # dist/ をバンドル（コミットする）
npm run test:integration # 偽サーバを相手に main -> デーモン -> release -> post
```

E2E テストには専用の Jenkins が要ります。[e2e/server/README.ja.md](e2e/server/README.ja.md) を見てください。

## ライセンス

[MIT](LICENSE)。`dist/` のバンドルには他者のパッケージ（すべて MIT License）が含まれ、その著作権表示とライセンス文は
[dist/licenses.txt](dist/licenses.txt) にある。このファイルは `npm run package` が作り直す。
許可した寛容なライセンス（MIT、ISC、BSD、Apache-2.0）以外のパッケージが混ざるとビルドが失敗する。
