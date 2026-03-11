# Agent Teams Plugin — 架構全解析 & 使用情景

---

## 系統總覽

```
┌─────────────────────────── OpenClaw Runtime ────────────────────────────┐
│                                                                         │
│  ┌───────────────────── Agent Teams Plugin ──────────────────────────┐  │
│  │                                                                   │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐     │  │
│  │  │  Hooks   │  │  Tools   │  │ Commands │  │   Registry   │     │  │
│  │  │ (5 hooks)│  │ (5 tools)│  │ (3 cmds) │  │ (singleton)  │     │  │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘     │  │
│  │       └──────────────┴─────────────┴───────────────┘             │  │
│  │                              │                                    │  │
│  │       ┌──────────────── TeamStores (per team) ──────────────┐    │  │
│  │       │                                                      │    │  │
│  │       │  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  │    │  │
│  │       │  │   KvStore   │  │  EventQueue  │  │  DocPool  │  │    │  │
│  │       │  │ 256 max     │  │ 500 ring buf │  │  50MB max │  │    │  │
│  │       │  └─────────────┘  └──────────────┘  └───────────┘  │    │  │
│  │       │  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  │    │  │
│  │       │  │ RunManager  │  │ MessageStore │  │ActivityLog│  │    │  │
│  │       │  │ 1 active run│  │ per-user q's │  │10K→archive│  │    │  │
│  │       │  └─────────────┘  └──────────────┘  └─────┬─────┘  │    │  │
│  │       └───────────────────────┬───────────────────┘│────────┘    │  │
│  │                               │            onEntry │             │  │
│  │                               │                    ▼             │  │
│  │                               │          ┌───────────────┐       │  │
│  │                               │          │  Broadcaster  │       │  │
│  │                               │          │   (.jsonl)    │       │  │
│  │                               │          └───────┬───────┘       │  │
│  └───────────────────────────────┼──────────────────┼───────────────┘  │
│                                  │                  │                   │
│  Agents: at--team--member        │                  │                   │
└──────────────────────────────────┼──────────────────┼───────────────────┘
                                   │                  │
                    atomic writes  │                  │ append
                    (tmp + rename) ▼                  ▼
               ~/.openclaw/plugins/          broadcast.jsonl
               agent-teams/team/             (tail -f | jq)
```

---

## Task 狀態機

```
                    ┌─────────────────────────────────────────────┐
                    │              depends_on 尚未完成              │
                    ▼                                             │
               ┌─────────┐                                       │
      ┌───────>│ BLOCKED │────── cascade cancel ──────┐          │
      │        └────┬────┘                            │          │
      │             │ 所有 deps COMPLETED              │          │
      │             ▼                                  │          │
      │        ┌─────────┐                            │          │
(init)├───────>│ PENDING │────── cascade cancel ──┐   │          │
      │        └────┬────┘                        │   │          │
      │             │ agent 認領                   │   │          │
      │             ▼                              │   │          │
      │        ┌─────────┐                        │   │          │
      │        │ WORKING │                        │   │          │
      │        └──┬─┬─┬──┘                        │   │          │
      │           │ │ │                            │   │          │
      │    ┌──────┘ │ └───────┐                   │   │          │
      │    │        │         │                   ▼   ▼          │
      │    ▼        ▼         ▼              ┌──────────┐        │
      │ COMPLETED  FAILED  CANCELED          │ CANCELED │        │
      │                                      └──────────┘        │
      │    ┌────────────────────┐                                │
      └────│  INPUT_REQUIRED    │←── 需要 input ── WORKING       │
           │  (收到後 → WORKING)│                                 │
           └────────────────────┘                                │
```

---

## 三層路由系統

```
  routeTask(teamConfig, description, ...)
                    │
  ┌─────────────────▼──────────────────────── Layer 1: Direct Assignment ─┐
  │  assign_to 有值?                                                      │
  │    YES ──► direct_assign (直接指派)                                    │
  │    NO  ──► 進入 Layer 2                                               │
  └───────────────────────────────────────────────────────────────────────┘
                    │
  ┌─────────────────▼──────────────────────── Layer 2: Skill-Based Match ─┐
  │  required_skills 有值?                                                 │
  │    NO  ──► 進入 Layer 3                                               │
  │    YES ──► findSkillCandidates()                                      │
  │              │                                                         │
  │              ├─ Exact Match? (全部技能符合)                              │
  │              │    YES ──► loadBalance() → skill_exact_match            │
  │              │    NO  ──► Partial Match?                               │
  │              │              YES ──► sort by overlap ↓                  │
  │              │                      → top tier → loadBalance()         │
  │              │                      → skill_best_fit                   │
  │              │              NO  ──► 進入 Layer 3                       │
  └───────────────────────────────────────────────────────────────────────┘
                    │
  ┌─────────────────▼──────────────────────── Layer 3: Fallback ──────────┐
  │  coordination mode?                                                    │
  │    orchestrator ──► fallback_to_orchestrator                           │
  │    peer + caller ──► peer_auto_assign (指派給自己)                      │
  │    peer, no caller ──► fallback_first_member                          │
  └───────────────────────────────────────────────────────────────────────┘
```

**Load Balance 機制:** 計算每個候選人的 active tasks (PENDING + WORKING)，選擇負載最低的成員。

---

# 使用情景

---

## 情景 1: 最簡單 — 單人團隊，手動任務 (Peer Mode)

**配置:**
```yaml
teams:
  solo:
    description: "Solo developer"
    coordination: peer
    members:
      dev: { role: "Full-stack developer" }
```

```
  User                  Leader              at--solo--dev
   │                      │                      │
   │  "幫我建一個 API"    │                      │
   │─────────────────────>│                      │
   │                      │                      │
   │                      │  team_run(start)     │
   │                      │─────────────────────>│ run_id: tr-20260310-1815
   │                      │                      │
   │                      │  team_task(create,   │
   │                      │  desc="設計 API")    │
   │                      │─────────────────────>│ routeTask() L3
   │                      │                      │ peer_auto_assign → dev
   │                      │                      │ task-xxx: PENDING
   │                      │                      │
   │                      │         ┌────────────────────────────┐
   │                      │         │ agent_start hook 注入:      │
   │                      │         │ Role: Full-stack developer  │
   │                      │         │ Goal: 建 API               │
   │                      │         │ Decision Flow (Peer)       │
   │                      │         └────────────────────────────┘
   │                      │                      │
   │                      │              ...dev 完成工作...
   │                      │                      │
   │                      │                      │── team_task(update,
   │                      │                      │   task-xxx, COMPLETED,
   │                      │                      │   result="API 已完成")
   │                      │                      │
   │                      │                      │   buildLearning():
   │                      │                      │   result>50 chars → auto
   │                      │                      │
   │                      │                      │── team_run(complete)
   │                      │                      │   collectLearnings()
   │                      │                      │   archiveRun()
   │                      │                      │
   │       "API 已完成"   │                      │
   │<─────────────────────│                      │
```

**內部機轉:**
1. `team_run(start)` → `RunManager.startRun("solo", "建 API")` → 建立 `tr-YYYYMMDD-HHMM`
2. `team_task(create)` → `routeTask()` Layer 3 fallback → `peer_auto_assign` → 指派給 caller 自己
3. `shouldBlock([])` → false → 初始狀態 `PENDING`
4. `agent_start` hook → 注入 peer decision flow、goal、tools guide
5. `team_task(update, COMPLETED)` → `buildLearning()` → 如果 result > 50 chars → 自動捕捉 insight
6. `team_run(complete)` → `collectLearnings()` → 收集所有 KV 中的 learnings → archive run

---

## 情景 2: 標準 Orchestrator 模式 — 多人協作

**配置:**
```yaml
teams:
  product:
    description: "Product development team"
    coordination: orchestrator
    orchestrator: pm
    members:
      pm:       { role: "Product Manager", skills: [planning, coordination] }
      frontend: { role: "Frontend Developer", skills: [react, css, ui] }
      backend:  { role: "Backend Developer", skills: [api, database, python] }
      qa:       { role: "QA Engineer", skills: [testing, automation] }
```

```
  User         PM               FE              BE              QA
   │            │                │                │               │
   │ "建電商    │                │                │               │
   │  結帳功能" │                │                │               │
   │───────────>│                │                │               │
   │            │                │                │               │
   │            │ ┌──────────────────────────────────────┐        │
   │            │ │ agent_start hook:                     │        │
   │            │ │ Role: Product Manager                 │        │
   │            │ │ Decision Flow (Orchestrator)          │        │
   │            │ │ Team: pm, frontend, backend, qa       │        │
   │            │ └──────────────────────────────────────┘        │
   │            │                │                │               │
   │            │── team_run(start, goal="電商結帳功能")           │
   │            │   run_id: tr-xxx                │               │
   │            │                │                │               │
   │            │── team_task(create, "設計 API",  │               │
   │            │   required_skills=[api,database])│               │
   │            │   → Layer 2 skill_exact_match → backend         │
   │            │   → status: PENDING             │               │
   │            │                │                │               │
   │            │── team_task(create, "建結帳 UI", │               │
   │            │   required_skills=[react,ui],   │               │
   │            │   depends_on=["task-api"])       │               │
   │            │   → skill_exact → frontend      │               │
   │            │   → status: BLOCKED             │               │
   │            │                │                │               │
   │            │── team_task(create, "寫測試",    │               │
   │            │   assign_to="qa",               │               │
   │            │   depends_on=["task-api","task-ui"])             │
   │            │   → direct_assign → qa          │               │
   │            │   → status: BLOCKED             │               │
   │            │                │                │               │
   │            │── team_send(to="backend",       │               │
   │            │   message="開始 API")           │               │
   │            │                │                │               │
   │            │                │    ┌───────────────────────┐   │
   │            │                │    │ agent_start hook:      │   │
   │            │                │    │ Role: Backend Dev      │   │
   │            │                │    │ Decision Flow (Member) │   │
   │            │                │    └───────────────────────┘   │
   │            │                │                │               │
   │            │                │     team_inbox()│               │
   │            │                │     ← 讀取 pm 的訊息           │
   │            │                │                │               │
   │            │                │     team_task(update,          │
   │            │                │     task-api, WORKING)         │
   │            │                │                │               │
   │            │                │         ...backend 工作...     │
   │            │                │                │               │
   │            │                │     team_memory(set,           │
   │            │                │     "api-spec","...")           │
   │            │                │     → activity.log(memory_updated)
   │            │                │                │               │
   │            │                │     team_task(update,          │
   │            │                │     task-api, COMPLETED)       │
   │            │                │                │               │
   │            │                │     ┌──────────────────────────┐
   │            │                │     │ resolveDependencies():   │
   │            │                │     │ task-ui: BLOCKED→PENDING │
   │            │                │     │ task-test: 仍 BLOCKED    │
   │            │                │     │ (task-ui 未完成)         │
   │            │                │     └──────────────────────────┘
   │            │                │                │               │
   │            │                │     ┌──────────────────────────┐
   │            │                │     │ delivery_target hook:    │
   │            │                │     │ backend → redirect → pm  │
   │            │                │     └──────────────────────────┘
   │            │<───────────────────── [結果 deliver 到 pm]      │
   │            │                │                │               │
   │            │── team_send(to="frontend",      │               │
   │            │   "UI task unblocked")          │               │
   │            │                │                │               │
   │            │           agent_start           │               │
   │            │                │                │               │
   │            │     team_task(update,           │               │
   │            │     task-ui, COMPLETED)         │               │
   │            │                │                │               │
   │            │                │  resolveDependencies():        │
   │            │                │  task-test: BLOCKED→PENDING    │
   │            │                │                │               │
   │            │<────── [結果 deliver 到 pm]      │               │
   │            │                │                │               │
   │            │── team_send(to="qa", "開始測試") │               │
   │            │                │                │               │
   │            │                │                │  team_task(update,
   │            │                │                │  task-test, COMPLETED)
   │            │<──────────────────────────────── [deliver to pm]│
   │            │                │                │               │
   │            │── team_run(complete, "電商結帳完成")             │
   │  "完成"    │                │                │               │
   │<───────────│                │                │               │
```

### Dependency Resolution 詳細流程

```
  ┌─────────────── 初始狀態 ──────────────────┐
  │                                            │
  │  task-api  [PENDING]   depends_on: []      │
  │  task-ui   [BLOCKED]   depends_on: [api]   │
  │  task-test [BLOCKED]   depends_on: [api,ui]│
  │                                            │
  └────────────────────┬───────────────────────┘
                       │
                       │ task-api → COMPLETED
                       ▼
          resolveDependencies(tasks, 'task-api')
                       │
                       │ completedIds = {task-api}
                       │
            ┌──────────┴──────────┐
            │                     │
            ▼                     ▼
     task-ui:               task-test:
     deps = [task-api]      deps = [task-api, task-ui]
     全部在 completedIds?   task-ui 不在 completedIds
     YES ✓                  NO ✗
            │                     │
            ▼                     ▼
    BLOCKED → PENDING ✓     仍然 BLOCKED
            │
            │ task-ui → COMPLETED
            ▼
  resolveDependencies(tasks, 'task-ui')
            │
            │ completedIds = {task-api, task-ui}
            ▼
     task-test:
     deps = [task-api ✓, task-ui ✓]
     全部 ✓
            │
            ▼
    BLOCKED → PENDING ✓✓
```

### Delivery Target Hook — 訊息重定向

```
  at--product--backend 完成工作
  要 deliver 結果
          │
          ▼
  delivery_target hook 觸發
          │
          ▼
     isTeamAgent?
      │        │
     No       Yes
      │        │
      ▼        ▼
   Pass    parseAgentId()
           → team: product, member: backend
                │
                ▼
           coordination === orchestrator?
            │        │
           No       Yes
            │        │
            ▼        ▼
          Pass    member === orchestrator?
                   │        │
                  Yes       No
                   │        │
                   ▼        ▼
                 Pass    找 pm 的 sessionKey
                              │
                              ▼
                         sessionKey 存在?
                          │        │
                         No       Yes
                          │        │
                          ▼        ▼
                        Pass    ★ Redirect
                                → at--product--pm 的 session
```

---

## 情景 3: Workflow Template — 自動化流水線 + Fail-Loopback

**配置:**
```yaml
teams:
  pipeline:
    coordination: orchestrator
    orchestrator: lead
    members:
      lead:     { role: "Lead" }
      designer: { role: "Designer", skills: [design, ui] }
      coder:    { role: "Engineer", skills: [coding, api] }
      reviewer: { role: "Reviewer", skills: [review, testing] }
    workflow:
      template:
        stages:
          - { name: design, role: designer }
          - { name: implement, role: coder }
          - { name: review, role: reviewer }
        fail_handlers:
          review: implement
          implement: design
```

### 正常流程

```
  team_run(start)
       │
       ▼
  generateTaskChain()
       │
       ├──► design     [PENDING]   → designer   (no deps)
       ├──► implement  [BLOCKED]   → coder      (depends: [design])
       └──► review     [BLOCKED]   → reviewer   (depends: [implement])

  Timeline:
  ─────────────────────────────────────────────────────►

  design          implement         review
  ┌────────┐      ┌────────┐       ┌────────┐
  │PENDING │      │BLOCKED │       │BLOCKED │
  │  ...   │      │        │       │        │
  │COMPLETED│─────>│PENDING │       │        │
  └────────┘  unblock│  ...  │       │        │
                  │COMPLETED│──────>│PENDING │
                  └────────┘  unblock│  ...  │
                                    │COMPLETED│
                                    └────────┘
                                         │
                                    Run COMPLETED ✓
```

### Fail-Loopback 流程 (review 失敗)

```
  team_task(update, task-review, status=FAILED, message="品質不合格")
       │
       ▼
  enforceGates()              ← 檢查 gate 限制
       │
       ▼
  buildLearning()             ← auto-capture failure, confidence: 0.5
       │
       ▼
  handleFailLoopback(template, "review", failedTask, ...)
       │
       │  fail_handlers["review"] = "implement"
       │
       ├──► 建立 rework task:
       │    id: task-{runId}-rework-implement-{ts}
       │    desc: "[implement - rework] ..."
       │    status: PENDING
       │    assigned_to: coder
       │
       ├──► 找 downstream stages: review → 需要 re-block
       │
       ▼
  addTask(reworkTask) + updateTask(review, BLOCKED)
       │
       ▼
  activity.log(workflow_fail_loopback) + save()


  ┌─────── BEFORE loopback ──────┐     ┌─────── AFTER loopback ────────────┐
  │                               │     │                                    │
  │  design    [COMPLETED]        │     │  design           [COMPLETED]      │
  │     │                         │     │     │                              │
  │     ▼                         │     │     ▼                              │
  │  implement [COMPLETED]        │     │  implement        [COMPLETED]      │
  │     │                         │     │     │                              │
  │     ▼                         │     │     ▼                              │
  │  review    [WORKING]          │     │  review           [FAILED] ✗       │
  │                               │     │                      │             │
  └───────────────────────────────┘     │            fail_handler            │
                                        │                      ▼             │
               review FAILED            │  implement-rework  [PENDING] 🔄   │
              ─────────────►            │                      │             │
                                        │              完成後 unblock        │
                                        │                      ▼             │
                                        │  review (orig)     [BLOCKED]       │
                                        │                                    │
                                        └────────────────────────────────────┘
```

---

## 情景 4: Peer Mode — 對等協作 + Event Pub/Sub

**配置:**
```yaml
teams:
  research:
    description: "Research team"
    coordination: peer
    members:
      alice: { role: "Researcher", skills: [analysis, writing] }
      bob:   { role: "Researcher", skills: [data, visualization] }
      carol: { role: "Researcher", skills: [analysis, data] }
```

```
  alice              bob               carol           EQ        KV/DocPool  AL
   │                  │                  │              │            │         │
   │ team_run(start, goal="市場分析報告")│              │            │         │
   │                  │                  │              │            │         │
   │  === 平行建立任務 ═══════════════════════════════════════════            │
   │                  │                  │              │            │         │
   │ team_task(create,│                  │              │            │         │
   │ "競品分析")      │                  │              │            │         │
   │ → auto → alice   │                  │              │            │         │
   │                  │                  │              │            │         │
   │           team_task(create,         │              │            │         │
   │           "市場數據收集")           │              │            │         │
   │           → auto → bob              │              │            │         │
   │                  │                  │              │            │         │
   │                  │        team_task(create,        │            │         │
   │                  │        "趨勢分析")              │            │         │
   │                  │        → auto → carol           │            │         │
   │                  │                  │              │            │         │
   │  === 大家各自工作 ═══════════════════════════════════════════            │
   │                  │                  │              │            │         │
   │ team_send(topic="findings",         │              │            │         │
   │  message="發現競品X",               │              │            │         │
   │  data='{"competitor":"X"}')────────────────────────>│           │         │
   │                  │                  │    publish() │            │         │
   │                  │                  │              │            │         │
   │           team_inbox(topic="findings")             │            │         │
   │                  │─────────────────────────────────>│           │         │
   │                  │<─ [{alice, "競品X..."}]          │           │         │
   │                  │                  │              │            │         │
   │                  │        team_inbox(source="activity",         │         │
   │                  │        filter_type="task_completed")─────────────────>│
   │                  │                  │<── 查看誰完成了什麼       │         │
   │                  │                  │              │            │         │
   │ team_memory(set, store="docs",      │              │            │         │
   │  key="competitor-analysis",         │              │            │         │
   │  value="# 競品分析...")─────────────────────────────────────>│  │         │
   │                  │                  │              │            │         │
   │           team_memory(get, store="docs",           │            │         │
   │           key="competitor-analysis")────────────────────────>│  │         │
   │                  │<── 讀取 alice 的分析結果         │           │         │
   │                  │                  │              │            │         │
   │  === 所有人完成 ═══════════════════════════════════════════              │
   │                  │                  │              │            │         │
   │ team_run(complete, result="報告完成")│              │            │         │
```

**Peer Mode 關鍵差異:**

```
  ┌─────── Orchestrator Mode ──────┐    ┌─────── Peer Mode ────────────────┐
  │                                │    │                                   │
  │  Delivery → 重定向到 orchestrator│    │  Delivery → 直接給 requester      │
  │  Fallback → orchestrator       │    │  Fallback → assign 給自己         │
  │  Decision → 委派、監控、整合    │    │  Decision → 自主、共享、平行      │
  │  Complete → 只有 orchestrator   │    │  Complete → 任何人都可以          │
  │                                │    │                                   │
  └────────────────────────────────┘    └───────────────────────────────────┘
```

---

## 情景 5: Gate Enforcement — 品質閘門

**配置:**
```yaml
workflow:
  gates:
    COMPLETED:
      require_deliverables: true
      require_result: true
      approver: orchestrator
```

```
  team_task(update, task-1, status=COMPLETED)
       │
       ▼
  enforceGates()
       │
       ├─── require_deliverables?
       │     │
       │     ├── Yes + 沒有 deliverables → ❌ "requires at least one deliverable"
       │     │
       │     └── 有 deliverables ──┐
       │                           │
       ├─── require_result? ◄──────┘
       │     │
       │     ├── Yes + 沒有 result → ❌ "requires a result summary"
       │     │
       │     └── 有 result ──┐
       │                     │
       ├─── approver? ◄──────┘
       │     │
       │     ├── orchestrator + caller ≠ lead → ❌ "only lead can transition"
       │     │
       │     └── caller === lead → ✅ Gate PASS
       │
       ▼
  狀態更新完成
```

**正確的通過流程:**

```
  at--strict--dev                    at--strict--lead
       │                                  │
       │ team_task(update, task-1,        │
       │  deliverables=[                  │
       │    {type:"file", path:"/out.md"} │
       │  ])                              │
       │  → 附加 deliverables             │
       │                                  │
       │ team_task(update, task-1,        │
       │  result="實作完成，已通過單元測試")│
       │  → 設定 result                   │
       │                                  │
       │ team_send(to="lead",             │
       │  message="task-1 已準備好")      │
       │─────────────────────────────────>│
       │                                  │
       │                                  │ team_task(update,
       │                                  │  task-1, status=COMPLETED)
       │                                  │
       │                                  │ require_deliverables: ✓
       │                                  │ require_result: ✓
       │                                  │ approver: caller=lead ✓
       │                                  │ → PASS ✅
```

---

## 情景 6: Learning 自動捕捉 + 跨 Run 持久化

```
  ┌──────────────────── Run #1 ────────────────────────┐
  │                                                     │
  │  task FAILED                  task COMPLETED         │
  │  message="API timeout"        + explicit learning    │
  │       │                            │                 │
  │       ▼                            ▼                 │
  │  buildLearning()             buildLearning()         │
  │       │                            │                 │
  │       ▼                            ▼                 │
  │  Auto-generate:              Use explicit:           │
  │  category: failure           category: fix           │
  │  confidence: 0.5             confidence: 0.9         │
  │  content: "Task failed:      content: "使用          │
  │   API timeout"                connection pool"       │
  │       │                            │                 │
  │       ▼                            ▼                 │
  │  KV: learnings:failure:t1    KV: learnings:fix:t2   │
  │                                                     │
  └──────────┬──────────────────────┬───────────────────┘
             │                      │
             │ 跨 Run 持久化         │
             │ retention: across-runs│
             ▼                      ▼
  ┌──────────────────── Run #2 — Agent 啟動 ───────────┐
  │                                                     │
  │  agent_start hook                                   │
  │       │                                             │
  │       ▼                                             │
  │  collectLearnings(kv, 10)                           │
  │       │                                             │
  │       ▼                                             │
  │  Sort by confidence ↓                               │
  │       │                                             │
  │       ▼                                             │
  │  注入 prompt:                                       │
  │  ## Previous Learnings                              │
  │  1. [fix] connection pool (0.9)                     │
  │  2. [failure] API timeout (0.5)                     │
  │                                                     │
  └─────────────────────────────────────────────────────┘

  ┌──────────── Agent 看到什麼? ────────────────────────┐
  │                                                     │
  │  team_memory(list)                                  │
  │       │                                             │
  │       ▼                                             │
  │  filter: !key.startsWith("learnings:")              │
  │       │                                             │
  │       ▼                                             │
  │  只顯示 user data                                   │
  │  learnings:* 被隱藏                                  │
  │                                                     │
  └─────────────────────────────────────────────────────┘
```

### buildLearning() 決策樹

```
  buildLearning(params, task)
       │
       ▼
  params.learning 有值?
       │
  ┌────┴────┐
  Yes       No
  │         │
  ▼         ▼
  使用明確   status === FAILED && message 有值?
  提供的     │
  值         ├── Yes → Auto-generate:
  │         │         confidence: 0.5
  │         │         category: "failure"
  │         │         content: task desc + message
  │         │
  │         └── No → status === COMPLETED && result 有值?
  │                   │
  │                   ├── Yes → result.length > 50?
  │                   │          │
  │                   │          ├── Yes → Auto-generate:
  │                   │          │         confidence: 0.5
  │                   │          │         category: "insight"
  │                   │          │         content: task desc + result
  │                   │          │
  │                   │          └── No → return null (不捕捉)
  │                   │
  │                   └── No → return null (不捕捉)
  │
  ▼
  confidence: params 或 default 0.7
  category: params 或 auto-detect
```

---

## 情景 7: Context Compaction — 長對話記憶保留

```
  at--dev--alice       compaction hook      TeamStores        OpenClaw Runtime
       │                    │                   │                    │
       │  Token count       │                   │                    │
       │  接近上限...       │                   │                    │
       │                    │                   │                    │
       │ before_compaction  │                   │                    │
       │──────────────────>│                   │                    │
       │                    │                   │                    │
       │                    │ isTeamAgent? ✓    │                    │
       │                    │ sessionKey? ✓     │                    │
       │                    │                   │                    │
       │                    │ runs.getRun("dev")│                    │
       │                    │──────────────────>│                    │
       │                    │<── run + tasks    │                    │
       │                    │                   │                    │
       │                    │ kv.list()         │                    │
       │                    │  .filter(非 learnings)                 │
       │                    │  .slice(0, 10)    │                    │
       │                    │──────────────────>│                    │
       │                    │<── memory entries │                    │
       │                    │                   │                    │
       │                    │ ┌───────────────────────────────┐     │
       │                    │ │ 組合 summary:                  │     │
       │                    │ │ [Post-Compaction State Restore]│     │
       │                    │ │ You are alice in team dev      │     │
       │                    │ │ Run: tr-xxx (WORKING)          │     │
       │                    │ │ Goal: 建電商系統               │     │
       │                    │ │ Tasks: [COMPLETED] task-1...   │     │
       │                    │ │ Memory: api-spec: {...}        │     │
       │                    │ └───────────────────────────────┘     │
       │                    │                   │                    │
       │                    │ enqueueSystemEvent(summary, sessionKey)│
       │                    │──────────────────────────────────────>│
       │                    │                   │                    │
       │                    │                   │    執行 compaction │
       │                    │                   │    壓縮舊對話      │
       │                    │                   │                    │
       │  System event 注入新 context                               │
       │  alice 恢復對團隊狀態的感知                                 │
       │<──────────────────────────────────────────────────────────│
```

---

## 情景 8: Activity Log 查詢 — 事件追蹤

```
  ┌─────────────────── team_inbox 查詢方式 ───────────────────────┐
  │                                                                │
  │  source="activity", limit=5          → 最近 5 筆活動          │
  │                                                                │
  │  source="activity",                  → 只看完成的任務          │
  │  filter_type="task_completed"                                  │
  │                                                                │
  │  source="activity",                  → 只看 bob 的活動        │
  │  filter_agent="bob"                                            │
  │                                                                │
  │  source="activity",                  → 10:00 之後的活動       │
  │  since="2026-03-10T10:00:00Z"                                  │
  │                                                                │
  │  source="activity",                  → alice 的最近 3 筆      │
  │  filter_type="memory_updated",         記憶更新               │
  │  filter_agent="alice", limit=3                                 │
  │                                                                │
  │  action="list_topics"                → { topics: [...] }       │
  │                                                                │
  │  source="activity", topic="xxx"      → ❌ ERROR: Cannot use   │
  │                                        topic with activity     │
  └────────────────────────────────────────────────────────────────┘
```

### ActivityLog.query() 內部機轉

```
  query({ type, agent, since, limit })
       │
       ▼
  Single-pass filter over entries (O(n), n ≤ 10,000)
       │
       ├── (!type  || e.type === type)      AND
       ├── (!agent || e.agent === agent)    AND
       └── (!since || e.timestamp > since)
              │
              ▼
       filtered results
              │
              ▼
       limit > 0?
       │       │
      Yes      No
       │       │
       ▼       ▼
  .slice(-limit)  return all
  (最後 N 筆)
       │
       ▼
  map → { id, type, agent, description,
          target_id, metadata, timestamp(ISO) }
```

---

## 情景 9: Edge Case — Ring Buffer 溢出 + TTL 過期

### EventQueue Ring Buffer 溢出

```
  publish() × 501 次
       │
       ▼
  events.length > 500?
       │
      Yes (501 > 500)
       │
       ▼
  excess = 501 - 500 = 1
  events.splice(0, 1)        ← 移除最舊的 1 筆
       │
       ▼
  events.length = 500         ← 始終維持 ≤ 500

  ⚠️ Counter 不重置:
     ev-500, ev-501, ev-502...
     即使 ev-0~N 已被淘汰

  ⚠️ subscribe(since='ev-5'):
     ev-5 已被淘汰 → findIndex 找不到
     → 回傳所有匹配的 events (stale cursor 處理)
```

### KV Store TTL 過期

```
  Agent                    KvStore
   │                         │
   │ set("session:abc",      │
   │  data, "alice", 300)    │
   │────────────────────────>│  ttl = 300 秒
   │                         │  expires_at = now + 300s
   │                         │
   │        ⏰ 300 秒後...    │
   │                         │
   │ get("session:abc")      │
   │────────────────────────>│
   │                         │  sweepExpired()
   │                         │  expires_at < Date.now()
   │                         │  → entries.delete("session:abc")
   │                         │
   │  { found: false }       │
   │<────────────────────────│
   │                         │
   │  Lazy expiry:           │
   │  不用 timer/interval    │
   │  只在 access 時清理      │
   │  sweepExpired() 在      │
   │  get/list 觸發           │
```

### KV Store 容量溢出

```
  kv.set("key-257", ...)
  when size = 256
       │
       ▼
  evictOldest()
       │
       ▼
  找 created_at 最小的 entry
       │
       ▼
  entries.delete(oldestKey)    → size = 255
       │
       ▼
  set new entry                → size = 256
```

---

## 情景 10: Edge Case — Cascade Cancel + 傳遞性

```
  ┌────── Task 依賴圖 ──────┐
  │                          │
  │  A ──► B ──► C ──► D    │
  │             │            │
  │             └──► E ──► F │
  │                          │
  └──────────────────────────┘

  A → CANCELED
       │
       ▼
  cascadeCancelDependents(tasks, 'A')
       │
       ├── Round 1: B depends on A (canceled)       → B: CANCELED
       │
       ├── Round 2: C depends on B (canceled)       → C: CANCELED
       │            E depends on B (canceled)       → E: CANCELED
       │
       ├── Round 3: D depends on C (canceled)       → D: CANCELED
       │            F depends on E (canceled)       → F: CANCELED
       │
       └── Round 4: 沒有新的 → 結束

  結果: A, B, C, D, E, F 全部 CANCELED

  ⚠️ 只 cancel BLOCKED 或 PENDING
     WORKING 或 COMPLETED 不受影響
```

---

## 情景 11: Edge Case — Load Balancing

```
  team_task(create, required_skills=["coding"])
       │
       ▼
  routeTask() Layer 2
       │
       ▼
  findSkillCandidates():
    alice: coding ✓ (exact)
    bob:   coding ✓ (exact)
    carol: coding ✓ (exact)
       │
       ▼
  loadBalance(["alice","bob","carol"], tasks)
       │
       ▼
  Active task counts:
    alice: 2 (1 PENDING + 1 WORKING)
    bob:   0
    carol: 1 (1 WORKING)
       │
       ▼
  Pick lowest: bob (0) ★
       │
       ▼
  assigned_to: bob
  routing_reason: skill_exact_match

  如果 bob 也有 2 → carol (1) 最少
  如果都一樣 → 選第一個 (alice)
  只計算 PENDING + WORKING
```

---

## 情景 12: Broadcast + 外部監控

```
  ┌─── Agent 操作 ───┐
  │ team_task()       │
  │ team_run()        │
  │ team_memory()     │──────► activity.log()
  │ team_send()       │             │
  └───────────────────┘             ▼
                              ActivityEntry
                              { id: 'act-42', type, agent, ... }
                                    │
                                    ▼
                           broadcastCallback(entry)
                                    │
                                    ▼
                            Broadcaster.emit()
                                    │
                                    ▼
                            BroadcastEvent:
                            { id: 'evt-42',
                              type: 'task_completed',
                              team: 'dev',
                              agent: 'alice',
                              data: {...},
                              ts: 1710086400000 }
                                    │
                                    ▼
                            JSON.stringify + '\n'
                            → append broadcast.jsonl
                                    │
                            ┌───────┴───────┐
                            │               │
                            ▼               ▼
                     fileSize > 10MB?    $ tail -f broadcast.jsonl | jq
                      │        │
                     Yes       No
                      │        │
                      ▼        ▼
                  rename →    done
                  broadcast-{ts}.jsonl
                  建立新 broadcast.jsonl
```

---

## 情景 13: 完整初始化流程

```
  Plugin activate(api)
       │
       ▼
  validateConfig()
       │
       ▼
  parseConfig()
  套用 defaults: max_rounds=10, timeout=600, retention='across-runs'
       │
       ▼
  resolveStateDir()
  → ~/.openclaw/plugins/agent-teams/
       │
       ▼
  Create Broadcaster
       │
       ▼
  FOR EACH team ─────────────────────────────────────────┐
       │                                                  │
       ├── Create 6 stores: KV, Events, Docs,            │
       │   Runs, Messages, Activity                       │
       │                                                  │
       ├── Wire: activity.onEntry(broadcaster.emit)       │
       │                                                  │
       ├── await Promise.all([                            │
       │     kv.load(), events.load(), docs.load(),       │
       │     runs.load(), messages.load(), activity.load()│
       │   ])                                             │
       │                                                  │
       └── registry.teams.set(teamName, stores)           │
  ◄───────────────────────────────────────────────────────┘
       │
       ▼
  provisionAgents()
       │
       ├── FOR EACH member:
       │     id: at--team--member
       │     model, workspace, tools
       │
       └── injectAgents(runtimeConfig)
           → config.agents.list
           → tools.agentToAgent.allow
       │
       ▼
  Register hooks (priority 10):
    agent_start, compaction,
    subagent_spawned/ended,
    delivery_target
       │
       ▼
  Register tools (factory):
    team_run, team_task, team_memory,
    team_send, team_inbox
       │
       ▼
  Register commands:
    /team status, /team stop, /team list
       │
       ▼
  Plugin ready ✓
```

---

## 情景 14: Agent Start Hook — 完整 Prompt 注入

```
  agent at--product--frontend 啟動
       │
       ▼
  createAgentStartHook()
       │
       ▼
  1. ## Your Role
     You are frontend in team product
     Frontend Developer
       │
       ▼
  2. ## Current Goal
     建電商結帳功能
       │
       ▼
  3. ## Team Members
     Coordination: orchestrator
     pm, frontend(you), backend, qa
       │
       ▼
  4. ## Available Team Tools
     team_task, team_memory,
     team_send, team_inbox, team_run
       │
       ▼
  5. events.getTopics() 有 topics?
     ├── Yes → ## Event Topics
     │         Active topics: build, deploy
     │         + activity hint
     │
     └── No  → activity hint only
               (無 ## Event Topics section)
       │
       ▼
  6. ## Decision Flow (Team Member)
     1. Check assigned tasks
     2. Claim & work
     3. team_send if need input
     4. Store in team_memory
     5. COMPLETED + result
     6. Don't send to Telegram
       │
       ▼
  7. ## Run Status
     Run ID, Status, Task counts
     Task list (前 15 個)
       │
       ▼
  8. collectLearnings(kv, 10) 有 learnings?
     ├── Yes → ## Previous Learnings
     │         Sorted by confidence
     │         [fix] connection pool (0.9)
     │         [failure] API timeout (0.5)
     │
     └── No  → (skip)
       │
       ▼
  return { prependContext, modelOverride? }
```

---

## 情景 15: Atomic Writes + 並行儲存

```
  team_memory(set)
       │
       │ kv.set("data", ...)
       │ logMemoryUpdate(...)
       │
       ▼
  Promise.all — 並行儲存
       │
       ├─────────────────────┐
       │                     │
       ▼                     ▼
  kv.save()             activity.save()
       │                     │
       ▼                     ▼
  writeFile(             entries.length > 10,000?
   kv.json.tmp.{ts},     │
   data)                  ├── Yes:
       │                  │   writeFile(archive-{ts}.json,
       ▼                  │    oldest 5000)
  rename(                 │   entries.splice(0, 5000)
   kv.json.tmp.{ts},     │
   kv.json)               └── Then:
       │                      writeFile(
  ★ Atomic!                    activity.json.tmp.{ts},
  Readers 永遠                  entries)
  看到完整 JSON                      │
                                     ▼
                                rename(
                                 activity.json.tmp.{ts},
                                 activity.json)
                                     │
                                ★ Atomic!

  如果 rename 前斷電:
  tmp 檔殘留，原檔未被改動
  下次 load 正常
```

---

## 資料流總覽圖

```
  ┌────────────────────────────────────────────────────────────────────┐
  │                                                                    │
  │  User / External                                                   │
  │       │                                                            │
  │       ├──► Team Commands: /team status, /team stop, /team list     │
  │       │                                                            │
  │       └──► Hooks: agent_start, compaction, delivery_target,        │
  │                   subagent_spawned/ended                            │
  │                          │                                         │
  │                          ▼                                         │
  │              ┌─── Tools ────────────────────┐                      │
  │              │ team_run    │ team_task       │                      │
  │              │ team_memory │ team_send       │                      │
  │              │ team_inbox  │                 │                      │
  │              └─────────────┬─────────────────┘                      │
  │                            │                                       │
  │                            ▼                                       │
  │              ┌─── TeamStores (per team) ────┐                      │
  │              │                              │                      │
  │              │ RunManager   — tasks, runs   │                      │
  │              │ KvStore      — KV + learnings│                      │
  │              │ EventQueue   — pub/sub ring  │                      │
  │              │ DocPool      — file-backed   │                      │
  │              │ MessageStore — direct msgs   │                      │
  │              │ ActivityLog  — audit trail   │─── onEntry ──►       │
  │              │                              │          Broadcaster │
  │              └──────────────┬───────────────┘              │       │
  │                             │                              ▼       │
  │                    atomic writes              broadcast.jsonl      │
  │                   (tmp + rename)              (tail -f | jq)       │
  │                             │                                      │
  └─────────────────────────────┼──────────────────────────────────────┘
                                ▼
                 ~/.openclaw/plugins/agent-teams/team/
```

---

## 所有 ActivityType 觸發點一覽

| ActivityType | 觸發位置 | 觸發時機 |
|---|---|---|
| `task_created` | team_task(create) | 新 task 建立後 |
| `task_updated` | team_task(update) | 狀態變更 (非 COMPLETED/FAILED) |
| `task_completed` | team_task(update) | status → COMPLETED |
| `task_failed` | team_task(update) | status → FAILED |
| `run_started` | team_run(start) | 新 run 啟動 |
| `run_completed` | team_run(complete) | run 完成 |
| `run_canceled` | team_run(cancel), /team stop | run 被取消 |
| `message_sent` | team_send | 訊息或事件發送 |
| `memory_updated` | team_memory(set/delete) | KV 或 DocPool 變更 |
| `deliverable_added` | team_task(update) + deliverables | 附件新增 |
| `dependency_resolved` | team_task(update, COMPLETED) | 解鎖被依賴的 tasks |
| `dependency_blocked` | (未使用) | — |
| `dependency_cascaded` | (未使用) | — |
| `learning_captured` | team_task(update, COMPLETED/FAILED) | 自動/手動捕捉學習 |
| `workflow_stage_advanced` | team_run(start) + template | workflow 任務鏈生成 |
| `workflow_fail_loopback` | team_task(update, FAILED) + template | 失敗回溯處理 |
