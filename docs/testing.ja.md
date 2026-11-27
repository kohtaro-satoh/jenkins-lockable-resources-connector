# テスト

[English](testing.md) | 日本語

> この文書は [testing.md](testing.md) の日本語版です。内容が食い違う場合は英語版が正です。

速くて手元で回るものから、遅くて本物を相手にするものまで 4 段ある。確かめる設計は [design.ja.md](design.ja.md) にある。

| 段                                               | 実行                        | 場所                                          |
| ------------------------------------------------ | --------------------------- | --------------------------------------------- |
| [1. 単体テスト](#1-単体テスト)                   | `npm test`                  | push とプルリクエストごと（CI）               |
| [2. 結合テスト](#2-結合テスト)                   | `npm run test:integration`  | CI（ubuntu、windows、macos）                  |
| [3. ランナーの挙動（M0）](#3-ランナーの挙動m0)   | `m0-poc*.yml`、手動         | GitHub ホストランナー                         |
| [4. E2E テスト](#4-e2e-テスト)                   | `e2e.yml`、手動             | GitHub ホストランナーから実 Jenkins を相手に  |

## 1. 単体テスト

`__tests__/unit/`。偽の時計、偽の HTTP API、偽のランナー I/O を使う。

- **要求の JSON**（`request.ts`）: 入力から JSON への対応表で、既定値・未指定・0・空文字・空白・負の値を必ず含める。
  さらに、プラグインの `buildLockRequestJson` を写した参照モデルと、約 2,100 通りの入力の組み合わせで突き合わせる。
  意図した 2 つの違い（`priority`、`reason`）には専用のケースがある。
- **取得の状態機械**（`session.ts`）: QUEUED → ACQUIRED、SKIPPED、FAILED、503 の再送とその期限、404 / 410、
  ポーリングの失敗が 19 回続いても続行し 20 回で失敗すること、待機中のキャンセル。
- **post ステップ**: 段階ごとに、取り下げる（`enqueued`）、heartbeat を止めて失敗にする（`held`）、何もしない
  （`released`、`skipped`、`withdrawn`）に分かれること。`held` で release を送らないことは単独のテストにしている。
- **release ステップ**: 状態の確認（STALE、解放済み、記録なし）、上限までの再送、成功時と諦めたときに heartbeat を止めること。
- **入力**: 型のエラー、`GITHUB_` / `RUNNER_` で始まる `variable`、`extra` の未知のキー、空の token。
- **heartbeat プロセス**: 停止ファイル、状態ファイルの見張り、シグナル、送信中の heartbeat の打ち切り、
  消えたディレクトリを作り直さないこと。

## 2. 結合テスト

`__tests__/integration/`。`dist/` のバンドルを、ランナーと同じやり方（入力は `INPUT_*`、コマンドファイル、
post へ渡す保存済みの状態）で実プロセスとして動かし、API の状態機械を再現した偽サーバを相手にする。偽サーバは
QUEUED からの遷移、終端状態、404 / 410、連続した失敗、任意の heartbeat の応答、503 を出せる。
クライアント側の間隔は `LOCKABLE_RESOURCES_TEST_TIME_SCALE`（0 より大きく 1 以下）で縮めて速く回す。

- ロック → heartbeat プロセス → release → post: heartbeat が届き続け、release の後に止まり、release はちょうど 1 回届く。
- 失敗したジョブ: ロック → heartbeat プロセス → post（release ステップなし）。post が heartbeat を止め、
  **release は 1 回も届かない**。
- 保存した状態が届かなくても post がロックを見つける、skip、待機中のキャンセル、拒否された要求、
  受付停止中のサーバ（503）、release ステップが解放してはならない STALE の lease。

CI はこれを ubuntu、windows、macos で回す。

## 3. ランナーの挙動（M0）

設計は、GitHub が文書にしていないランナーの挙動を前提にしている。何より先に、小さな検証用 action
（`.github/poc/m0-probe`）を `m0-poc.yml` と `m0-poc-cancel.yml` で手動で走らせ、GitHub ホストランナーの
ubuntu、windows、macos で確かめた（[run 45711891191](https://github.com/kohtaro-satoh/jenkins-lockable-resources-connector/actions/runs/45711891191)、
[run 45711909304](https://github.com/kohtaro-satoh/jenkins-lockable-resources-connector/actions/runs/45711909304)、2026-11-26）。
6 つの前提はすべて成り立った。

| 前提                                                                          | 結果                                                                                                                                                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. detached で起動したプロセスが後続ステップの間生き続け、ジョブの終わりに片付けられる | 3 OS とも、後続の 2 ステップの間生きて動き続け、`Complete job` で孤児プロセスとして終了させられた                                                |
| 2. キャンセルの後に post が走り、main が保存した状態を読める                   | ステップのタイムアウトでも run のキャンセルでも、main がシグナルを無視して殺された場合も含めて、3 OS とも post が走り状態を読めた                              |
| 3. キャンセルのシグナルから、main が取り下げるだけの猶予がある                  | Linux / macOS: SIGINT、約 7.5 秒後に SIGTERM、さらに約 2.5 秒後に強制終了（約 10 秒）。Windows: SIGINT、約 7 秒後に強制終了（SIGTERM は来ない）。取り下げ 1 回（要求のタイムアウト 5 秒）は間に合う |
| 4. `runs.using: node24` が動く                                                | すべてのジョブが Node 24 で動いた                                                                                                                            |
| 5. container ジョブ                                                           | プロセスは後続ステップでも生きていた。コンテナの中には `RUNNER_TRACKING_ID` が無いので孤児の片付けは効かないが、ジョブの終わりにコンテナごと消される         |
| 6. composite action の中で使った JavaScript action の post が走る             | 3 OS とも走った                                                                                                                                              |

あわせて分かったこと:

- キャンセルのシグナルは main にだけ届き、detached のプロセスには届かない。保持中のキャンセルで heartbeat を
  止めるのは、設計どおり post ステップの役目である。
- `POST /acquire/` の応答待ち（最大 5 秒）の最中にキャンセルされると、Windows では 7 秒に収まらないことがある。
  そのときは post ステップが取り下げる。
- `GITHUB_ACTION` は main と post で同じだった。保存した状態は、main が殺された場合も含めていつも post に届いた。
- self-hosted runner は確かめていない。`node24` に対応しているかはランナーの版による。

## 4. E2E テスト

`.github/workflows/e2e.yml` は、GitHub ホストランナー上で Action を実 Jenkins に対して動かす。Jenkins は使い捨ての
VPS に 1 台だけ置いて共有し、[`e2e/server`](../e2e/server/README.ja.md) で構築する。すべてのジョブが同じサーバに届くので、
ジョブ同士が本当にリソースを取り合い、失敗したジョブがサーバに残したものをジョブの後で確かめられ、
Windows と macOS のランナーからも、コンテキストパス付きのリバースプロキシ越しに https で実 Jenkins を相手にできる。

### 4.1 サーバ

| 項目       | 設定                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| ホスト     | Ubuntu 26.04、メモリ 1 GB、2 コア。テストの間だけ動かす                                                                           |
| 入口       | `https://<host>/jenkins/`。前段に Caddy（Let's Encrypt）、Jenkins は 127.0.0.1 だけで待ち受ける。ホスト名はリポジトリの Variables に置き、コードには書かない |
| Jenkins    | LTS を同時に 1 つだけ（メモリのため）。プラグインの版（1560 と最新）ごとにイメージと JENKINS_HOME を持ち、`switch.sh` で切り替える |
| プラグイン | lockable-resources（版を固定）、Pipeline の最小構成（E07 の Jenkins 側）、`matrix-auth`、`groovy`（管理ジョブ）                     |
| 設定       | remote API 有効、expose label は `e2e`。ケースごとに専用のリソースを持ち、並列に走るケース同士が待ち合わない                       |

| ユーザー       | 権限                                        | 用途                                              |
| -------------- | ------------------------------------------- | ------------------------------------------------- |
| `e2e-robot`    | Overall/Read、Lockable Resources/RemoteUse  | Action が使う。README が求める権限そのもの        |
| `e2e-ops`      | Overall/Read、Job/Read、Job/Build           | 管理ジョブと Jenkins 側のパイプラインを起動する   |
| `e2e-norights` | Overall/Read                                | 403 のケース（E13）                               |
| `admin`        | すべて                                      | SSH 越しの保守だけ。CI には渡さない               |

**管理ジョブ（`e2e-admin`）**: テストには管理者の操作が要る（STALE の後片付け、新規要求の受付停止、監査ログと
待ち行列の読み出し）。admin の token を CI に置くと、漏れたときにスクリプトコンソール経由でサーバを乗っ取られうる。
そこで決まった system Groovy スクリプトを持つ Freestyle ジョブが、これらの操作だけを提供する。`e2e-ops` は
`OP` パラメータを付けて起動し、結果をコンソールから読む。Job/Configure を持たないのでスクリプトは変えられない。
引数は検査する（`e2e-` で始まるリソース名だけ、など）。

| OP              | 内容                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------- |
| `version`       | 動いている lockable-resources の版。ワークフローの入力と照合する                             |
| `reset`         | リモートの lease と待ちをすべて解放し、Jenkins 側のパイプラインを止め、受付を再開する       |
| `queue`         | あるリソースを待っている要求の数                                                             |
| `accept`        | `acceptNewAcquires` を切り替える                                                             |
| `release-stale` | STALE の lease を管理者として解放する                                                        |
| `records`       | リモートの記録の一覧（調査用）                                                               |
| `audit`         | ある時刻以降の監査ログ（`LRA|…` の行）                                                       |

**監査ログ**: プラグインは、`org.jenkins.plugins.lockableresources.audit` ロガー（1560 にもある）が FINE のとき、
リソースの持ち主が変わるたびに 1 行書く。サーバはこれをファイルに書く。リソースが二重に保持されなかったことは
クライアントのログでは示せない（クライアントが記録する時刻は実際の保持時間の内側にある）ので、判定はこの記録を読む。

**新しい JENKINS_HOME はロックされた状態で起動する**（匿名は拒否、ユーザー無し）。起動時のスクリプトがユーザーと権限を
設定して初めて使えるようになり、スクリプトが最後まで終わらなければ `switch.sh` が Jenkins を止める。初期設定ウィザードを
切った Jenkins は、設定が終わっていないと誰でも入れてしまうためである。

### 4.2 ワークフロー

- プラグインの版を入力に、手動で起動する。サーバで別の版が動いていれば `preflight` が止める。
- Jenkins は共有なので、run は 1 本ずつ（`concurrency`）。
- サーバの URL と token はリポジトリの Variables と Secrets（`E2E_SERVER_URL`、`E2E_ROBOT_TOKEN`、`E2E_OPS_TOKEN`、
  `E2E_NORIGHTS_TOKEN`）。
- 順番:
  1. `preflight`: 版の照合、`OP=reset`、開始時刻の記録
  2. 下表で「並列」のケース
  3. E12 を単独で。新規要求の受付停止はサーバ全体に効くため
  4. `verify-failures`: 失敗系のケースが残した lease（STALE か解放済みか）を確かめ、`OP=release-stale`
  5. `judge`
  6. `cleanup`（常に）: `OP=reset`
- **想定どおりの失敗**: いくつかのケースはわざと失敗する。保持中に失敗したジョブは STALE の lease を残さなければならない。
  そうしたジョブには job レベルの `continue-on-error` を付けて run を失敗させず、run の緑・赤は判定ジョブで決める。
  判定ジョブは API で、各ジョブと要所のステップ（post を含む）の結論を期待値と照合し、利用者が頼りにするメッセージを
  ジョブのログで確かめ、監査ログで、二重に保持されたリソースが無いこと、priority の順、Jenkins と Actions の間の順、
  単純なロックの取得と解放が 1 回ずつであることを確かめる。
- 順序を見るケース（E06p、E07）は、数十秒ずれるジョブの開始時刻に頼らない。保持役が先にリソースを取り、
  待ち手はその後に要求し、保持役は `OP=queue` で全員が待っているのを確かめてから解放する。

### 4.3 ケース

| ID   | 内容                                                                                         | 期待                                                                                                                       | ランナー                   | 段     |
| ---- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------ |
| E01  | resource を指定して取得 → 後続ステップ → release                                             | サーバで FREE に戻る。post は何もしない。監査ログで取得と解放が 1 回ずつ                                                   | ubuntu、windows、macos     | 並列   |
| E02  | label + quantity + variable、プロパティ付きのリソース                                        | 後続ステップで `X`、`X0` …、`X0_<プロパティ名>`、`X_<プロパティ名>` が読め、`env-vars` 出力と一致する。ロックのステップはプロパティの値を出さない | ubuntu、windows、macos | 並列 |
| E03  | resource + extra                                                                             | まとめて取れる                                                                                                             | ubuntu                     | 並列   |
| E04  | 前のステップが持つリソースに skip-if-locked                                                  | SKIPPED、`acquired=false`、条件付きのステップが飛ぶ                                                                        | ubuntu                     | 並列   |
| E05  | 保持中のリソースに 20 秒の allocate 期限                                                     | 20〜35 秒後に `LOCK_WAIT_TIMEOUT` で失敗する（サーバの判定は 15 秒ごと）                                                   | ubuntu                     | 並列   |
| E06  | 3 種の OS の 4 ジョブが 1 つのリソースを順に取る（各 20 秒）                                 | 4 つとも取れる。同時に 2 つが持つことはない（監査ログ）                                                                    | ubuntu ×2、windows、macos  | 並列   |
| E06p | 3 つ目のジョブが保持している間に priority 0、続いて priority 10 が要求する                   | priority 10 が先に取れる                                                                                                   | ubuntu ×3                  | 並列   |
| E07  | Jenkins パイプラインが持つリソースを Action が待つ。逆も                                     | 両者で 1 つのキュー、順序どおり（監査ログ）                                                                                | ubuntu                     | 並列   |
| E08  | 待機中のロックのステップを `timeout-minutes` で打ち切る                                      | ロックのステップがランナーのシグナルで取り下げ、post より前にキューが空になっている                                        | ubuntu、windows、macos     | 並列   |
| E09  | 保持中に後続ステップが失敗する                                                               | 解放されず、ジョブの後に STALE                                                                                             | ubuntu                     | 並列   |
| E10  | 保持中に 75 秒かかる後続ステップ                                                             | STALE にならない（heartbeat が lease を保つ）                                                                              | ubuntu、windows、macos     | 並列   |
| E11  | release ステップの無い成功ジョブ                                                             | post ステップがジョブを失敗にし、STALE                                                                                     | ubuntu                     | 並列   |
| E12  | 新規要求の受付を止め、30 秒後に再開する                                                      | ロックのステップは 503 の間待ち、再開後に取れる                                                                            | ubuntu                     | 単独   |
| E13  | 公開されていないリソース、誤った token、RemoteUse の無いユーザー、`http://` の URL（転送される）、誤ったコンテキストパス | 404 / 401 / 403 / リダイレクト / 404 で、それぞれすぐに、ヒント付きで失敗する                               | ubuntu                     | 並列   |
| E14  | —                                                                                            | E01、E02、E08、E10 を 3 OS で回すことで兼ねる                                                                              | —                          | —      |
| E15  | 保持中の後続ステップを `timeout-minutes` で打ち切る                                          | E09 と同じく解放されず STALE                                                                                               | ubuntu                     | 並列   |
| E16  | release ステップに `if: always()`、後続ステップが失敗                                        | 解放され FREE                                                                                                              | ubuntu                     | 並列   |
| E17  | heartbeat プロセスを殺し、70 秒後に release                                                  | release ステップが STALE を見つけ、解放せずに失敗する                                                                      | ubuntu                     | 並列   |
| E18  | ランナーからサーバへの通信を止める（iptables）: 保持中に 30 秒、release 中に 15 秒          | heartbeat の失敗は記録されるが lease は生き残る。release は再送して成功する                                                | ubuntu                     | 並列   |

対象外: priority 以外の並び順（サーバの責任で、プラグインのテストが持つ）、Jenkins の再起動をまたぐ挙動
（リモートの記録はメモリにあり、プラグインの設計として消える）、self-hosted runner（公開リポジトリに self-hosted runner を
付けるのは危ないので付けていない）。

### 4.4 結果

| プラグイン                    | run                                                                                                           | 判定    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- | ------- |
| 1611.vd91dca_329d61（最新）   | [45732853249](https://github.com/kohtaro-satoh/jenkins-lockable-resources-connector/actions/runs/45732853249) | 77 / 77 |
| 1560.va_b_cd589f23eb_         | [45733313311](https://github.com/kohtaro-satoh/jenkins-lockable-resources-connector/actions/runs/45733313311) | 77 / 77 |

（2026-11-26）1 run は約 3 分。どちらの版でも、監査ログに二重に保持されたリソースは無く（31 リソース、76 イベント）、
priority の順と Jenkins / Actions の順も期待どおりだった。

途中で分かったこと:

- ランナーは `GITHUB_ENV` の変数を、後続の各ステップのログの見出しに値ごと一覧表示する。最初の run では E02 の確認が
  これを拾った。判定はロックのステップ自身の行だけを見るように直し、README には秘密をリソースのプロパティに
  入れないよう書いた。
- API で見ると、わざと失敗させたステップの結論は `failure` になる（`timeout-minutes` で打ち切られたステップも同じ）。
  job レベルの `continue-on-error` を付けたジョブも結論は `failure` で、run は緑のままになる。

### 4.5 走らせ方

[e2e/server/README.ja.md](../e2e/server/README.ja.md) のとおり、サーバを構築し、Variable と Secrets を登録してから:

```sh
ssh ops@<host> lrrc-e2e/switch.sh 1560      # または latest
gh workflow run e2e.yml -f plugin=1560
```
