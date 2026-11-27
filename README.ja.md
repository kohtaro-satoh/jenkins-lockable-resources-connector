# jenkins-lockable-resources-connector

[English](README.md) | 日本語

> この文書は [README.md](README.md) の日本語版です。内容が食い違う場合は英語版が正です。

Jenkins コントローラで定義されたリソース（[lockable-resources プラグイン](https://plugins.jenkins.io/lockable-resources/)）を、
GitHub Actions のジョブからロックする Action です。要求は Jenkins の `lock()` と**同じキュー**に並び、
同じ順序規則（priority、inversePrecedence）と同じ排他で扱われます。GitHub Actions のワークフローと Jenkins の
パイプラインの間で、実機、検証環境、ライセンスなどを安全に共有できます。

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
      - uses: kohtaro-satoh/jenkins-lockable-resources-connector@<commit-sha>
        id: lock
        with:
          token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
          label: plc
          quantity: 1
          variable: PLC
          timeout-for-allocate-resource: 30

      - run: ./flash.sh "$PLC0" # ロック中

      # 必須。これが無いとロックは解放されません（下記）。
      - uses: kohtaro-satoh/jenkins-lockable-resources-connector/release@<commit-sha>
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
- uses: kohtaro-satoh/jenkins-lockable-resources-connector@<commit-sha>
  id: lock
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    resource: printer
    skip-if-locked: true
- if: steps.lock.outputs.acquired == 'true'
  run: ./print.sh
- uses: kohtaro-satoh/jenkins-lockable-resources-connector/release@<commit-sha>
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    lock-id: ${{ steps.lock.outputs.lock-id }}
```

リソースが使用中なら、ステップは `acquired=false` で成功します。release ステップはその lock ID を受け取り、
何もせずに成功します。

### 複数のロック

ロックごとに Action を呼び、`id`、`variable`、release ステップをそれぞれ分けます。

```yaml
- uses: kohtaro-satoh/jenkins-lockable-resources-connector@<commit-sha>
  id: board
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    label: board
    quantity: 1
    variable: BOARD
- uses: kohtaro-satoh/jenkins-lockable-resources-connector@<commit-sha>
  id: license
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    resource: compiler-license
- run: ./build-and-flash.sh "$BOARD0"
- uses: kohtaro-satoh/jenkins-lockable-resources-connector/release@<commit-sha>
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    lock-id: ${{ steps.license.outputs.lock-id }}
- uses: kohtaro-satoh/jenkins-lockable-resources-connector/release@<commit-sha>
  with:
    token: ${{ secrets.LOCKABLE_RESOURCES_TOKEN }}
    lock-id: ${{ steps.board.outputs.lock-id }}
```

複数のリソースを 1 つの要求でまとめて取りたいときは、代わりに `extra` を使います。

## 入力

既定値と選択肢は lockable-resources 1611.vd91dca_329d61 時点のものです。選択肢の値は大文字・小文字を区別しません（`random` でも可）。

| 入力                            | 既定値                                | 説明                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **接続**                        |                                       |                                                                                                                                                                                                                                                                                       |
| `server-url`                    | `$LOCKABLE_RESOURCES_SERVER_URL`      | Jenkins のルート URL。コンテキストパスまで含めます（例: `https://ci.example.com/jenkins`）。                                                                                                                                                                                          |
| `username`                      | `$LOCKABLE_RESOURCES_USERNAME`        | **Overall/Read** と **Lockable Resources/RemoteUse** の権限を持つ Jenkins ユーザー。                                                                                                                                                                                                  |
| `token`                         | （必須）                              | そのユーザーの API token（パスワードは不可）。secret から渡してください。環境変数からは読みません。                                                                                                                                                                                   |
| **ロックする対象**              |                                       | `resource`・`label`・`group` のどれかを指定します（`extra` にすべて書いても可）。                                                                                                                                                                                                     |
| `resource`                      |                                       | ロックするリソースの名前。Jenkins の _Lockable Resources_ ページにある名前です。リソースが存在し、公開ラベル（expose label）が付いている必要があります。パイプラインの `lock()` と違い、無いリソースは作られません。`label` とは併用できません。                                      |
| `label`                         |                                       | 名前ではなくラベルでリソースを選びます。`gpu && linux` や `board-a \|\| board-b` のようなラベル式も使えます。対象は公開ラベルの付いたリソースだけです。いくつ取るかは `quantity` で指定します。`resource` とは併用できません。                                                        |
| `quantity`                      | `0`                                   | `label`（または `group`）に合うリソースのうち、いくつロックするか。`0` は合うものを**すべて**ロックするので、全部が空くまで待ちます。プールから空いているものを 1 つ取るなら `1` にします。                                                                                           |
| `group`                         | `common`                              | このリソースグループの中からだけ選びます（lockable-resources 1588 以降）。`resource` と `label` はグループの中で照合され、ほかのグループには広げません。`group` だけ（`resource` も `label` も無し）を指定するとグループ全体が対象になり、`quantity` はグループのメンバーを数えます。 |
| `extra`                         |                                       | 同じ要求でまとめてロックする追加のリソース。全部取れるか、何も取らないかのどちらかです。YAML（または JSON）のリストで、各要素に `resource` か `label` と、必要なら `quantity`・`group` を書きます（`group` の無い要素はメインの `group` を使います）。下の例を参照。                  |
| `resource-select-strategy`      | `SEQUENTIAL`                          | 必要な数より多く合うとき、空いているリソースのどれを取るか。`SEQUENTIAL`: Jenkins のリソース一覧の順。`RANDOM`: ランダムな順。                                                                                                                                                        |
| **キューでの待ち方**            |                                       |                                                                                                                                                                                                                                                                                       |
| `priority`                      | `0`                                   | 同じリソースを待つ要求の間の順番。数の大きいものから先に渡し、同じ数なら来た順です。負の数は既定の `0` より後になります。`inverse-precedence` とは併用できません。                                                                                                                    |
| `inverse-precedence`            | `false`                               | `true`: 列に割り込みます。`true` の要求はほかの要求より先に渡され、`true` 同士では新しいものが先です。`priority` とは併用できません。                                                                                                                                                 |
| `skip-if-locked`                | `false`                               | `true`: 待ちません。すぐにロックできなければ何もロックせず、出力 `acquired` を `false` にしてステップは成功します。後続のステップで確かめてください: `if: steps.<id>.outputs.acquired == 'true'`。                                                                                    |
| `timeout-for-allocate-resource` | `0`                                   | この時間（単位は `timeout-unit`）待ってもロックできなければ諦め、ステップは `LOCK_WAIT_TIMEOUT` で失敗します。`0` は無期限に待ちます。指定を勧めます。待ち時間はジョブの時間上限と課金に含まれ、消えたランナーが残した要求も期限が来れば自然に消えます。                              |
| `timeout-unit`                  | `MINUTES`                             | `timeout-for-allocate-resource` の単位: `SECONDS`、`MINUTES`、`HOURS`。Java の `TimeUnit` のほかの名前（`DAYS`、`MILLISECONDS` など）も使えますが、プラグインの文書にあるのはこの 3 つだけです。                                                                                      |
| **ロック中**                    |                                       |                                                                                                                                                                                                                                                                                       |
| `variable`                      |                                       | 後続のステップに渡す環境変数の名前。この変数にはロックしたリソースの名前がカンマ区切りで入り、`<variable>0`、`<variable>1`、… にはそれぞれの名前とプロパティが入ります（[出力と環境変数](#出力と環境変数)）。`GITHUB_` や `RUNNER_` で始まる名前は使えません。                        |
| `reason`                        | `<workflow> #<run> (<job>) <run URL>` | ロック中、Jenkins の _Lockable Resources_ ページに表示されます。リソースがなぜ使用中か、ほかの人に分かるようにするためのものです。                                                                                                                                                    |
| `client-id`                     | `github-actions:<owner>/<repo>`       | Jenkins のページでロックの横に表示され、どのクライアントが持っているかを示します。                                                                                                                                                                                                    |

release ステップ（`/release`）は `lock-id` と、同じ `server-url`・`username`・`token` を取ります。

Action が確かめるのは型と書式だけです。組み合わせが妥当か（`resource` と `label` の併用、`priority` と
`inverse-precedence` の併用、対象なし）はサーバが判断し、ローカルの `lock()` と同じ文言で答えます。

`extra` の例: メインの `resource` か `label` と一緒に、`resource4` と、ラベル `gpu` のリソース 2 つをロックします。

```yaml
extra: |
  - resource: resource4
  - label: gpu
    quantity: 2
```

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

- ロックは job（`jobs:` の下の 1 項目）単位で有効です。
  - job が終わると heartbeat は自動で止まります。それまでに job の中で release ステップを実行していなければ、
    lease は STALE になります。
  - ロックしたリソースを続けて占有して使うステップは、1 つの job にまとめてください。
- `lock()` の引数のうち、remote API が受け付けないものには対応する入力がありません: `serverId`（すべてのロックは設定した
  1 台のサーバに行きます。delegated mode と同じです）、`shareId`、1611 で増えた `candidates`・`onReleaseDelay`・`onCancelDelay`。

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
[dist/licenses.txt](dist/licenses.txt) にあります。このファイルは `npm run package` が作り直します。
許可した寛容なライセンス（MIT、ISC、BSD、Apache-2.0）以外のパッケージが混ざると、ビルドが失敗します。
