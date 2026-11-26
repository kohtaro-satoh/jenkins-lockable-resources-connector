# E2E サーバ

[English](README.md) | 日本語

> この文書は [README.md](README.md) の日本語版です。内容が食い違う場合は英語版が正です。

`.github/workflows/e2e.yml` がテストの相手にする Jenkins（設計:
[docs/testing.ja.md §4](../../docs/testing.ja.md#4-e2e-テスト)）。テストの間だけ動かす使い捨ての VPS
（Ubuntu 26.04、メモリ 1 GB）に置く。

## 構築

root が自分の SSH 鍵を受け付ける新しい VPS で、ドメインの A レコードがそこを指し、事業者側のファイアウォールで
22 / 80 / 443 が開いている状態から:

```sh
scp -r e2e/server root@<host>:lrrc-e2e
ssh root@<host> bash lrrc-e2e/01-bootstrap.sh   # ユーザー ops、ufw、更新
scp -r e2e/server ops@<host>:lrrc-e2e
ssh ops@<host> bash lrrc-e2e/02-lockdown.sh     # root とパスワードでのログインを止める
ssh ops@<host> bash lrrc-e2e/03-docker.sh       # Docker
ssh ops@<host> bash lrrc-e2e/04-jenkins.sh <domain> latest   # Caddy + Jenkins
```

続いてリポジトリの設定に登録する:

| 種類     | 名前                 | 値                                            |
| -------- | -------------------- | --------------------------------------------- |
| Variable | `E2E_SERVER_URL`     | `https://<domain>/jenkins`                    |
| Secret   | `E2E_ROBOT_TOKEN`    | `~/lrrc-e2e/secrets.env` の `E2E_ROBOT_TOKEN` |
| Secret   | `E2E_OPS_TOKEN`      | 同じファイルの `E2E_OPS_TOKEN`                |
| Secret   | `E2E_NORIGHTS_TOKEN` | 同じファイルの `E2E_NORIGHTS_TOKEN`           |

`secrets.env` はサーバ上で一度だけ作られ、これらの Secrets に入れる以外にサーバの外へは出さない。
中の admin のパスワードは SSH 越しの保守用である。

## テストを走らせる

```sh
ssh ops@<host> lrrc-e2e/switch.sh 1560      # または latest。新しい latest にするには REBUILD=1
gh workflow run e2e.yml -f plugin=1560
```

メモリに収まる Jenkins は 1 つだけなので、プラグインの版ごとに別の run になる。

## 補足

- Jenkins は 127.0.0.1 だけで待ち受け、入口は Caddy（Let's Encrypt）である。
- 新しい JENKINS_HOME はロックされた状態で起動し（`jenkins/config.xml`）、起動時のスクリプトがユーザーと権限を
  追加する。スクリプトが最後まで終わらなければ `switch.sh` が Jenkins を止める。初期設定ウィザードを切っているので、
  設定の終わっていない Jenkins は誰でも入れてしまうためである。
- CI が管理者の操作を行う手段は `e2e-admin` だけである（`jenkins/jobs/e2e-admin.groovy`）。
- run の様子を Jenkins の画面で見るときは `admin` でログインする。パスワードは `secrets.env` の
  `E2E_ADMIN_PASSWORD`（SSH で読む）。run の最中に `e2e-` のリソースを手でロック・予約・リセットしないこと。
  版ごとに JENKINS_HOME が別なので、切り替えたらログインし直す。
