# macOS のデスクトップを MCP で見て操作する（desktop）

CLI のセッション（Claude Code / Codex / agy）から、macOS のアプリのスクリーンショットを撮り、クリック・キー入力をするための **stdio の MCP サーバー**。ツールは Anthropic の computer use のツールに寄せてある。中身は 2 つに分かれる。

| 部品 | 場所 | 持つもの |
|---|---|---|
| MCP サーバー（Node） | `@synapse-chat/mcp/desktop`（[`packages/mcp/src/desktop/`](../../packages/mcp/src/desktop/)）、bin `synapse-desktop` | ツール、承認 API の呼び出し、ブラウザを見るだけにする、期限、座標の換算 |
| helper（Swift） | [`packages/mcp/desktop-helper/`](../../packages/mcp/desktop-helper/) を `.app` にビルド | macOS の権限（アクセシビリティ・画面収録）、ScreenCaptureKit、CGEvent、Esc での中止、1 セッションだけのロック、メニューバーの表示 |

**MCP サーバーは許可を決めない。** 誰がどのアプリを使ってよいかは、`request_access` がアプリの承認 API に聞き、アプリが人に聞く。サーバーが自分で決めるのは、誰にでも同じ 2 つだけ（ブラウザは見るだけ、期限が切れたら全部断る）。helper は、承認されたアプリの集合を、スクリーンショット 1 枚・イベント 1 つごとにもう一度確かめる。

段 1（この文書）は synapse-chat の側だけ。承認の UI と API はアプリ（agents-familia）が後の段で作る。

| ファイル | |
|---|---|
| `contract.ts` | 承認 API の型、helper の取り決めの型 |
| `approval.ts` | 承認 API の呼び出し（`node:http`。`Origin` を付けない） |
| `helper-client.ts` | helper の Unix socket への接続。socket が無ければ helper を起動する |
| `policy.ts` | ブラウザの一覧、座標の換算 |
| `server.ts` | ツール、instructions、承認の状態 |
| `registration.ts` | 各 CLI への登録の形（書かない） |
| `cli.ts` | `synapse-desktop serve / register / status` |

`node:sqlite` を使わないので Node 20 でも動く。

## 承認 API の取り決め

アプリが実装する。型は `contract.ts`。

| | |
|---|---|
| `POST {api}/api/desktop/access` | `DesktopAccessRequest` → 200 / 201 / 202 `DesktopAccessState` |
| `GET {api}/api/desktop/access/{requestId}?waitMs=<n>` | → 200 `DesktopAccessState` |

```jsonc
// POST の本文（DesktopAccessRequest）
{
  "deskId": "desk-123",                 // --desk-id の値。誰が頼んでいるか
  "apps": [                             // helper が名前から引いたもの。重複は除いてある
    { "query": "TextEdit", "bundleId": "com.apple.TextEdit", "name": "TextEdit", "readOnly": false },
    { "query": "Safari",   "bundleId": "com.apple.Safari",   "name": "Safari",   "readOnly": true }
  ],
  "reason": "メモを書く"                 // エージェントが書いた理由。承認する人に見せる
}

// 応答（DesktopAccessState）
{ "requestId": "r-1", "status": "pending" }
{ "requestId": "r-1", "status": "granted", "apps": ["com.apple.TextEdit", "com.apple.Safari"],
  "readOnly": [], "expiresAt": "2026-11-01T09:00:00Z", "message": "任意" }
{ "requestId": "r-1", "status": "denied", "message": "今はだめ" }
{ "requestId": "r-1", "status": "expired" }
```

- `status` は `pending` / `granted` / `denied` / `expired`。POST がすぐ `granted` などを返してもよい（そのときは GET しない）
- **GET は long poll にしてよい。** `pending` のあいだ最大 `waitMs` ミリ秒（サーバーは最大 20 000 を渡す）待たせ、時間が来たら `pending` を返す。long poll をしないアプリはすぐ `pending` を返してよく、サーバーは 1 秒おきに聞き直す
- `granted` には `apps`（bundle id の配列）と `expiresAt`（ISO 8601）が**必須**。期限の無い承認は形が違う応答として断る。`apps` のうち、頼んでいないものは捨てる。`readOnly` に挙げた bundle id は見るだけ（ブラウザは挙げなくても見るだけ）
- `readOnly: true` は、ブラウザなので承認されても見るだけになる、という印。承認の画面で添えるとよい
- 認証: `--token` を渡したときだけ `Authorization: Bearer <token>`。`Origin` は付けない（peers と同じ。[peers-mcp.md](peers-mcp.md)）。`{api}` のパスは保ち、query と fragment は拒否
- 断るときは 4xx / 5xx と `{ error, reason, … }`。サーバーはそのまま `isError: true` の結果に入れる。`reason` の無い応答・JSON でない応答・形の合わない 200 は `server-unreachable`（`detail: bad-response: HTTP <n>`）、繋がらないときも `server-unreachable`（`detail` に接続のエラーコード）

### 待ち方

`request_access` 1 回で待つのは既定 45 秒（`--approval-timeout-ms`。Codex の MCP ツールの上限 60 秒より短い）。人が答えなければ、エラーではなく `{ status: "pending", requestId }` を返し、モデルに「同じ引数でもう一度呼ぶ」と書く。同じアプリの組でもう一度呼ぶと、新しく POST せず同じ `requestId` を待ち続ける。違う組なら新しく頼む。

承認は 1 つだけ持つ。`request_access` が新しく `granted` になると前の承認は置き換わる。

## ツール

座標はすべて**直前の `screenshot` の画素**。サーバーが、helper の返した位置と大きさ（グローバルのポイント）で換算する。screenshot の前の座標、画像の外の座標は断る。

| ツール | 引数 | |
|---|---|---|
| `request_access` | `apps: string[]`（名前か bundle id）、`reason` | 承認を求めて待つ。インストールされていない名前は、頼む前に `unknown-app` |
| `list_granted_applications` | — | `status`（`granted` / `none` / `aborted` / `expired`）、`apps`（`input: false` は見るだけ）、`expiresAt`、`pendingRequestId` |
| `screenshot` | — | 画像（MCP の image content）と `{ width, height, apps, notVisible }`。承認されたアプリのウィンドウだけが写る |
| `left_click` / `right_click` / `middle_click` / `double_click` / `triple_click` | `coordinate`、`text`（保持する修飾キー、`"cmd+shift"`） | |
| `mouse_move` | `coordinate` | |
| `left_click_drag` | `start_coordinate`、`coordinate` | 両端とも操作できるアプリの上でなければ断る |
| `left_mouse_down` / `left_mouse_up` | `coordinate`（任意） | |
| `scroll` | `coordinate`、`scroll_direction`（up / down / left / right）、`scroll_amount`（行、既定 3） | |
| `key` | `text`（`"cmd+shift+a"`、`"Return"`、`"Page_Down"`。空白で区切ると順に） | 最前面のアプリに届く |
| `type` | `text` | 最前面のアプリに届く。1 文字ずつ。Esc で途中で止まる |
| `open_application` | `app` | 承認されたアプリだけ（見るだけのアプリも開ける） |
| `cursor_position` | — | 直前の screenshot の画素 |
| `wait` | `duration`（秒、最大 30） | |
| `zoom` | `region: [x0, y0, x1, y1]`（画素） | その矩形を高い解像度で撮り直す。座標の基準は変わらない |

- スクリーンショットは長辺 1456 画素に収め（`DEFAULT_SCREENSHOT_MAX`）、JPEG（品質 0.8）で返す。メインディスプレイだけ（段 1）
- annotations: 入力のツールは `readOnlyHint: false`・`destructiveHint: false`・`openWorldHint: false`。非対話の Codex に断られないため（peers と同じ）。関所は CLI の承認ではなく `request_access` とその先の人
- instructions には「最初に `request_access`」「ブラウザは見るだけ」「座標は直前の screenshot の画素」「Esc で止まったら作業をやめ、ユーザーに確かめてから頼み直す」を書く。アプリの語（Desk など）は入れない

### サーバーが自分で作る `reason`

| `reason` | いつ |
|---|---|
| `no-access` | まだ承認が無い |
| `expired` | `expiresAt` を過ぎた（スクリーンショットも断る。helper のセッションも終える） |
| `aborted` | ユーザーが Esc / メニューの停止を押した。新しい承認まで全部断る |
| `read-only` | 承認されたアプリが全部見るだけ（ブラウザ）なのに入力しようとした |
| `not-allowed` | 承認されていないアプリを開こうとした |
| `unknown-app` | インストールされていない名前 |
| `no-screenshot` | screenshot の前の座標 |
| `bad-request` | 引数がおかしい・画像の外の座標 |
| `server-unreachable` | 承認 API に繋がらない・形が違う |
| `helper-unavailable` | helper を起動できない・答えない |

helper の断り（`locked`、`not-allowed`、`permission` など、下）はそのまま渡す。

## helper

menu bar だけのアプリ（`LSUIElement`）。`~/Library/Application Support/synapse-desktop/helper.sock`（ディレクトリ 0700、socket 0600。`--socket <path>` で変える）で待ち、接続ごとに相手の uid が自分と同じかを確かめる。

### 取り決め（JSON lines）

1 行 1 リクエスト `{"id": 1, "op": "<name>", ...}`、1 行 1 応答 `{"id": 1, "ok": true, "result": {...}}` か `{"id": 1, "ok": false, "reason": "...", "error": "..."}`。`id` の無い `{"event": "aborted", "session": "<id>", "by": "esc" | "menu"}` は、Esc やメニューの停止のときに全接続へ送る。op の一覧は `Handler.swift` の冒頭。

| op | |
|---|---|
| `status` | 版、pid、`accessibility`（`AXIsProcessTrusted`）、`screenRecording`（`CGPreflightScreenCaptureAccess`）、`inputMonitoring`（`CGPreflightListenEventAccess`）、`escWatcher`、いまのセッション |
| `requestPermissions` | 3 つの権限のダイアログを出す |
| `listApps` / `resolveApps` | 動いているアプリと最前面、名前 → bundle id |
| `beginSession` / `endSession` | ロックを取り、見てよいアプリ（`apps`）と操作してよいアプリ（`inputApps`、`apps` の部分集合）と期限を置く |
| `screenshot` | ScreenCaptureKit。`SCContentFilter(display:including:)` に**承認されたアプリだけ**を渡すので、ほかのウィンドウ・壁紙・Dock・メニューバーはウィンドウサーバーの段階で写らない。承認されたアプリのウィンドウがメインディスプレイに 1 枚も出ていなければ `no-window`（下） |
| `openApp` / `cursor` / `click` / `move` / `mouseDown` / `mouseUp` / `drag` / `scroll` / `key` / `type` | CGEvent |

### helper が確かめること

- **1 セッションだけ**: `beginSession` は、別のセッションがロックを持ち、その接続が生きていて期限内なら `locked`（`holder` 付き）。ロックは `endSession`・接続が切れたとき・Esc で外れる。MCP サーバーは自分のセッション id（UUID）を毎回送る
- **入力の前に**: クリック・スクロール・ドラッグは、その点の一番手前のウィンドウの持ち主が `inputApps` にあるか。キーと文字は最前面のアプリが `inputApps` にあるか。違えば `not-allowed`（`app` 付き）。期限切れは `expired`
- **Esc**: listen-only の CGEventTap でキーを見て、ユーザーの Esc でセッションを捨て、`aborted` を送る。helper が送るイベントには印（`eventSourceUserData`）を付けてあるので、エージェントが `key Escape` を押しても止まらない。Esc はアプリにもそのまま届く（奪わない）。止めたセッションの次のリクエストには `aborted` を返す
- **権限**: 3 つ要る。アクセシビリティ（入力）、画面収録（`screenshot`）、入力監視（Esc の見張り）。アクセシビリティが無いと入力は `permission`（`permission: "accessibility"`）。Esc の見張りはキーボードのイベントタップで、**macOS 26 ではアクセシビリティだけでは作れず入力監視（`kTCCServiceListenEvent`）が要る**（listen-only でも能動のタップでも同じ。syn-6 で確かめた）。見張りが動いていないあいだは入力を断る（`permission: "inputMonitoring"`。止める手段が無いまま操作させない）。画面収録が無いと `screenshot` は `permission`（`permission: "screenRecording"`）
- **写すウィンドウが無い**: 承認されたアプリのウィンドウが、メインディスプレイにいま出ていない（別の操作スペース、フルスクリーンの別スペース、最小化、隠す、別のディスプレイ）と、ウィンドウサーバーは空の画像ではなく `SCStreamErrorDomain -3811`（internalError）で失敗する。権限の問題に見えるが違う（syn-6）。helper は撮る前に `SCShareableContent` の on-screen のウィンドウを見て、無ければ `no-window`（`apps` 付き）で断る。確かめたあとに消えたときの ScreenCaptureKit の失敗は `capture-failed`（`code` 付き）
- メニューバー: セッション中は赤い ●、ほかは ○。メニューに状態・「停止（Esc）」・権限の状態・「権限を求める…」・「終了」

### ビルド

```bash
packages/mcp/desktop-helper/build.sh            # release。--debug、--out <dir>、--sign <identity>
# → packages/mcp/desktop-helper/build/SynapseDesktopHelper.app（bundle id com.mizunowanko.synapse-desktop-helper）

# 証明書で署名する（権限がビルドし直しても残る）
packages/mcp/desktop-helper/build.sh --sign "Apple Development: …"
SYNAPSE_DESKTOP_SIGN_IDENTITY="Apple Development: …" packages/mcp/desktop-helper/build.sh   # 同じ
```

`swift build -c release` → `.app` の組み立て（`Info.plist`、`LSUIElement`、macOS 14 以上）→ `codesign`。`/Applications` には入れない。権限（システム設定 → プライバシーとセキュリティ → アクセシビリティ・画面収録・入力監視）は人が手で付ける。

- **署名**: `--sign <identity>`（無ければ環境変数 `SYNAPSE_DESKTOP_SIGN_IDENTITY`）があれば、その証明書で `codesign --force --sign <identity> --timestamp=none --identifier com.mizunowanko.synapse-desktop-helper`。identity は `security find-identity -v -p codesigning` に出る名前（`Apple Development: <名前> (<ID>)`）か SHA-1。hardened runtime も entitlements も付けない（公証しないし、要らない）。どちらも無ければ従来どおり ad hoc（`--sign -`）で、その旨を stderr に出す
- **TCC は署名の designated requirement に権限を結ぶ。** 証明書で署名すると要件は `identifier "com.mizunowanko.synapse-desktop-helper" and anchor apple generic and certificate leaf[subject.CN] = "…"` になり、**同じ identity でビルドし直しても権限が残る**（`codesign -d -r- <app>` で確かめられる）。ad hoc では要件が cdhash になり、ビルドし直すたびに 3 つの権限を付け直す
- ad hoc から証明書の署名に変えたとき（と identity を変えたとき）は、システム設定の 3 か所で helper を一度消して入れ直す
- 置き場所を決めたら、そこへコピーしてから権限を付ける（例: `~/Applications/SynapseDesktopHelper.app`）
- npm のパッケージには入らない（`files` は `dist` と `src`）

### MCP サーバーからの起動

socket が無い（か、繋がらない）と、MCP サーバーは helper を 1 度だけ起動して、socket が開くまで最大 10 秒待つ。

- `--helper-app <path>` があれば `open -g -a <path>`
- 無ければ、この checkout の `desktop-helper/build/SynapseDesktopHelper.app` があればそれ、それも無ければ `open -g -b com.mizunowanko.synapse-desktop-helper`（LaunchServices が知っている場所）
- `--socket` が既定と違えば `--args --socket <path>` を渡す

`open` で起動すると helper 自身が権限の持ち主になる。端末から実行ファイルを直接起動すると、端末（親）の権限を借りるので、確かめるときは `open` で起動する。

## 起動引数と登録

```
node …/dist/desktop/cli.js serve --api http://127.0.0.1:8001 --desk-id <id> [--token <t>] [--socket <path>] [--helper-app <app>] [--log /abs/desktop.jsonl] [--approval-timeout-ms 45000]
node …/dist/desktop/cli.js status [--socket <path>] [--helper-app <app>]     # helper の状態（無ければ起動）
```

| CLI | 関数 |
|---|---|
| Claude Code | `claudeDesktopMcpServers()`（`{ desktop: entry }`、`claudeMcpConfigArgs` で自分の server と 1 つの `--mcp-config` に） |
| Codex | `codexDesktopConfigArgs()`（`-c mcp_servers.desktop.…`） |
| agy | `agyDesktopPluginFiles()`（`.agents/plugins/synapse-desktop/`）、取り下げは `withdrawDesktopFiles("agy")` |

- サーバーの名前は既定で `desktop`（`mcp__desktop__screenshot`）。ほかの `desktop` という server と重なるなら、`name` で変える
- `--log` の JSONL には `initialized`・`tools/call`（ツール名・結果・`reason`）・`access`（`requestId`・`status`・bundle id）・`aborted` を残す。**画像と打った文字は書かない**（`type` は文字数だけ）
- `--token` を使うなら、peers と同じく起動のログに引数を出さない・agy の plugin は 0600

## 確かめ方

単体テスト（`server.test.ts`、`registration.test.ts`）は、偽の helper（一時ディレクトリの Unix socket）と偽の承認 API（`127.0.0.1`）に対して、承認・拒否・待ちきれないときの `pending` と再開・期限切れ・ブラウザを見るだけにする・ロック・Esc の伝わり方・座標の換算・`zoom` の矩形・helper の起動・ログに文字と画像が出ないことを見る。

helper は `swift build` が通ることと、`synapse-desktop status --socket /tmp/x.sock --helper-app <app>` で `open` 起動・socket の応答・`SIGTERM` で socket が消えることを見た（2026-11-01）。権限の無い helper に実の MCP サーバーから `request_access` → `screenshot` / `key` を送り、`permission` で断られることも見た。

2026-11-01（syn-6）、Apple Development の証明書で署名し 3 つの権限を付けた helper（`~/Applications/`、macOS 26）に socket から `status` → `beginSession`（計算機だけ）→ `screenshot` → `endSession` を送り、次を見た:

- 返った PNG（1456×946）と `region` 付きの JPEG に、計算機のウィンドウだけが写り、ほかのウィンドウ・壁紙・メニューバーが写らない
- 計算機を隠すと `no-window`、前に出すと撮れる（同じプロセスのまま。修正前はここで `-3811`）
- 同じ identity でビルドし直して置き換えても、`accessibility` / `screenRecording` / `inputMonitoring` / `escWatcher` が true のまま
- 入力監視が無いと `escWatcher` が false（アクセシビリティがあっても）

**まだ見ていないもの**: クリック・キー入力、Esc での中止、メニューバーの表示、複数のアプリを承認したときの写り方。

## 段 1 でやらないこと

- アプリの承認 UI と API（familia の後の段）
- 複数ディスプレイ（メインディスプレイだけ）、アクセシビリティの木の読み取り、クリップボード
- ターミナルや IDE を「クリックだけ」にするような、アプリの種類ごとの段階（ブラウザだけ見るだけにする）
