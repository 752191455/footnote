# Footnote

**Live trivia where every answer cites its source.**

A host types any topic. Footnote searches Wikipedia, reads the top articles, optionally colours the prompt with Exa, and has Claude write multiple-choice questions from the Wikipedia text only. It then runs the game live for everyone in the room. Each reveal shows the correct answer, how the room voted, and a footnote to the article it came from.

- Live: https://testproject.app.space
- Source: https://github.com/752191455/footnote
- Built on [DeepSpace](https://docs.deep.space) (Cloudflare Workers + Durable Objects)

## What it does

1. **Host.** Pick a topic, 5–12 questions, 10–30s per question, optional cover image or PDF via R2. The room opens immediately with a four-letter code so friends can join while questions are written (~10s).
2. **Join.** Invite link or code. Players take a seat automatically. The lobby shows who is seated, who is viewing (Presence), and live JobRoom generation progress.
3. **Play.** Shared countdown. Answers are final once locked. Faster correct answers score more (500–1000 plus a streak bonus). A round closes when time runs out or everyone has answered.
4. **Reveal.** Correct choice, vote distribution, one-line explanation, Wikipedia source (and lead photo). Standings show rank movement.
5. **Finish.** Podium, full standings, async Claude recap (`summaries` via JobRoom), host files, footnotes, Exa colour links.

The host plays too: nobody, host and app owner included, can see an answer before reveal.

## DeepSpace primitives used

| Primitive | Where | Why |
|---|---|---|
| **RecordRoom** (collections + RBAC) | [`src/schemas/trivia-schema.ts`](src/schemas/trivia-schema.ts) | Live “board”: `games` (board), `questions` / `players` / `submissions` (items), `summaries` (recaps), plus `answer_keys` and `reveal_locks`. All client roles are read-only. |
| **Server actions** | [`src/actions/trivia.ts`](src/actions/trivia.ts) | Only writers of game state. Each call re-checks identity, phase, and the **server** clock. |
| **JobRoom** | [`src/jobs.ts`](src/jobs.ts), [`quiz-generator.ts`](src/server/quiz-generator.ts), [`summarize-game.ts`](src/server/summarize-game.ts) | `generate-quiz` after create; `summarize-game` after finish so the UI stays responsive. Socket enqueue is refused (`authorizeWrite: () => false`). |
| **PresenceRoom** | [`play/[code].tsx`](src/pages/(app)/play/[code].tsx) | Who is viewing the board, separate from who has joined. |
| **Integration proxy** | `tools.integration(...)` in jobs | `wikipedia/search-pages`, `get-page-content`, `get-page-summary`; `exa/search`; `anthropic/chat-completion`. Owner-billed, 10 games/user/day. |
| **R2** (`useR2Files` → `/api/files/*`) | [`home.tsx`](src/pages/(app)/home.tsx) | Optional host cover + PDF/image, `scope: 'app'` so the room can embed without per-viewer auth. |
| **Auth** | nav, home, play | JWT-verified actions; names on the scoreboard. |
| **Row-level RBAC** | `answer_keys` unread; `submissions` `read: 'own'` | Answer secrecy is structural, not CSS. |
| **`uniqueOn`** | submissions, players, reveal_locks, summaries | One answer per player per question; one recap per game; reveal lock so two clients cannot score twice. |

### Left out on purpose

- **Gemini / OpenAI image generation.** A generated picture would look like a source and is not. Footnote only shows Wikimedia photos that belong to cited articles; they are cheaper and are themselves citations.
- **Yjs / messaging / canvas.** No shared editing. Chat on a timed quiz is mostly a way to leak answers.
- **Cron.** Abandoned rooms cost a few rows, not money. Cleanup is housekeeping, not product.
- **Payments.** The daily game cap is the spend brake.

## Main tradeoffs

**1. Server owns all game state, at the cost of one HTTP round trip per answer.**

The simple DeepSpace default would let clients `useMutations` to write answers and scores. That is slightly snappier, but anyone reading WebSocket frames could see the key, answer after time-up, or set their own score. Footnote sends every write through a server action that checks phase and the worker clock. The key lives in a collection no role can read and is copied onto the public question only at reveal. A `serverTime` offset keeps each client’s countdown aligned with “time’s up” on the server.

**2. Generation and recap run in JobRoom, not inside the HTTP request.**

Holding `createGame` open for ~10s works at this scale, but the host cannot share a code until it finishes, and a closed tab loses the work. Seating first (`generating` → `lobby` / `failed`) lets friends join during generation and gives every client the same progress bar. Finish does the same for `summarize-game` so the podium is instant. Cost: an extra Durable Object hop and a schema that admits half-built games.

**Smaller calls**

- **Haiku over a larger model.** Lobby latency and cost beat prose. Wikipedia grounding + server validation (4 distinct choices, valid source index, no duplicate prompts, shuffled positions) does the quality work.
- **Measured cost ≈ $0.013 / generated game** (about 1 Haiku call + Wikipedia; Exa/recap add a little). Scoring uses no paid APIs. 10 games/day ≈ $0.13/user.
- **Elapsed time is measured on arrival at the server.** A slow network loses a little speed bonus; that is simpler and harder to cheat than a client timestamp.
- **JobRoom socket writes are closed entirely.** Docs default to member/admin enqueue; here every job spends owner credits, so only actions enqueue after the daily cap.
- **Exa is colour, not a source.** Questions must still be answerable from Wikipedia excerpts. That keeps footnotes honest when search snippets are noisy.
- **R2 `scope: 'app'`.** Covers and PDFs are embeddable in the lobby without per-viewer auth. They are world-readable by key; we do not put private data there.

### Known limitations

- `createGame` is not atomic with enqueue. Failed enqueue marks the room `failed`. A crash mid-job leaves `generating` (maxAttempts is 1).
- Signed-in users can read `games` and `questions` (not keys, not others’ picks). Player-scoped games would need `collaboratorsField`.
- Daily cap is read-then-write; two simultaneous creates could slip one extra game.
- Rooms cap at 30 players to bound reveal write fan-out.
- Each reveal rebuilds totals from all submissions. Fine at this size.

## What the agent did

The coding agent (Cursor) read the DeepSpace skill and docs (`llms.txt` + file-upload / JobRoom / integrations pages) and the installed SDK types. It proposed the design and implemented it in this repo.

**Design**

- Server-authoritative actions instead of client mutations.
- Hidden `answer_keys` collection + reveal-time copy.
- `reveal_locks` + `uniqueOn` + idempotent `tallyPlayer`.
- JobRoom for generation (and later summarization); refuse socket writes.
- Wikipedia-only facts; Wikimedia photos as citations, not generated art.

**Implementation** (extended to applicant requests)

1. Scaffold → Footnote schemas, actions, lobby/play/reveal/finish UI, theme.
2. JobRoom `generate-quiz`: Wikipedia → Claude → validate → save; live `useJobs` bar.
3. Wikipedia lead images on lobby mosaic and reveal.
4. After a capabilities audit: `summaries` collection; `summarize-game` job on finish; `exa/search` enrichment; R2 cover/PDF upload on host form; Presence “N viewing”.
5. Optional Python FastAPI port in [`python/`](python/README.md) — DeepSpace cannot be rewritten in-place in Python; this is a sidecar, not the deploy.
6. Deploy to `testproject.app.space` (GitHub source ships the working tree) and push `main` to GitHub.

**Agent verification**

- `tsc --noEmit` and ESLint clean after the R2/Exa/summary work.
- **Unit tests 22/22** in [`src/lib/trivia.test.ts`](src/lib/trivia.test.ts): scoring, codes, Wikipedia HTML, question validation through shuffle, ranking, `tallyPlayer` idempotency.
- Earlier **smoke + API Playwright 11/11**, including unauthenticated `createGame` → 401. Fonts bundled (Fontsource) after Google Fonts flakes.
- After the latest deploy (`rel_01M3ZWP4N8BB0KFQTGCSEFHE7A`): live HTML 200; production chunks contain `cover-upload`, `game-summary`, `Host files`.
- **Not run by the agent:** `tests/collab.spec.ts` two-player full game (no second test account in that shell).

The agent did **not** invent credentials, force-push, or switch source authority. GitHub was already latched; `deepspace push` was not used.

## Applicant verification and changes

The product direction and extras came from the applicant, not from silently shipping a scaffold. The applicant asked for Wikipedia images, a Python sidecar (explicitly not replacing the Worker), and a DeepSpace capability pass (RecordRoom boards/items/summaries, Presence, JobRoom summarization, Anthropic + Exa, R2). The applicant committed (`picture`), approved production deploy, and requested the GitHub push.

The applicant **did not override** the agent’s core tradeoff (server-authoritative scoring, hidden keys, JobRoom enqueue-only-from-actions). No generated-image APIs were added.

**Checklist**

- [x] Live app: https://testproject.app.space (release `rel_01M3ZWP4N8BB0KFQTGCSEFHE7A`)
- [x] Played a full 5-question game on the live URL with one account; submit / reveal / next returned 200
- [x] `npx deepspace app usage`: about **$0.013 per generated game**
- [x] Source on GitHub: https://github.com/752191455/footnote (`main` includes R2 / Exa / summaries)
- [ ] Two-account live game (host + guest), including join during `generating`
- [ ] Early reveal when both answered vs timer reveal when one sits out
- [ ] Confirm JobRoom lobby: code appears immediately, progress moves, Start enables on `lobby`
- [ ] After this release: host optional cover/PDF; finish screen recap

Fill remaining boxes by playing on the live URL before the application deadline.

## Running locally

```bash
npm install
npx deepspace dev start                 # http://localhost:5173
npx deepspace test run all --port 5180  # two test accounts for collab.spec.ts
npx deepspace deploy
```

Python sidecar (not the DeepSpace deploy): `cd python && python main.py` → http://localhost:8000

### Code map

- [`src/schemas/trivia-schema.ts`](src/schemas/trivia-schema.ts) — collections and RBAC; start here.
- [`src/actions/trivia.ts`](src/actions/trivia.ts) — state machine.
- [`src/server/quiz-generator.ts`](src/server/quiz-generator.ts) — Wikipedia → Exa → Claude → save.
- [`src/server/summarize-game.ts`](src/server/summarize-game.ts) — post-game recap.
- [`src/jobs.ts`](src/jobs.ts) — JobRoom handlers.
- [`src/lib/trivia.ts`](src/lib/trivia.ts) — pure logic, unit-tested.
- [`src/pages/(app)/play/[code].tsx`](src/pages/(app)/play/[code].tsx) — game room.
- [`src/pages/(app)/home.tsx`](src/pages/(app)/home.tsx) — host / join / R2.

---

# Footnote（中文）

**现场知识竞赛：每一道题的答案都带出处。**

主持人输入任意主题。Footnote 检索维基百科、阅读前几篇条目，可用 Exa 给出题角度作补充，再由 Claude **仅根据维基正文** 写出选择题，并在房间里实时开赛。每次揭晓都会显示正确答案、全场选项分布，以及指向原文的脚注。

- 线上：https://testproject.app.space
- 源码：https://github.com/752191455/footnote
- 基于 [DeepSpace](https://docs.deep.space)（Cloudflare Workers + Durable Objects）

## 项目内容

1. **主持。** 选择主题、题量（5–12）与答题时限（10–30 秒），可选经 R2 上传封面或 PDF。房间立刻给出四字母口令，出题在后台进行（约 10 秒），朋友可边写边进。
2. **加入。** 邀请链接或口令。玩家自动入座。大厅显示已入座人数、正在观看人数（Presence），以及 JobRoom 出题进度。
3. **作答。** 共用倒计时。提交即锁定。答对且更快得分更高（500–1000 加连击）。时间到或全员答完即收题。
4. **揭晓。** 正确答案、选项分布、一句解释、维基出处（及条目配图）。积分榜显示名次变化。
5. **结束。** 领奖台、完整积分、异步 Claude 赛后综述（`summaries` + JobRoom）、主持人上传文件、脚注与 Exa 链接。

主持人也参赛：揭晓前任何人（含主持人和应用所有者）都看不到答案。

## 使用的 DeepSpace 集成

| 能力 | 位置 | 用途 |
|---|---|---|
| **RecordRoom**（集合 + RBAC） | [`src/schemas/trivia-schema.ts`](src/schemas/trivia-schema.ts) | 实时「看板」：`games`（board）、`questions` / `players` / `submissions`（items）、`summaries`（综述），以及 `answer_keys`、`reveal_locks`。客户端角色全部只读。 |
| **Server actions** | [`src/actions/trivia.ts`](src/actions/trivia.ts) | 对局状态的唯一写入口。每次都校验身份、阶段与**服务器**时钟。 |
| **JobRoom** | [`src/jobs.ts`](src/jobs.ts)、[`quiz-generator.ts`](src/server/quiz-generator.ts)、[`summarize-game.ts`](src/server/summarize-game.ts) | 创建后异步 `generate-quiz`；结束后异步 `summarize-game`，界面保持响应。禁止经 WebSocket 入队（`authorizeWrite: () => false`）。 |
| **PresenceRoom** | [`play/[code].tsx`](src/pages/(app)/play/[code].tsx) | 「谁在看」与「谁已入座」分开。 |
| **Integration proxy** | 任务里的 `tools.integration(...)` | `wikipedia/search-pages`、`get-page-content`、`get-page-summary`；`exa/search`；`anthropic/chat-completion`。开发者付费，每人每天 10 局上限。 |
| **R2**（`useR2Files` → `/api/files/*`） | [`home.tsx`](src/pages/(app)/home.tsx) | 可选封面与 PDF/图片；`scope: 'app'`，大厅无需按观看者鉴权即可嵌入。 |
| **Auth** | 导航、首页、对局页 | JWT 校验动作；积分榜显示姓名。 |
| **行级 RBAC** | `answer_keys` 不可读；`submissions` 为 `read: 'own'` | 答案保密写在 Durable Object 权限里，不是用 CSS 藏字段。 |
| **`uniqueOn`** | submissions、players、reveal_locks、summaries | 每人每题一答；每局一篇综述；揭晓锁防止双计分。 |

### 有意不用

- **Gemini / OpenAI 生成图。** 生成图会像「出处」却不是出处。Footnote 只展示被引用条目上的维基/共享资源图片；更便宜，且本身就是引用。
- **Yjs / 消息 / 画布。** 不需要协同编辑。限时答题加聊天更容易漏题。
- **Cron。** 废弃房间几乎不花钱。定时清理是运维打扫，不是产品价值。
- **Payments。** 付费不在范围内；每日局数上限就是花费闸门。

## 主要权衡

**1. 服务器独占对局状态，代价是每次作答多一次 HTTP。**

更简单的 DeepSpace 默认做法是客户端用 `useMutations` 直接写答案和分数。手感略快，但看 WebSocket 就能看到答案、超时作答或改分。Footnote 所有写入都走服务端动作：核对阶段与 Worker 时钟。密钥在任何角色都读不到的集合里，揭晓时才拷到公开题目上。`serverTime` 校准倒计时，使「时间到」以服务器为准。

**2. 出题与综述放在 JobRoom，而不是卡在 HTTP 请求里。**

把 `createGame` 挂起约 10 秒在这个规模能跑，但口令要等写完才能分享，关标签会丢任务。先落座再出题（`generating` → `lobby` / `failed`），朋友能在生成中加入，全场看同一进度条。结束时同样异步写 `summarize-game`，领奖台立刻出来。代价是多一次 Durable Object，以及允许「半成品对局」的状态机。

**更小的取舍**

- **用 Haiku 而不是更大模型。** 大厅更在意延迟和费用。质量靠维基锚定和服务器校验（四选项不重复、合法出处、无重复题干、打乱位置）。
- **实测成本约每局 $0.013**（约 1 次 Haiku + 维基；Exa/综述略增）。作答不计费 API。每人每天 10 局大约 $0.13。
- **用到达服务器的时间计分。** 网慢会少一点速度分，但比信任浏览器时间戳更难作弊。
- **完全关闭 JobRoom 套接字写入。** 文档默认成员/管理员可入队；这里每笔任务花的是所有者额度，因此只允许校验过且过日限额的动作入队。
- **Exa 只影响出题角度，不能当出处。** 题目仍必须能从维基摘录中回答，搜索摘要嘈杂时脚注仍诚实。
- **R2 使用 `scope: 'app'`。** 封面和 PDF 大厅可直接嵌入。知道 key 即可读；不放隐私内容。

### 已知限制

- `createGame` 与入队非原子。入队失败则房间标为 `failed`；任务中途崩溃会停在 `generating`（maxAttempts 为 1）。
- 登录用户可读 `games` 与 `questions`（不能读密钥和别人的选项）。按玩家收窄需 `collaboratorsField`。
- 日限额是先读后写，并发创建可能多出一局。
- 每房最多 30 人，限制揭晓时的写入扇出。
- 每次揭晓从全部作答重算总分。当前规模可接受。

## Agent 执行的任务

编码智能体（Cursor）阅读 DeepSpace skill/文档（`llms.txt` 以及文件上传 / JobRoom / 集成相关页）与已安装 SDK 类型，提出方案并在本仓库落地。

**设计**

- 服务端权威动作，而非客户端直接改记录。
- 隐藏 `answer_keys` 集合，揭晓时再拷贝。
- `reveal_locks` + `uniqueOn` + 可重入的 `tallyPlayer`。
- JobRoom 出题（及后续综述）；禁止套接字入队。
- 事实只来自维基；配图用条目图片当引用，不用生成图。

**实现**（按申请人后续要求扩展）

1. 从脚手架做出题库、动作、大厅/作答/揭晓/结束界面与主题。
2. JobRoom `generate-quiz`：维基 → Claude → 校验 → 落库；大厅 `useJobs` 进度条。
3. 大厅拼贴与揭晓页的维基条目配图。
4. 能力清单补齐：`summaries` 集合；结束时 `summarize-game`；`exa/search` enrichment；主持表单 R2 封面/PDF；Presence「N viewing」。
5. 可选 Python FastAPI 移植在 [`python/`](python/README.md)——DeepSpace 不能原地改成 Python；这是旁路实现，不是线上部署。
6. 部署到 `testproject.app.space`（GitHub 源会发布工作树），并将 `main` 推送到 GitHub。

**智能体侧验证**

- R2 / Exa / 综述工作后，`tsc --noEmit` 与 ESLint 通过。
- **单元测试 22/22**（[`src/lib/trivia.test.ts`](src/lib/trivia.test.ts)）：计分、房间码、维基 HTML、选项打乱后仍跟踪正确答案、排名、`tallyPlayer` 幂等。
- 此前 **冒烟 + API Playwright 11/11**，含未登录 `createGame` → 401。外网字体失败后改为 Fontsource 内置。
- 最新发布（`rel_01M3ZWP4N8BB0KFQTGCSEFHE7A`）：线上 HTML 200；产物含 `cover-upload`、`game-summary`、`Host files`。
- **智能体未跑：** `tests/collab.spec.ts` 双人完整对局（当时 shell 没有第二个测试账号）。

智能体未编造凭据、未 force-push、未切换源控。应用已锁定 GitHub 源，未使用 `deepspace push`。

## 申请人验证与修改

产品方向和增量功能由申请人提出，不是默默交一份脚手架。申请人要求维基配图、Python 旁路（明确不替换 Worker），以及补齐 DeepSpace 能力（RecordRoom boards/items/summaries、Presence、JobRoom 综述、Anthropic + Exa、R2）。申请人提交了 `picture`、批准生产部署，并要求推送到 GitHub。

申请人**没有推翻**智能体的核心取舍（服务端计分、隐藏密钥、仅动作入队）。没有加入生成图 API。

**核对清单**

- [x] 线上应用：https://testproject.app.space（发布 `rel_01M3ZWP4N8BB0KFQTGCSEFHE7A`）
- [x] 线上单账号完整打完 5 题；作答 / 揭晓 / 下一题均返回 200
- [x] `npx deepspace app usage`：约 **每局 $0.013**
- [x] 源码在 GitHub：https://github.com/752191455/footnote（`main` 含 R2 / Exa / summaries）
- [ ] 双账号实战（主持 + 嘉宾），含在 `generating` 时加入
- [ ] 全员答完提前揭晓 vs 有人空过靠计时揭晓
- [ ] 确认 JobRoom 大厅：口令立刻出现、进度条前进、进入 `lobby` 后可开始
- [ ] 本版上线后：主持可选封面/PDF；结束页综述

截止日期前请用线上地址补完未勾项。

## 本地运行

```bash
npm install
npx deepspace dev start                 # http://localhost:5173
npx deepspace test run all --port 5180  # collab.spec.ts 需要两个测试账号
npx deepspace deploy
```

Python 旁路（不是 DeepSpace 发布）：`cd python && python main.py` → http://localhost:8000

### 代码地图

- [`src/schemas/trivia-schema.ts`](src/schemas/trivia-schema.ts) — 集合与 RBAC；建议先读。
- [`src/actions/trivia.ts`](src/actions/trivia.ts) — 状态机。
- [`src/server/quiz-generator.ts`](src/server/quiz-generator.ts) — 维基 → Exa → Claude → 落库。
- [`src/server/summarize-game.ts`](src/server/summarize-game.ts) — 赛后综述。
- [`src/jobs.ts`](src/jobs.ts) — JobRoom 处理器。
- [`src/lib/trivia.ts`](src/lib/trivia.ts) — 纯逻辑，有单元测试。
- [`src/pages/(app)/play/[code].tsx`](src/pages/(app)/play/[code].tsx) — 对局页。
- [`src/pages/(app)/home.tsx`](src/pages/(app)/home.tsx) — 主持 / 加入 / R2。
