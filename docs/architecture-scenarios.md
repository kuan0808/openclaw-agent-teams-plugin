# Agent Teams Plugin — 架構全解析 & 使用情景

---

## 1. 系統總覽

```
┌──────────────────────────── OpenClaw Runtime ──────────────────────────────┐
│                                                                            │
│  ┌────────────────────── Agent Teams Plugin ───────────────────────────┐   │
│  │                                                                     │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐       │   │
│  │  │  Hooks   │  │  Tools   │  │ Commands │  │   Registry   │       │   │
│  │  │ (4 hooks)│  │ (5 tools)│  │ (1 cmd)  │  │ (singleton)  │       │   │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘       │   │
│  │       └──────────────┴─────────────┴───────────────┘               │   │
│  │                              │                                      │   │
│  │       ┌──────────────── TeamStores (per team) ──────────────┐      │   │
│  │       │                                                      │      │   │
│  │       │  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  │      │   │
│  │       │  │   KvStore   │  │  EventQueue  │  │  DocPool  │  │      │   │
│  │       │  │ 256 max     │  │ 500 ring buf │  │  50MB max │  │      │   │
│  │       │  └─────────────┘  └──────────────┘  └───────────┘  │      │   │
│  │       │  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  │      │   │
│  │       │  │ RunManager  │  │ MessageStore │  │ActivityLog│  │      │   │
│  │       │  │ N active    │  │ per-user q's │  │10K→archive│  │      │   │
│  │       │  └─────────────┘  └──────────────┘  └─────┬─────┘  │      │   │
│  │       └───────────────────────┬───────────────────┘│────────┘      │   │
│  │                               │            onEntry │               │   │
│  │                               │                    ▼               │   │
│  │                               │             Broadcaster            │   │
│  │                               │             .jsonl (10MB rotate)   │   │
│  │                               │                                    │   │
│  │       ┌──────────────── CLI Agent Infrastructure ──────────┐      │   │
│  │       │                                                     │      │   │
│  │       │  ┌─────────────┐  ┌───────────┐  ┌──────────────┐ │      │   │
│  │       │  │ CliSpawner  │  │ IpcServer │  │  MCP Bridge  │ │      │   │
│  │       │  │ PTY管理      │  │ JSON-RPC  │  │ Standalone   │ │      │   │
│  │       │  │ 崩潰處理     │  │ Unix sock │  │ stdio server │ │      │   │
│  │       │  └─────────────┘  └───────────┘  └──────────────┘ │      │   │
│  │       └─────────────────────────────────────────────────────┘      │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

### Plugin 啟動 8 步流程

```
activate(api)
     │
     ▼
1. validateConfig(raw)          ← 驗證 config 結構
     │
     ▼
2. parseConfig(raw)             ← 套用預設值，生成 AgentTeamsConfig
     │
     ▼
3. reconcileHostRuntimeConfig() ← 確保 host runtime 設定相容
     │
     ▼
4. 初始化 Registry 單例         ← 模組級 singleton Maps (teams, memberSessions, sessionIndex)
   setRegistry(registry)          重複啟動共享同一 Maps
     │
     ▼
5. registerPluginSurface(api)   ← 同步註冊 4 hooks + 5 tools + 1 command
     │                            (必須在第一個 await 前完成)
     ▼
6. initTeamStores()             ← 建立 Broadcaster，per-team 6 store 建立 + 載入
   (首次啟動才執行)                activity.onEntry → broadcaster.emit
     │
     ▼
7. recoverRunSessions()         ← 從持久化的 active runs 重建 session 映射
     │
     ▼
8. provisionAgents()            ← 為每個 native member 佈署 agent
   injectAgents()                  CLI members 跳過佈署但加入 allow list
   createLazyCliInit()             CLI infra 延遲初始化 (首次任務指派時觸發)
```

### 模組映射

```
index.ts                          ← 入口，啟動流程編排 (~220 行)
  ├── src/config.ts               ← 驗證 & 解析設定
  ├── src/registry.ts             ← 全域單例 Registry，session 管理
  ├── src/types.ts                ← 所有型別定義
  │
  ├── src/init/
  │   ├── plugin-registrar.ts     ← 同步註冊 hooks/tools/commands
  │   ├── store-initializer.ts    ← per-team store + broadcaster 初始化
  │   ├── session-recovery.ts     ← 從持久化 runs 重建 session
  │   └── cli-initializer.ts      ← IPC server + CLI spawner 延遲初始化
  │
  ├── src/state/
  │   ├── kv-store.ts             ← KV store (TTL, 256 max)
  │   ├── event-queue.ts          ← 事件佇列 (ring buffer, 500 max)
  │   ├── doc-pool.ts             ← 文件池 (file-backed, 50MB)
  │   ├── run-manager.ts          ← Run/Task 狀態機 (並行 runs)
  │   ├── message-store.ts        ← 直接訊息 (per-member queue)
  │   ├── activity-log.ts         ← 審計日誌 (10K → archive)
  │   └── persistence.ts          ← atomic write (tmp + rename)
  │
  ├── src/tools/
  │   ├── team-run.ts             ← team_run 工具
  │   ├── team-task.ts            ← team_task 工具 (最複雜)
  │   ├── team-memory.ts          ← team_memory 工具
  │   ├── team-send.ts            ← team_send 工具
  │   ├── team-inbox.ts           ← team_inbox 工具
  │   ├── tool-helpers.ts         ← 共用輔助 (re-exports)
  │   └── cli-spawn-helper.ts     ← CLI agent spawn 輔助
  │
  ├── src/routing/
  │   ├── task-dispatcher.ts      ← 3 層路由 (direct → skill → fallback)
  │   └── dependency-resolver.ts  ← 依賴解析 + cascade cancel + cycle detection
  │
  ├── src/workflow/
  │   └── template-engine.ts      ← workflow template → task chain
  │
  ├── src/patterns/
  │   ├── orchestrator.ts         ← orchestrator 模式輔助
  │   └── peer.ts                 ← peer 模式 + auto-complete
  │
  ├── src/hooks/
  │   ├── agent-start.ts          ← before_agent_start hook
  │   ├── compaction.ts           ← before_compaction hook
  │   ├── subagent-lifecycle.ts   ← subagent_ended + delivery_target hooks
  │   └── delivery.ts             ← delivery 輔助
  │
  ├── src/cli/
  │   ├── cli-spawner.ts          ← PTY 進程管理 + 崩潰處理
  │   ├── ipc-server.ts           ← JSON-RPC server (Unix socket / TCP)
  │   ├── mcp-bridge.ts           ← MCP server (獨立編譯, stdio)
  │   ├── prompt-builder.ts       ← 系統 prompt 建構 (hook + CLI 共用)
  │   └── cli-types.ts            ← CLI 型別定義
  │
  ├── src/commands/
  │   └── team-command.ts         ← /team 子命令
  │
  ├── src/setup/
  │   ├── agent-provisioner.ts    ← agent 佈署 + 注入
  │   └── runtime-compat.ts       ← host runtime 相容性
  │
  ├── src/helpers/
  │   ├── learning-helpers.ts     ← learning 收集/合併/清理
  │   ├── notification-helpers.ts ← notifyRequester, wakeActiveNativeAssignee
  │   ├── result-helpers.ts       ← textResult, errorResult, safeSaveAll
  │   └── task-helpers.ts         ← autoTransitionPendingToWorking, countByStatus
  │
  └── src/broadcast.ts            ← .jsonl event broadcasting
```

---

## 2. 完整設定參考

### AgentTeamsConfig

```yaml
teams:                              # Record<string, TeamConfig>
  <team-name>:                      # 團隊名稱 (key)
    # ... TeamConfig fields
```

### TeamConfig

| 欄位 | 型別 | 必填 | 預設值 | 說明 |
|------|------|------|--------|------|
| `description` | `string` | ✅ | — | 團隊描述 |
| `coordination` | `"orchestrator" \| "peer"` | ✅ | — | 協調模式 |
| `orchestrator` | `string` | orchestrator 模式必填 | — | 指定 orchestrator member 名稱 |
| `members` | `Record<string, MemberConfig>` | ✅ | — | 成員設定 (至少 1 個) |
| `shared_memory` | `SharedMemoryConfig` | ❌ | `{ enabled: true }` | 共享記憶體設定 |
| `routing` | `RoutingConfig` | ❌ | `{}` | 路由設定 |
| `workflow` | `WorkflowConfig` | ❌ | 見下方 | 工作流設定 |
| `knowledge` | `KnowledgeConfig` | ❌ | 見下方 | 知識系統設定 |

### MemberConfig

| 欄位 | 型別 | 必填 | 預設值 | 說明 |
|------|------|------|--------|------|
| `role` | `string` | `role` 或 `role_file` 擇一 | — | 角色描述 (inline) |
| `role_file` | `string` | `role` 或 `role_file` 擇一 | — | 角色描述檔案路徑 (相對於 `~/.openclaw/`) |
| `model` | `{ primary: string }` | ❌ | — | 模型覆蓋 (如 `claude-sonnet-4-20250514`) |
| `skills` | `string[]` | ❌ | `[]` | 成員技能列表 (用於 skill-based routing) |
| `can_delegate` | `boolean` | ❌ | — | 是否可委派工作 |
| `tools` | `{ deny?: string[], allow?: string[] }` | ❌ | — | 工具存取控制 |
| `cli` | `"claude" \| "codex" \| "gemini"` | ❌ | — | 作為外部 CLI agent 啟動 |
| `cli_options` | `CliOptions` | ❌ | — | CLI 專屬設定 |

### CliOptions

| 欄位 | 型別 | 預設值 | 說明 |
|------|------|--------|------|
| `cwd` | `string` | `process.cwd()` | CLI agent 工作目錄 |
| `thinking` | `boolean` | — | 啟用 extended thinking / ultrathink |
| `verbose` | `boolean` | — | 啟用詳細輸出 |
| `extra_args` | `string[]` | — | 額外 CLI 參數 (escape hatch) |

### WorkflowConfig

| 欄位 | 型別 | 預設值 | 說明 |
|------|------|--------|------|
| `max_rounds` | `number` | `10` | 最大回合數 (fail-loopback / revision 遞增) |
| `timeout` | `number` | `900` (15 分鐘) | Run 超時秒數 |
| `gates` | `Record<string, GateConfig>` | — | 狀態轉換門檻 (key = status) |
| `template` | `WorkflowTemplate` | — | 工作流模板 (階段鏈) |

### GateConfig

| 欄位 | 型別 | 預設值 | 說明 |
|------|------|--------|------|
| `require_deliverables` | `boolean` | — | 必須有 deliverables 才能通過 |
| `require_result` | `boolean` | — | 必須有 result 才能通過 |
| `approver` | `"orchestrator" \| string` | — | 指定核准者 |
| `reviewer` | `"orchestrator" \| string` | — | 指定審查者 (用於 REVISION_REQUESTED) |

### WorkflowTemplate

| 欄位 | 型別 | 說明 |
|------|------|------|
| `stages` | `WorkflowStage[]` | 階段列表，依序產生 task chain |
| `fail_handlers` | `Record<string, string>` | `stage name → revert-to stage name` (fail-loopback 映射) |

### WorkflowStage

| 欄位 | 型別 | 說明 |
|------|------|------|
| `name` | `string` | 階段名稱 |
| `role` | `string` | 角色需求 (for routing) |
| `skills` | `string[]` | 技能需求 (for routing) |

### SharedMemoryConfig

| 欄位 | 型別 | 預設值 | 說明 |
|------|------|--------|------|
| `enabled` | `boolean` | `true` | 是否啟用共享記憶體 |
| `stores.kv` | `KvStoreConfig` | `{}` | KV store 設定 |
| `stores.events` | `EventQueueConfig` | `{}` | 事件佇列設定 |
| `stores.docs` | `DocPoolConfig` | `{}` | 文件池設定 |

**KvStoreConfig**: `max_entries` (預設 256), `ttl` (預設 0 = 不過期)

**EventQueueConfig**: `max_backlog` (預設 500)

**DocPoolConfig**: `max_size_mb` (預設 50), `allowed_types` (預設: text/plain, text/markdown, text/csv, application/json)

### KnowledgeConfig

| 欄位 | 型別 | 預設值 | 說明 |
|------|------|--------|------|
| `consolidation` | `boolean` | `true` | 是否啟用 learning 合併 |
| `consolidation_timeout` | `number` | `30` | 合併觸發延遲 (秒) |
| `retention` | `"current-run" \| "across-runs"` | `"across-runs"` | 學習保留策略 |
| `notify_leader` | `boolean` | `true` | 新 learning 是否通知 orchestrator |

### 設定欄位 → 程式碼路徑映射

| 設定欄位 | 消費程式碼 | 說明 |
|----------|-----------|------|
| `workflow.timeout` | `enforcement.ts:checkRunLimits()` | 比對 elapsed vs timeout |
| `workflow.max_rounds` | `enforcement.ts:checkRunLimits()` | 比對 round_count vs max_rounds |
| `workflow.gates` | `team-task.ts:enforceGates()` | 狀態轉換時檢查 |
| `workflow.gates.REVISION_REQUESTED.reviewer` | `team-task.ts` REVISION_REQUESTED guard | 決定誰可以要求修訂 |
| `workflow.template` | `template-engine.ts:generateTaskChain()` | Run 啟動時產生 task chain |
| `workflow.template.fail_handlers` | `template-engine.ts:handleFailLoopback()` | 失敗時回溯到指定階段 |
| `knowledge.retention` | `team-run.ts` (start action) | "current-run" 時新 run 清除舊 learnings |
| `knowledge.consolidation` | `compaction.ts` hook | 是否合併 learnings |
| `knowledge.notify_leader` | `team-task.ts` learning capture | 新 learning 通知 orchestrator |
| `members[].skills` | `task-dispatcher.ts:routeTask()` | Skill-based routing |
| `members[].cli` | `cli-spawn-helper.ts` | 決定是否 PTY 啟動 |
| `members[].cli_options.cwd` | `cli-spawner.ts` | CLI agent 工作目錄 |
| `members[].cli_options.thinking` | `cli-spawner.ts` | ultrathink 模式 |
| `members[].tools.allow/deny` | `config.ts:validateRequiredTools()` | 驗證必要工具 |
| `coordination` | `team-task.ts`, `peer.ts`, `enforcement.ts` | 決定模式行為 |
| `orchestrator` | `task-dispatcher.ts`, `team-task.ts`, 多處 | orchestrator member key |

---

## 3. Task 狀態機

```
                    ┌────────────────────────────────────────────────┐
                    │              REVISION_REQUESTED                │
                    │         (只有 orchestrator/reviewer 可觸發)     │
                    └────────┬──────────────────────▲────────────────┘
                             │                      │
                         WORKING               REVISION_REQUESTED
                             │                      │
                             ▼                      │
  BLOCKED ──► PENDING ──► WORKING ──► COMPLETED ────┘
                │                 │
                │           INPUT_REQUIRED
                │                 │
                │              WORKING
                │              FAILED
                │
                ▼
            CANCELED ◄─── (任何 active 狀態)

  FAILED ──► PENDING (retry/fail-loopback)
```

### 所有 8 個狀態

| 狀態 | 類型 | 說明 |
|------|------|------|
| `BLOCKED` | Active | 等待依賴完成，自動轉 PENDING |
| `PENDING` | Active | 可被認領/分配 |
| `WORKING` | Active | 正在執行中 |
| `INPUT_REQUIRED` | Active | 需要外部輸入 |
| `COMPLETED` | Terminal | 任務完成 |
| `FAILED` | Terminal | 任務失敗 |
| `CANCELED` | Terminal | 任務取消 |
| `REVISION_REQUESTED` | Active | 審查要求修訂 (僅從 COMPLETED 轉入) |

### 有效轉換表

| From → To | BLOCKED | PENDING | WORKING | INPUT_REQ | COMPLETED | FAILED | CANCELED | REVISION_REQ |
|-----------|---------|---------|---------|-----------|-----------|--------|----------|--------------|
| **BLOCKED** | — | ✅ | — | — | — | — | ✅ | — |
| **PENDING** | ✅ | — | ✅ | — | — | — | ✅ | — |
| **WORKING** | — | — | — | ✅ | ✅ | ✅ | ✅ | — |
| **INPUT_REQUIRED** | — | — | ✅ | — | — | ✅ | ✅ | — |
| **COMPLETED** | — | — | — | — | — | — | — | ✅ |
| **FAILED** | — | ✅ | — | — | — | — | — | — |
| **CANCELED** | — | — | — | — | — | — | — | — |
| **REVISION_REQUESTED** | — | — | ✅ | — | — | — | ✅ | — |

### Terminal vs Active 狀態

- **Terminal**: `COMPLETED`, `FAILED`, `CANCELED` — 不可再轉換 (除了 COMPLETED → REVISION_REQUESTED 和 FAILED → PENDING)
- **Active**: `BLOCKED`, `PENDING`, `WORKING`, `INPUT_REQUIRED`, `REVISION_REQUESTED` — Run cancel 時全部轉 CANCELED

---

## 4. Run 生命週期

### RunStatus 狀態

| 狀態 | 說明 |
|------|------|
| `WORKING` | 執行中 |
| `COMPLETED` | 完成 (所有 tasks terminal) |
| `FAILED` | 失敗 (enforcement violation 觸發) |
| `CANCELED` | 取消 (手動或 timeout/max_rounds) |

### 生命週期流程

```
  team_run(start)
       │
       ▼
  RunManager.startRun()
  生成 run_id: tr-YYYYMMDD-HHmmss-xxxx
  status: WORKING
       │
       ├── 有 workflow.template?
       │     │
       │    Yes → generateTaskChain()
       │     │    產生 stage chain (第一個 PENDING，其餘 BLOCKED)
       │     │    spawnCliIfNeeded() for 每個 task
       │     │
       │    No → 等待 orchestrator/peer 建立 tasks
       │
       ▼
  Tasks 執行中...
       │
       ├── Peer 模式: shouldAutoComplete(run) 在每次 task update 後檢查
       │     所有 tasks terminal → auto-complete run
       │
       ├── Orchestrator 模式:
       │     orchestrator 手動 team_run(complete)
       │     或: shouldOrchestratorAutoComplete() 60 秒 grace period 後自動完成
       │
       ├── Enforcement violation:
       │     timeout → cancelRun + 通知 requester
       │     max_rounds → cancelRun + 通知 requester
       │
       └── 手動: team_run(cancel) 或 /team stop
              │
              ▼
         cancelRun(): 所有 active tasks → CANCELED
         (每個 task 個別記錄 task_canceled activity event)
              │
              ▼
  archiveRun(runId)
       │
       ├── 寫入 archive/<runId>.json
       ├── 刪除 active/<runId>.json
       ├── cleanupRunSessions() ← 清理 memberSessions + sessionIndex
       └── 觸發 learning consolidation (如果 knowledge.consolidation = true)
```

### Orchestrator Lazy Auto-Complete

```
  所有 tasks 到達 terminal 狀態
       │
       ▼
  記錄 all_terminal_at = Date.now()
       │
       ▼
  每次 tool call 觸發 shouldOrchestratorAutoComplete()
       │
       ▼
  elapsed = now - all_terminal_at
  elapsed >= 60 秒?
       │
      Yes → handleOrchestratorAutoComplete()
       │     buildConsolidatedResult(run)
       │     completeRun(team, consolidated)
       │     activity: "run_completed" (auto_complete: true)
       │     notifyRequester()
       │
      No → 繼續等待 (orchestrator 可能還在審查或建立新 tasks)
```

---

## 5. 三層路由系統

```
  routeTask(teamConfig, description, assignTo?, requiredSkills?, callerMember?, existingTasks?)
       │
       ▼
  ═══ Layer 1: Direct Assignment ═══
  assignTo 有值?
       │
      Yes → { assigned_to: assignTo, routing_reason: "direct_assign" }
       │
      No
       │
       ▼
  ═══ Layer 2: Skill-Based Matching ═══
  requiredSkills 有值?
       │
      Yes → findSkillCandidates(members, requiredSkills)
       │     │
       │     ├── exact matches (所有 required skills 都有) → loadBalance → "skill_exact_match"
       │     │
       │     ├── partial matches (部分技能匹配) → sort by overlap → loadBalance top tier → "skill_best_fit"
       │     │
       │     └── 無匹配 → 進入 Layer 3
       │
      No
       │
       ▼
  ═══ Layer 3: Fallback ═══
       │
       ├── orchestrator 模式 → { assigned_to: orchestrator, routing_reason: "fallback_to_orchestrator" }
       │
       ├── peer 模式 + callerMember 有值 → { assigned_to: callerMember, routing_reason: "peer_auto_assign" }
       │
       ├── peer 模式 + 無 caller → loadBalance(所有 members) → "peer_auto_assign"
       │
       └── 最後手段 → first member → "fallback_first_member"
```

### loadBalance 演算法

```
  candidates + existingTasks
       │
       ▼
  計算每個 candidate 的 active task 數
  (只計 PENDING + WORKING)
       │
       ▼
  選 count 最小的 → 回傳
  (如果 tie → 選 array 中第一個)
```

---

## 6. 依賴系統

### depends_on 解析

Task 建立時支援多種依賴引用格式:
- 完整 task ID: `"task-1234-abc"`
- 1-based 索引: `"1"`, `"2"` (對應現有 tasks 順序)
- 部分 ID 匹配 (suffix): `"abc"` → 匹配 `task-1234-abc`
- 成員名稱匹配: `"TASK_BACKEND"` → 匹配 assigned_to 為 `backend` 的 task

### shouldBlock()

```
  建立新 task 時:
  dependsOn 有任何 dep 不是 COMPLETED?
       │
      Yes → initialStatus = "BLOCKED"
      No  → initialStatus = "PENDING"
```

### resolveDependencies()

```
  某 task → COMPLETED
       │
       ▼
  遍歷所有 BLOCKED tasks:
    task.depends_on 全部在 completedIds 中?
       │
      Yes → task.status = "PENDING"
             回傳 unblocked list
             觸發 sessions_send 重新啟動對應 agent
```

### Cascade Cancel (傳遞性)

```
  task A → FAILED 或 CANCELED
       │
       ▼
  cascadeCancelDependents(tasks, 'A')
       │
       ▼
  迭代傳播:
  Round 1: 找 depends_on 包含 A 的 tasks (BLOCKED/PENDING/WORKING) → CANCELED
  Round 2: 找 depends_on 包含 Round 1 結果的 tasks → CANCELED
  ...
  直到沒有新的 cancellation

  注意: 只影響 BLOCKED, PENDING, WORKING
         COMPLETED 不受影響
         每個 cascaded task 記錄 dependency_cascaded activity
```

### Cycle Detection (DFS)

```
  新 task 建立前:
  detectCycle(existingTasks, newTaskId, dependsOn)
       │
       ▼
  建立 adjacency map (taskId → depends_on)
  加入新 task 的依賴
       │
       ▼
  DFS 從 newTaskId 開始:
  遇到已在 inStack 中的 node → 發現循環
  重構循環路徑回傳
       │
       ▼
  有循環 → errorResult("Circular dependency detected: A → B → C → A")
  無循環 → 繼續建立 task
```

### Leaf-Task 約束 (Revision)

```
  REVISION_REQUESTED 只能對 leaf tasks:
       │
       ▼
  檢查是否有其他 task 的 depends_on 包含此 task
  且該 task 處於 active 狀態
       │
      Yes → errorResult("Cannot request revision: task has active dependents")
      No  → 允許 revision
```

---

## 7. 協調模式

### Orchestrator 模式

```
  ┌─────────── Orchestrator (PM/Lead) ───────────┐
  │                                                │
  │  1. 接收目標 (run goal)                        │
  │  2. 分解為 tasks                               │
  │  3. 分配給 members (via routing)               │
  │  4. 追蹤進度 (team_task query)                 │
  │  5. 審查結果 (REVISION_REQUESTED if needed)    │
  │  6. 完成 run (team_run complete)               │
  │                                                │
  │  ★ 不直接執行工作                              │
  │  ★ sessions_send 啟動 workers                  │
  │  ★ 可用 REVISION_REQUESTED 要求修訂            │
  └────────────────────────────────────────────────┘
       │
       ├──► Worker A: 接收 task → WORKING → COMPLETED
       │
       ├──► Worker B: 接收 task → WORKING → COMPLETED
       │
       └──► Worker C (CLI): 接收 task → PTY spawn → 自動完成
```

### Peer 模式

```
  ┌─────────── Peer A ─────────┐  ┌─────────── Peer B ─────────┐
  │                             │  │                             │
  │  1. 查看現有 tasks          │  │  1. 查看現有 tasks          │
  │  2. 認領 available tasks    │  │  2. 自建 tasks 給自己      │
  │  3. team_send 協調          │  │  3. team_memory 分享結果    │
  │  4. COMPLETED 更新          │  │  4. COMPLETED 更新          │
  │                             │  │                             │
  │  ★ 自組織，無中心指揮       │  │  ★ Auto-complete:          │
  │  ★ 不能同時有多個自己的     │  │     所有 tasks terminal     │
  │    active tasks             │  │     → shouldAutoComplete()  │
  └─────────────────────────────┘  └─────────────────────────────┘
```

### 選擇指南

| 場景 | 推薦模式 |
|------|---------|
| 明確分工、需要品質審查 | Orchestrator |
| 探索性工作、自組織 | Peer |
| 有 workflow template | Orchestrator |
| 需要 REVISION_REQUESTED | Orchestrator |
| 小團隊、平等協作 | Peer |
| 需要 approval gates | Orchestrator |

---

## 8. Orchestrator 審查機制

### REVISION_REQUESTED 狀態流程

```
  Orchestrator                        Worker
       │                                │
       │ task → COMPLETED               │
       │<───────────────────────────────│
       │                                │
       │ 審查結果...                     │
       │ 品質不符合要求                  │
       │                                │
       │ team_task(update,              │
       │   task_id, status:             │
       │   "REVISION_REQUESTED",        │
       │   message: "詳細修改回饋")     │
       │                                │
       │── Guards ────────────────────  │
       │  ✓ caller = orchestrator/reviewer
       │  ✓ current status = COMPLETED
       │  ✓ message (feedback) 有值
       │  ✓ no active dependents (leaf task)
       │                                │
       │── Post-transition ─────────── │
       │  revision_count++              │
       │  revision_feedback = message   │
       │  round_count++ (max_rounds)    │
       │  all_terminal_at = undefined   │
       │                                │
       │  activity: task_revision_requested
       │  notifyRequester()             │
       │                                │
       │── Notify Worker ────────────  │
       │                                │
       │  Native: enqueueSystemEvent    │
       │    + requestHeartbeatNow       │
       │                                │
       │  CLI: spawnCliIfNeeded         │
       │    (respawn with revision      │
       │     prompt)                    │
       │                                │
       │                                │ 收到通知
       │                                │
       │                                │ team_task(update,
       │                                │   task_id, status: "WORKING")
       │                                │
       │                                │ → task_revision_restarted activity
       │                                │ → revision_feedback cleared
       │                                │
       │                                │ 修改工作...
       │                                │
       │                                │ team_task(update,
       │                                │   task_id, status: "COMPLETED",
       │                                │   result: "已修改...")
       │                                │
       │ 再次審查                        │
       │ (可重複 REVISION_REQUESTED)     │
       │                                │
       ▼                                ▼
```

### Guard 規則

1. **權限**: 只有 orchestrator (或 `gates.REVISION_REQUESTED.reviewer` 指定的 member) 可觸發
2. **來源狀態**: 必須從 COMPLETED 轉入 (`validateTransition` 確保)
3. **回饋必填**: `message` 參數必須有值
4. **Leaf-task**: 不可對有 active dependents 的 task 要求修訂

### 計數器影響

- `task.revision_count` — 每次 REVISION_REQUESTED 遞增 (追蹤此 task 被修訂幾次)
- `run.round_count` — 每次 REVISION_REQUESTED 遞增 (用於 max_rounds enforcement)
- `run.all_terminal_at` — 重置為 undefined (防止 premature auto-complete)

---

## 9. Workflow Template 系統

### Stage Chain 生成

```
  team_run(start) + config.workflow.template 存在
       │
       ▼
  generateTaskChain(template, goal, teamConfig, runId, [])
       │
       ▼
  FOR EACH stage in template.stages:
       │
       ├── taskId = "task-{runId}-stage-{stageName}"
       │
       ├── 依賴: 前一個 stage 的 taskId (第一個 stage 無依賴)
       │
       ├── 分配: resolveStageAssignment()
       │     1. stage.role 有值? → findMemberByRole()
       │     2. 否則 → routeTask(skills: stage.skills)
       │
       └── 狀態: 第一個 = PENDING, 其餘 = BLOCKED
```

**範例:**
```yaml
template:
  stages:
    - name: design
      role: designer
    - name: implement
      role: developer
    - name: test
      role: tester
  fail_handlers:
    test: design     # test 失敗 → 回到 design
```

生成:
```
  [PENDING]  task-tr-xxx-stage-design     → designer
  [BLOCKED]  task-tr-xxx-stage-implement  → developer (depends_on: design)
  [BLOCKED]  task-tr-xxx-stage-test       → tester    (depends_on: implement)
```

### Fail-Loopback 機制

```
  task-tr-xxx-stage-test → FAILED
       │
       ▼
  handleFailLoopback(template, "test", failedTask, allTasks, teamConfig, runId)
       │
       ▼
  fail_handlers["test"] = "design"
       │
       ▼
  建立 rework task:
    id: "task-{runId}-rework-design-{timestamp}"
    description: "[design - rework] {original goal} (Failure reason: ...)"
    assigned_to: 原 design stage 的 assignee
    status: PENDING
       │
       ▼
  Re-block downstream stages:
    implement → BLOCKED (message: "Re-blocked: upstream stage test failed")
    test      → BLOCKED
       │
       ▼
  run.round_count++
  activity: workflow_fail_loopback
       │
       ▼
  如果 round_count >= max_rounds:
    下次 tool call 觸發 checkRunLimits()
    → cancelRun() + "Run exceeded max rounds"
```

### Gates Enforcement

```
  team_task(update, status: "COMPLETED")
       │
       ▼
  enforceGates(gates, "COMPLETED", existing, params, callerMember, teamConfig)
       │
       ├── require_deliverables: true → task.deliverables 有值?
       │     No → "Gate 'COMPLETED' requires deliverables"
       │
       ├── require_result: true → params.result 或 existing.result 有值?
       │     No → "Gate 'COMPLETED' requires a result"
       │
       └── approver: "orchestrator" → callerMember === orchestrator?
             No → "Gate 'COMPLETED' requires approval from orchestrator"
```

---

## 10. CLI Agent 架構

### 架構圖

```
  ┌─────── CLI Agent (claude/codex/gemini) ───────┐
  │                                                 │
  │  PTY Process                                    │
  │  ├── System Prompt (role + team context)        │
  │  ├── Initial Task Prompt                        │
  │  │                                              │
  │  └── MCP Client ──► stdio ──► MCP Bridge ──┐   │
  │                                             │   │
  └─────────────────────────────────────────────┘   │
                                                    │
                                    ┌───────────────┘
                                    │
                              MCP Bridge Process
                              (node mcp-bridge.js)
                                    │
                                    │ JSON-RPC over
                                    │ Unix socket / TCP
                                    ▼
                              IPC Server
                              (in main plugin process)
                                    │
                                    ▼
                              Tool Factories
                              (teamRunTool, teamTaskTool, ...)
                                    │
                                    ▼
                              TeamStores
```

### CliSpawner (PTY 管理)

**檔案**: `src/cli/cli-spawner.ts`

- **spawn()**: 建立 PTY 進程，設定 MCP config、系統 prompt
  - 支援 3 種 CLI: `claude`, `codex`, `gemini`
  - 每種 CLI 有專屬的命令建構 (MCP config 寫入方式不同)
  - PTY 輸出串流到 log 檔案
  - Spawn lock: 同一 agentId 不會重複啟動

- **CLI 命令建構**:
  - `claude`: `--append-system-prompt`, `--mcp-config`, `--dangerously-skip-permissions`, `-p`
  - `codex`: `--full-auto`, `--instructions` (codex.md), `-p`
  - `gemini`: `--sandbox_config_dir`, `--thinking`, `-p`

- **Crash Handler** (`onExit`):
  - Exit code ≠ 0: `handleCrash()` — WORKING tasks → FAILED，通知 orchestrator
  - Exit code = 0: `handleCleanExit()` — orphaned WORKING tasks → COMPLETED (附 log tail)

- **On-demand Spawn**: CLI agents 不在 activation 時啟動，而是在 task 被指派時 (`spawnCliIfNeeded`)

### IPC Server (JSON-RPC)

**檔案**: `src/cli/ipc-server.ts`

- **傳輸**: Unix domain socket 或 TCP (tcp://host:port)
- **協定**: line-delimited JSON (一行一個 JSON 物件)
- **請求**: `{"id":"1","method":"team_send","agentId":"at--eng--frontend","params":{...}}`
- **回應**: `{"id":"1","result":{...}}` 或 `{"id":"1","error":"..."}`

- **Session 解析** (4 層 fallback):
  1. `memberSessions` 中查找 agentId
  2. 從 WORKING runs 建構 session key
  3. 從 disk 掃描 active run 檔案
  4. 無 session → sessionKey = undefined

- **完成通知**: task COMPLETED/FAILED 時通知 orchestrator (enqueueSystemEvent + heartbeat)

- **Tool 執行**: 委派給與 native agents 相同的 tool factory，確保行為一致 (gates, workflow, CLI spawn, etc.)

### MCP Bridge (Standalone)

**檔案**: `src/cli/mcp-bridge.ts` (獨立編譯: `tsconfig.mcp-bridge.json`)

- **運行方式**: CLI agent 的 MCP runtime 啟動此 script (stdio transport)
- **環境變數**: `AT_AGENT_ID`, `AT_SOCK_PATH`
- **功能**: 將 MCP tool calls 轉為 IPC calls 發送到 IPC server
- **持久連接**: 連接 Unix socket / TCP，multiplexed 請求/回應
- **5 個工具**: team_run, team_task, team_memory, team_send, team_inbox

### Prompt Builder

**檔案**: `src/cli/prompt-builder.ts`

- **共用**: hook (native agents) 和 CLI spawner 都使用
- **9 個 section**: Role, Goal, Team Members, Tools, Event Topics, Decision Flow, Run Status, Learnings, Current Task
- **CLI 專屬**: 強調 MCP tools，mandatory completion workflow

### Log 檔案

- 路徑: `{stateDir}/logs/{team}/{member}.log`
- PTY raw output (含 ANSI escape codes)
- 觀察: `tail -f {logPath}`

---

## 11. Per-Run Session 架構

### Session Key 格式

```
agent:<agentId>:run:<runId>

範例: agent:at--eng--frontend:run:tr-20260316-143000-a1b2
```

### 資料結構

```
PluginRegistry:
  memberSessions: Map<agentId, Map<runId, RunSession>>
  sessionIndex:   Map<sessionKey, { agentId, runId }>

RunSession:
  sessionKey: string    // agent:at--eng--frontend:run:tr-xxx
  runId: string         // tr-xxx
  createdAt: number     // epoch ms
```

### Session 生命週期

```
  1. team_run(start) 或 team_task(create) 觸發 sessions_send
     → OpenClaw runtime 建立 session
     → before_agent_start hook 觸發
     → registerRunSession(registry, agentId, runId, sessionKey, now)
     → memberSessions[agentId][runId] = { sessionKey, runId, createdAt }
     → sessionIndex[sessionKey] = { agentId, runId }

  2. 工具呼叫時:
     → resolveRunIdFromSession(sessionKey) 從 key 提取 runId
     → tool 用 runId 定位正確的 run (支持並行 runs)

  3. Run 完成/取消:
     → archiveRun(runId)
     → cleanupRunSessions(registry, runId)
     → 從 memberSessions 和 sessionIndex 刪除所有相關 entries
```

### Session Recovery (重啟後)

```
  recoverRunSessions(teamsMap, registry)
       │
       ▼
  FOR EACH team:
    FOR EACH active WORKING run:
      FOR EACH task (non-terminal, assigned):
        agentId = makeAgentId(team, task.assigned_to)
        sessionKey = makeRunSessionKey(agentId, run.id)
        registerRunSession(registry, agentId, run.id, sessionKey, run.started_at)
```

---

## 12. 六大 State Store

### KvStore

| 屬性 | 值 |
|------|-----|
| **用途** | 小型 key-value 資料 (設定、計數器、學習紀錄) |
| **持久化** | `{stateDir}/kv/{team}.json` |
| **容量** | `max_entries` (預設 256) |
| **TTL** | Lazy expiry (get/list/save 時清理) |
| **溢出** | `evictOldest()` — 按 created_at 排序刪除最舊 |
| **特殊** | `iterEntries()` — single-pass 迭代器 |

### EventQueue

| 屬性 | 值 |
|------|-----|
| **用途** | 事件 pub/sub (topic-based) |
| **持久化** | `{stateDir}/events/{team}.json` |
| **容量** | Ring buffer, `max_backlog` (預設 500) |
| **溢出** | Start pointer 前移 (不 splice，save 時才 compact) |
| **查詢** | `subscribe(topic, since?, limit?)` — since 可以是 timestamp 或 event id |
| **特殊** | Counter 不重置，stale cursor 時回傳所有 |

### DocPool

| 屬性 | 值 |
|------|-----|
| **用途** | 大型文件 (markdown, JSON, CSV) |
| **持久化** | `{stateDir}/docs/{team}/` + `_index.json` |
| **容量** | `max_size_mb` (預設 50MB) |
| **安全** | Path traversal 防護 (`validateKey`) |
| **允許類型** | text/plain, text/markdown, text/csv, application/json |

### RunManager

| 屬性 | 值 |
|------|-----|
| **用途** | Run + Task 狀態機管理 |
| **持久化** | `{stateDir}/runs/{team}/active/{runId}.json` |
| **歸檔** | `{stateDir}/runs/{team}/archive/{runId}.json` |
| **並行** | 支援多個並行 active runs |
| **Disk fallback** | `tryLoadRunFromDisk()` — 處理 gateway 重啟 race condition |
| **Legacy** | 向後相容 `current.json` (自動遷移) |

### MessageStore

| 屬性 | 值 |
|------|-----|
| **用途** | 成員間直接訊息 |
| **持久化** | `{stateDir}/messages/{team}/messages.json` |
| **容量** | `max_messages` (預設 1000) |
| **溢出** | `trimAcked()` — 先刪已讀訊息 |
| **查詢** | `read(member, limit?, ack?)` — 可選 auto-ack |

### ActivityLog

| 屬性 | 值 |
|------|-----|
| **用途** | 完整審計日誌 (不像 EventQueue 有 ring buffer) |
| **持久化** | `{stateDir}/activity/{team}/activity.json` |
| **容量** | 10,000 entries → archive |
| **歸檔** | 超出時寫入 `archive-{timestamp}.json` (先寫 archive 再刪記憶體，防資料遺失) |
| **查詢** | Single-pass filter: type, agent, since, limit |
| **Broadcast** | `onEntry(callback)` → Broadcaster.emit() |

---

## 13. 五大工具

### team_run

**Actions**: `start`, `status`, `complete`, `cancel`

| Action | 關鍵參數 | 說明 |
|--------|---------|------|
| `start` | `team`, `goal` | 建立新 run；有 template 時自動產生 task chain；回傳 sessions_send 指令 |
| `status` | `team`, `run_id?` | 回傳 run 狀態、task 統計、進度 |
| `complete` | `team`, `result?` | 完成 run (需所有 tasks terminal)；consolidation + session cleanup |
| `cancel` | `team`, `reason?` | 取消 run + 所有 active tasks；per-task cancel logging |

**主要流程 (start)**:
1. `runs.startRun()` → 生成 run_id
2. `registerRunSession()` → 建立 session
3. 有 template? → `generateTaskChain()` + `spawnCliIfNeeded()`
4. 回傳 `REQUIRED_ACTION` (sessions_send 指令)
5. Knowledge retention: "current-run" → `clearLearnings()`

### team_task

**Actions**: `create`, `update`, `query`

| Action | 關鍵參數 | 說明 |
|--------|---------|------|
| `create` | `description`, `assign_to?`, `required_skills?`, `depends_on?` | 建立 task；routing → spawn CLI → wake native |
| `update` | `task_id`, `status?`, `result?`, `message?`, `deliverables?`, `learning?` | 更新 task；gates → revision → deps → loopback → cascade |
| `query` | `filter?`, `filter_status?`, `run_id?` | 查詢 tasks；filter: mine/unassigned/available |

**Update 流程 (關鍵路徑)**:
1. 驗證 state transition (`validateTransition`)
2. Gate enforcement (`enforceGates`)
3. REVISION_REQUESTED special handler
4. Deliverables 附加
5. Learning auto-capture (COMPLETED/FAILED)
6. `updateTask()`
7. COMPLETED → `resolveDependencies()` → wake assignees
8. FAILED → `cascadeCancelDependents()` + fail-loopback
9. Peer auto-complete / Orchestrator auto-complete check
10. Save all + notify requester

### team_memory

**Actions**: `get`, `set`, `delete`, `list`

| Action | 關鍵參數 | 說明 |
|--------|---------|------|
| `get` | `key`, `store?` (kv/docs) | 讀取 KV 值或 Doc 內容 |
| `set` | `key`, `value`, `ttl?`, `content_type?` | 寫入 KV 或 Doc |
| `delete` | `key`, `store?` | 刪除 KV entry 或 Doc file |
| `list` | `store?` | 列出所有 entries (KV 隱藏 learnings:*) |

### team_send

**參數**: `to?`, `message`, `topic?`, `data?`

| 模式 | 說明 |
|------|------|
| `to` 有值 | 直接訊息 (MessageStore.push) |
| `to="all"` | 廣播給所有成員 |
| `topic` 有值 | 發布事件 (EventQueue.publish) |
| `to` + `topic` | 同時做兩件事 |

### team_inbox

**參數**: `source?`, `limit?`, `ack?`, `topic?`, `since?`, `action?`, `filter_type?`, `filter_agent?`

| Source | 說明 |
|--------|------|
| `inbox` (預設) | 讀取直接訊息 (MessageStore.read) |
| `events` | 讀取事件佇列 (EventQueue.subscribe) |
| `activity` | 查詢活動日誌 (ActivityLog.query) |

| Action | 說明 |
|--------|------|
| `read` (預設) | 讀取訊息/事件/活動 |
| `list_topics` | 列出所有事件 topics |

---

## 14. Hooks 生命週期

### before_agent_start

**觸發**: Agent 啟動時 (native subagent)

```
  isTeamAgent(agentId)? → No → skip
       │
      Yes
       │
       ▼
  registry.getTeamStores() + getTeamConfig()
       │
       ▼
  buildSystemPrompt(params)
  → 9 sections: role, goal, members, tools, events, decision flow,
    run status, learnings, initial task
       │
       ▼
  return { prependContext: prompt, modelOverride? }
```

### before_compaction

**觸發**: Token count 接近上限，OpenClaw 壓縮前

```
  isTeamAgent(agentId)? → No → skip
       │
      Yes
       │
       ▼
  收集當前狀態:
  - run status + tasks
  - recent memory (kv, 前 10 筆)
  - unread messages
       │
       ▼
  組合 summary:
  "[Post-Compaction State Restore]
   You are {member} in team {team}
   Run: {run_id} ({status})
   Goal: {goal}
   Tasks: ...
   Memory: ..."
       │
       ▼
  enqueueSystemEvent(summary, { sessionKey })
  → 壓縮後 agent 恢復團隊感知
```

### subagent_ended

**觸發**: Native subagent 結束 (正常退出或崩潰)

```
  isTeamAgent(agentId)? → No → skip
       │
      Yes
       │
       ▼
  遍歷所有 active runs:
    找 assigned_to === member 且 status === "WORKING" 的 tasks
       │
       ▼
  每個 orphaned task → FAILED
  message: "Agent session ended unexpectedly"
  activity: task_failed
       │
       ▼
  notifyRequester + save
```

### subagent_delivery_target

**觸發**: Subagent 回傳結果，決定路由目標

```
  isTeamAgent(agentId)? → No → skip
       │
      Yes
       │
       ▼
  orchestrator 模式?
       │
      Yes → return { targetAgentId: orchestratorAgentId }
             (結果送給 orchestrator 而非 main agent)
       │
      No → skip (peer 模式結果送給 main agent)
```

---

## 15. Commands 參考 (/team)

| 子命令 | 語法 | 權限 | 說明 |
|--------|------|------|------|
| `list` 或 (無) | `/team` | 公開 | 列出所有團隊、成員數、CLI 成員、run 狀態 |
| `status` | `/team status [team]` | 公開 | 顯示團隊狀態、task board、active members |
| `stop` | `/team stop <team>` | 需授權 | 取消指定團隊的 run |
| `agents` | `/team agents` | 公開 | 列出所有 CLI agent 進程 (pid, status, uptime, cwd, log path) |
| `logs` | `/team logs <team/member>` | 公開 | 顯示 CLI agent log 檔案路徑 |
| `start` | `/team start <team/member>` | 需授權 | 手動啟動 CLI agent |
| `stop-agent` | `/team stop-agent <team/member>` | 需授權 | 停止 CLI agent (SIGTERM) |

**成員引用**: 支援 `team/member` 或 `member` (自動搜尋所屬團隊)

---

## 16. 機制保證

### Timeout Enforcement

```
  每次 tool call (team_task, team_run 的 create/update):
       │
       ▼
  checkRunLimits(run, config)
       │
       ▼
  elapsed = (now - run.started_at) / 1000
  elapsed > config.workflow.timeout?
       │
      Yes → handleEnforcementViolation()
       │     cancelRun(team, "Run exceeded timeout")
       │     activity: run_timeout
       │     notifyRequester("Run auto-canceled: ...")
       │
      No → 繼續
```

### Max Rounds Enforcement

```
  每次 tool call:
       │
       ▼
  checkRunLimits(run, config)
       │
       ▼
  run.round_count >= config.workflow.max_rounds?
       │
      Yes → handleEnforcementViolation()
       │     cancelRun(team, "Run exceeded max rounds")
       │     activity: run_max_rounds_exceeded
       │
      No → 繼續

  round_count 遞增時機:
  - fail-loopback (template 失敗回溯)
  - REVISION_REQUESTED (審查要求修訂)
```

### Cascade Cancel

```
  task → FAILED 或 CANCELED
       │
       ▼
  cascadeCancelDependents(allTasks, taskId)
       │
       ▼
  迭代傳播: 所有直接/間接依賴的 BLOCKED/PENDING/WORKING tasks → CANCELED
  每個 cascaded task:
    message: "Cascade-canceled: dependency 'X' was canceled (root: 'Y')"
    activity: dependency_cascaded
```

### Peer Auto-Complete

```
  每次 task 更新 (COMPLETED/FAILED/CANCELED):
       │
       ▼
  shouldAutoComplete(run)
       │
       ▼
  run.status === "WORKING"
  && run.tasks.length > 0
  && 所有 tasks 都是 terminal?
       │
      Yes → completeRun() 或 failRun() (依 allCompleted)
       │     activity: run_completed (auto_complete: true, peer_mode: true)
       │     notifyRequester()
       │
      No → 繼續
```

### Orchestrator Lazy Auto-Complete (60s Grace)

```
  所有 tasks terminal → 記錄 all_terminal_at
       │
       ▼
  每次 tool call:
  shouldOrchestratorAutoComplete(run, config)
       │
       ▼
  elapsed = (now - all_terminal_at) / 1000
  elapsed >= 60?
       │
      Yes → handleOrchestratorAutoComplete()
       │     buildConsolidatedResult(run)
       │     completeRun(team, consolidated)
       │     activity: run_completed (orchestrator_mode: true, auto_complete: true)
       │
      No → 等待 orchestrator 手動完成或建立新 tasks

  注意: REVISION_REQUESTED 會重置 all_terminal_at，防止 premature auto-complete
```

### Native Crash Recovery

```
  subagent_ended hook:
       │
       ▼
  Agent session 結束 (正常或異常)
       │
       ▼
  找 agent 的 WORKING tasks → FAILED
  message: "Agent session ended unexpectedly"
  activity: task_failed
  notifyRequester()
```

### CLI Crash Recovery

```
  PTY onExit(exitCode):
       │
       ├── exitCode !== 0 (crash):
       │     WORKING tasks → FAILED
       │     learning: failure "CLI agent crashed"
       │     通知 orchestrator (message + system event)
       │     activity: task_failed
       │
       └── exitCode === 0 (clean exit):
             orphaned WORKING tasks → COMPLETED
             result: "[Auto-completed on CLI exit] {log tail}"
             activity: task_completed (auto_completed: true)
```

### Session Cleanup

```
  Run 完成/取消:
       │
       ▼
  archiveRun(runId)
       │
       ▼
  cleanupRunSessions(registry, runId)
  → 從 memberSessions 刪除所有 agent 的 runId session
  → 從 sessionIndex 刪除對應的 sessionKey
```

### Audit Trail (Per-Task Cancel Logging)

```
  cancelRun(team, reason):
       │
       ▼
  每個 active task → CANCELED
       │
       ▼
  team_run complete/cancel handler:
  FOR EACH canceled task:
    activity: task_canceled
    description: "Task canceled due to run cancellation: {reason}"
```

---

## 17. Knowledge 系統

### Learning 自動捕捉

```
  task → COMPLETED 或 FAILED
       │
       ▼
  buildLearning(params, existing)
       │
       ├── params.learning 有值?
       │     Yes → 使用明確提供的值
       │           confidence: params.learning.confidence ?? 0.7
       │           category: params.learning.category ?? auto-detect
       │
       │     No → status === FAILED && message 有值?
       │           Yes → Auto-generate:
       │                 confidence: 0.5
       │                 category: "failure"
       │                 content: "Task failed: {desc}: {message}"
       │
       │           No → status === COMPLETED && result 有值 && result.length > 50?
       │                 Yes → Auto-generate:
       │                       confidence: 0.5
       │                       category: "insight"
       │                       content: "Completed: {desc}: {result}"
       │
       │                 No → null (不捕捉)
       │
       ▼
  learning 不為 null:
  KV 持久化: kv.set("learnings:{category}:{taskId}", learning, member)
  activity: learning_captured
  notify_leader? → messages.push(member, orchestrator, "New learning [...]")
```

### Structured Learning 格式

```typescript
interface StructuredLearning {
  content: string;        // 學習內容
  confidence: number;     // 0.0 – 1.0
  category: LearningCategory;  // "failure" | "pattern" | "fix" | "insight"
  task_id?: string;
  timestamp: number;
}
```

### KV 儲存格式

```
Key: learnings:<category>:<topic>        (structured)
Key: learnings:<topic>                   (legacy)
Key: learnings:consolidated:<runId>      (合併摘要)
```

### Consolidation (合併)

```
  Run 完成時 (knowledge.consolidation = true):
       │
       ▼
  consolidateLearnings(kv, runId)
       │
       ▼
  收集所有 learnings:* entries (最多 50 筆)
  按 category 分組
  每組取 top 5
       │
       ▼
  儲存: kv.set("learnings:consolidated:{runId}", summary, "system")
```

### Cross-Run 持久化

```
  retention: "across-runs" (預設)
  → learnings 跨 run 保留
  → agent_start hook 注入 "## Previous Learnings" (top 10 by confidence)

  retention: "current-run"
  → 新 run 啟動時 clearLearnings(kv)
  → 清除所有 learnings:* entries
```

---

## 18. Broadcasting 系統 (Observability)

### 架構

```
  ActivityLog.log()
       │
       ▼
  broadcastCallback(entry)    ← onEntry() 設定
       │
       ▼
  Broadcaster.emit(entry)
       │
       ▼
  ActivityEntry → BroadcastEvent 轉換:
  { id: "evt-42",
    type: entry.type,
    team: entry.team,
    agent: entry.agent,
    data: { description, target_id, ...metadata },
    ts: entry.timestamp }
       │
       ▼
  JSON.stringify + "\n"
       │
       ▼
  appendFile("broadcast.jsonl")
       │
       ▼
  fileSize > 10MB?
  Yes → rotate: rename → broadcast.jsonl.{timestamp}
        建立新 broadcast.jsonl
```

### 所有 22 個 ActivityType 觸發點

| ActivityType | 觸發位置 | 觸發時機 |
|---|---|---|
| `task_created` | team_task(create) | 新 task 建立後 |
| `task_updated` | team_task(update) | 狀態變更 (非 terminal) |
| `task_completed` | team_task(update) | status → COMPLETED |
| `task_failed` | team_task(update), subagent_ended, cli crash | status → FAILED |
| `task_canceled` | team_run(cancel/complete), cascadeCancelDependents | task → CANCELED |
| `run_started` | team_run(start) | 新 run 啟動 |
| `run_completed` | team_run(complete), peer auto-complete, orchestrator auto-complete | run 完成 |
| `run_canceled` | team_run(cancel), /team stop, enforcement violation | run 取消 |
| `run_timeout` | enforcement.ts checkRunLimits | run 超時 |
| `run_max_rounds_exceeded` | enforcement.ts checkRunLimits | run 超出最大回合數 |
| `message_sent` | team_send | 直接訊息或事件發送 |
| `memory_updated` | team_memory(set/delete) | KV 或 DocPool 變更 |
| `deliverable_added` | team_task(update) + deliverables | 附件新增 |
| `dependency_resolved` | team_task(update, COMPLETED) | BLOCKED tasks → PENDING |
| `dependency_blocked` | team_task(create) + depends_on | 新 task 因依賴被 BLOCKED |
| `dependency_cascaded` | cascadeCancelDependents | 連鎖取消依賴的 tasks |
| `learning_captured` | team_task(update, COMPLETED/FAILED) | 自動/手動捕捉學習 |
| `workflow_stage_advanced` | team_run(start) + template | workflow task chain 生成 |
| `workflow_fail_loopback` | team_task(update, FAILED) + template | 失敗回溯處理 |
| `task_revision_requested` | team_task(update, REVISION_REQUESTED) | orchestrator 要求修訂 |
| `task_revision_restarted` | team_task(update, WORKING) from REVISION_REQUESTED | worker 開始修訂 |

### 外部監控

```bash
# 即時監控所有事件
tail -f ~/.openclaw/plugins/agent-teams/broadcast.jsonl | jq

# 只看特定類型
tail -f broadcast.jsonl | jq 'select(.type == "task_completed")'

# 只看特定團隊
tail -f broadcast.jsonl | jq 'select(.team == "eng")'
```

---

## 情景 1: Orchestrator 完整生命週期

```
  User                Main Agent              at--dev--pm (orchestrator)       at--dev--alice
   │                     │                           │                             │
   │ "建電商結帳功能"     │                           │                             │
   │────────────────────>│                           │                             │
   │                     │                           │                             │
   │                     │ team_run(start,           │                             │
   │                     │  team="dev",              │                             │
   │                     │  goal="建電商結帳功能")    │                             │
   │                     │                           │                             │
   │                     │ → run_id = tr-xxx         │                             │
   │                     │ → REQUIRED_ACTION:        │                             │
   │                     │   sessions_send to pm     │                             │
   │                     │                           │                             │
   │                     │ sessions_send(             │                             │
   │                     │  message="Work on goal",  │                             │
   │                     │  sessionKey="agent:at--   │                             │
   │                     │   dev--pm:run:tr-xxx")    │                             │
   │                     │─────────────────────────>│                             │
   │                     │                           │                             │
   │                     │                           │ team_task(create,           │
   │                     │                           │  description="結帳 UI",     │
   │                     │                           │  assign_to="alice")         │
   │                     │                           │                             │
   │                     │                           │ → REQUIRED_ACTION:          │
   │                     │                           │   sessions_send to alice    │
   │                     │                           │                             │
   │                     │ ← sessions_send 指令      │                             │
   │                     │   (via system event)      │                             │
   │                     │                           │                             │
   │                     │ sessions_send(             │                             │
   │                     │  message="Work on...",    │                             │
   │                     │  sessionKey="agent:at--   │                             │
   │                     │   dev--alice:run:tr-xxx") │                             │
   │                     │─────────────────────────────────────────────────────────>│
   │                     │                           │                             │
   │                     │                           │                             │ 執行工作...
   │                     │                           │                             │
   │                     │                           │                             │ team_task(update,
   │                     │                           │                             │  task_id, status:
   │                     │                           │                             │  "COMPLETED",
   │                     │                           │                             │  result: "完成")
   │                     │                           │                             │
   │                     │                           │ 收到通知 (system event)     │
   │                     │                           │                             │
   │                     │                           │ team_task(query)            │
   │                     │                           │ 審查 alice 的結果            │
   │                     │                           │                             │
   │                     │                           │ team_run(complete,          │
   │                     │                           │  result="電商結帳完成")     │
   │                     │                           │                             │
   │                     │ ← 通知 (system event)     │                             │
   │                     │   "Run completed"         │                             │
   │                     │                           │                             │
   │ ← 回報結果           │                           │                             │
```

---

## 情景 2: Peer 模式 — 自組織 + Auto-Complete

```
  Main Agent              at--research--alice              at--research--bob
       │                         │                              │
       │ team_run(start,         │                              │
       │  team="research",       │                              │
       │  goal="調研 AI 趨勢")   │                              │
       │                         │                              │
       │ sessions_send × 2       │                              │
       │────────────────────────>│                              │
       │─────────────────────────────────────────────────────────>│
       │                         │                              │
       │                         │ team_task(query)             │
       │                         │ 查看現有 tasks (空)          │
       │                         │                              │
       │                         │ team_task(create,            │
       │                         │  description="調研 LLM")    │
       │                         │ → 自動分配給自己              │
       │                         │                              │
       │                         │                              │ team_task(query, filter="available")
       │                         │                              │ 查看可認領的 tasks
       │                         │                              │
       │                         │                              │ team_task(create,
       │                         │                              │  description="調研 Vision")
       │                         │                              │ → 自動分配給自己
       │                         │                              │
       │                         │ team_send(to="bob",          │
       │                         │  message="我在做 LLM")      │
       │                         │──────────────────────────────>│
       │                         │                              │
       │                         │                              │ team_inbox
       │                         │                              │ 收到 alice 的訊息
       │                         │                              │
       │                         │ team_task(update,            │
       │                         │  COMPLETED, result="LLM     │
       │                         │  趨勢報告")                  │
       │                         │                              │
       │                         │                              │ team_task(update,
       │                         │                              │  COMPLETED, result="Vision 報告")
       │                         │                              │
       │                         │      shouldAutoComplete()    │
       │                         │      所有 tasks terminal     │
       │                         │      → run COMPLETED         │
       │                         │                              │
       │ ← 通知 "Run completed"  │                              │
```

---

## 情景 3: 依賴鏈 — BLOCKED → PENDING → 自動解鎖

```
  Orchestrator (pm)
       │
       │ team_task(create, "前端 API 設計", assign_to="designer")
       │ → task-1 [PENDING]
       │
       │ team_task(create, "前端實作", assign_to="frontend", depends_on=["task-1"])
       │ → task-2 [BLOCKED] (depends on task-1)
       │
       │ team_task(create, "測試", assign_to="tester", depends_on=["task-2"])
       │ → task-3 [BLOCKED] (depends on task-2)
       │
       │
       │         designer 完成 task-1
       │              │
       │              ▼
       │         resolveDependencies(tasks, "task-1")
       │              │
       │              ▼
       │         task-2: depends_on = ["task-1"]
       │                 all deps COMPLETED → BLOCKED → PENDING
       │         task-3: depends_on = ["task-2"]
       │                 task-2 not COMPLETED → 保持 BLOCKED
       │              │
       │              ▼
       │         wakeActiveNativeAssignee(frontend)
       │         → frontend 收到通知，開始 task-2
       │
       │         frontend 完成 task-2
       │              │
       │              ▼
       │         resolveDependencies(tasks, "task-2")
       │              │
       │              ▼
       │         task-3: depends_on = ["task-2"]
       │                 all deps COMPLETED → BLOCKED → PENDING
       │              │
       │              ▼
       │         tester 被啟動
```

---

## 情景 4: Workflow Template — Stage Chain + Fail-Loopback

```
  template:
    stages: [design, implement, test]
    fail_handlers:
      test: design

  team_run(start)
       │
       ▼
  generateTaskChain():
    [PENDING]  task-tr-xxx-stage-design     → designer
    [BLOCKED]  task-tr-xxx-stage-implement  → developer
    [BLOCKED]  task-tr-xxx-stage-test       → tester
       │
       ▼
  design COMPLETED → implement PENDING → implement COMPLETED → test PENDING
       │
       ▼
  test FAILED ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ←
       │
       ▼
  handleFailLoopback("test", "design")
       │
       ├── 建立 rework task:
       │   [PENDING] task-tr-xxx-rework-design-{ts}
       │   → designer (原 design assignee)
       │   description: "[design - rework] ... (Failure reason: ...)"
       │
       ├── Re-block:
       │   implement → BLOCKED
       │   test      → BLOCKED
       │
       └── round_count++
            │
            ▼
       round_count >= max_rounds?
            │
           Yes → 下次 tool call → cancelRun("Run exceeded max rounds")
           No  → rework task 開始...
```

---

## 情景 5: Approval Gates — 多重驗證

```
  gates:
    COMPLETED:
      require_deliverables: true
      require_result: true
      approver: "orchestrator"

  ─── 失敗案例 ─────────────────────────────────────────

  worker team_task(update, status=COMPLETED)
       │
       ▼
  enforceGates("COMPLETED", task, params, "worker", teamConfig)
       │
       ├── require_deliverables → task.deliverables 空 → ❌ FAIL
       │   "Gate 'COMPLETED' requires deliverables"
       │
       ├── require_result → params.result 空 → ❌ FAIL
       │   "Gate 'COMPLETED' requires a result"
       │
       └── approver: "orchestrator" → caller="worker" ≠ orchestrator → ❌ FAIL
           "Gate 'COMPLETED' requires approval from 'pm'"

  ─── 正確流程 ─────────────────────────────────────────

  worker:
    team_task(update, task_id, deliverables=[{type:"file", path:"/out.md"}])
    → 附加 deliverables

    team_task(update, task_id, result="完成，已通過測試")
    → 設定 result

    team_send(to="pm", message="task-1 已準備好")

  orchestrator (pm):
    team_task(update, task_id, status=COMPLETED)
    → require_deliverables: ✓
    → require_result: ✓
    → approver: caller=pm ✓
    → PASS ✅
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
  events.length - startIndex > 500?
       │
      Yes
       │
       ▼
  startIndex = events.length - 500   ← 移動 start pointer
       │                               (不 splice，save 時才 compact)
       ▼
  active events = 500

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
   │                         │  isExpired(entry)
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
   │  load/save/list 觸發     │
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
  排序所有 entries by created_at (O(n log n))
       │
       ▼
  刪除最舊的 entries 直到 size ≤ 256
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

  ⚠️ 只 cancel BLOCKED, PENDING, WORKING
     COMPLETED 不受影響
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
  Active task counts (PENDING + WORKING only):
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
                  broadcast.jsonl.{ts}
                  建立新 broadcast.jsonl
```

---

## 情景 13: 完整初始化流程

```
  Plugin activate(api)
       │
       ▼
  1. validateConfig()
       │
       ▼
  2. parseConfig()
     套用 defaults: max_rounds=10, timeout=900, retention='across-runs'
       │
       ▼
  3. reconcileHostRuntimeConfig()
       │
       ▼
  4. 初始化 Registry (模組級 singletons)
     _teamsMap, _memberSessions, _sessionIndex
     setRegistry(registry)
       │
       ▼
  5. hasCliMembers? → createLazyCliInit() → registry.ensureCliReady
       │
       ▼
  6. registerPluginSurface(api)  ← 同步! (before first await)
     → 4 hooks (priority 10): agent_start, compaction, subagent_ended, delivery_target
     → 5 tools (factory pattern): team_run, team_task, team_memory, team_send, team_inbox
     → 1 command: /team (7 subcommands)
       │
       ▼
  7. 首次啟動? (_storesInitialized = false)
     │
    Yes
     │
     ▼
  8. initTeamStores()
     ├── Broadcaster 初始化
     ├── FOR EACH team:
     │     ├── 建立 6 stores (KV, Events, Docs, Runs, Messages, Activity)
     │     ├── activity.onEntry(broadcaster.emit) ← wire broadcasting
     │     └── 並行 load: kv, events, docs, runs, messages, activity
     │
     ├── recoverRunSessions()     ← 從 active runs 重建 session maps
     │
     ├── provisionAgents()        ← 為 native members 佈署 agents
     │   injectAgents()             CLI members 跳過佈署但加入 allow list
     │   createWorkspaces()
     │
     └── hasCliMembers? → ensureCliReady() 背景啟動
           → IpcServer.start() (Unix socket)
           → CliSpawner 初始化
           → 註冊 SIGINT/SIGTERM cleanup
       │
       ▼
  _storesInitialized = true
  Plugin ready ✓

  重複啟動 (gateway re-activation):
  → stores 保留在記憶體 (模組級 singletons)
  → 重新 registerPluginSurface
  → 重新 provisionAgents + injectAgents
  → 不重新 load stores
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
     {roleDescription from role or role_file}
       │
       ▼
  2. ## Current Goal
     {run.goal}
       │
       ▼
  3. ## Team Members
     Coordination: orchestrator | Orchestrator: pm
     - pm: Project Manager
     - frontend (you): Frontend Developer [react, typescript]
     - backend: Backend Developer
       │
       ▼
  4. ## Available Team Tools
     CLI: 含 MANDATORY completion workflow
     Native: 標準工具列表
       │
       ▼
  5. events.getTopics() 有 topics?
     ├── Yes → ## Event Topics
     │         Active topics: build, deploy
     └── No  → (skip)
     + activity hint
       │
       ▼
  6. ## Decision Flow
     Orchestrator → delegate flow
     Worker → claim + complete flow
     Peer → self-organize flow
       │
       ▼
  7. ## Run Status
     Run ID, Status, Task counts
     Task list (前 15 個)
       │
       ▼
  8. ## Previous Learnings
     collectLearnings(kv, 10)
     Sorted by confidence
     [fix] connection pool (0.9)
     [failure] API timeout (0.5)
       │
       ▼
  9. ## Your Current Task (CLI only)
     {initialTask description}
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
  safeSaveAll — 並行儲存
       │
       ├─────────────────────┐
       │                     │
       ▼                     ▼
  kv.save()             activity.save()
       │                     │
       ▼                     ▼
  writeJson:             entries.length > 10,000?
   writeFile(             │
    kv.json.tmp.{rand},   ├── Yes:
    data)                  │   writeFile(archive-{ts}.json,
       │                  │    oldest 5000)
       ▼                  │   entries.splice(0, 5000)
  rename(                 │
   kv.json.tmp.{rand},    └── Then:
   kv.json)                   writeFile(
       │                       activity.json.tmp.{rand},
  ★ Atomic!                    entries)
  Readers 永遠                      │
  看到完整 JSON                     ▼
                                rename(
                                 activity.json.tmp.{rand},
                                 activity.json)
                                     │
                                ★ Atomic!

  如果 rename 前斷電:
  tmp 檔殘留，原檔未被改動
  下次 load 正常
```

---

## 情景 16: Orchestrator 審查 + 修訂循環

```
  Orchestrator (pm)                    Worker (alice)              CLI Worker (bob)
       │                                  │                           │
       │ team_task(create,                │                           │
       │  "建構 API endpoint",            │                           │
       │  assign_to="alice")             │                           │
       │                                  │                           │
       │ team_task(create,                │                           │
       │  "建構前端頁面",                  │                           │
       │  assign_to="bob")               │                           │
       │                                  │                           │
       │                                  │ (native agent 啟動)       │ (CLI agent PTY spawn)
       │                                  │ PENDING → WORKING         │ PENDING → WORKING
       │                                  │                           │
       │                                  │ 工作...                   │ 工作...
       │                                  │                           │
       │                                  │ team_task(update,         │ team_task(update,
       │                                  │  COMPLETED,               │  COMPLETED,
       │                                  │  result="API done")       │  result="Frontend done")
       │                                  │                           │ (CLI exit code 0)
       │                                  │                           │
       │ 收到通知                          │                           │
       │ team_task(query)                 │                           │
       │ 審查 alice 和 bob 的結果          │                           │
       │                                  │                           │
       │ alice 的 API 缺少錯誤處理...      │                           │
       │                                  │                           │
       │ team_task(update,                │                           │
       │  task_id=alice-task,             │                           │
       │  status="REVISION_REQUESTED",   │                           │
       │  message="缺少 error handling    │                           │
       │   和 input validation")          │                           │
       │                                  │                           │
       │── Guards ────────────────────── │                           │
       │  ✓ caller = pm (orchestrator)    │                           │
       │  ✓ status = COMPLETED → REVISION_REQUESTED ✓                │
       │  ✓ message 有值 ✓               │                           │
       │  ✓ no active dependents ✓        │                           │
       │                                  │                           │
       │── Post-transition ──────────── │                           │
       │  revision_count: 0 → 1          │                           │
       │  round_count++                   │                           │
       │  all_terminal_at = undefined     │                           │
       │  activity: task_revision_requested                          │
       │                                  │                           │
       │  enqueueSystemEvent              │                           │
       │  "[Revision Requested]           │                           │
       │   缺少 error handling..."        │                           │
       │────────────────────────────────>│                           │
       │  requestHeartbeatNow            │                           │
       │                                  │                           │
       │                                  │ 收到系統通知               │
       │                                  │                           │
       │                                  │ team_task(update,         │
       │                                  │  task_id, status="WORKING")│
       │                                  │ → task_revision_restarted │
       │                                  │ → revision_feedback 清除  │
       │                                  │                           │
       │                                  │ 修改 API...               │
       │                                  │ 添加 error handling       │
       │                                  │ 添加 validation           │
       │                                  │                           │
       │                                  │ team_task(update,         │
       │                                  │  COMPLETED,               │
       │                                  │  result="已添加 error     │
       │                                  │   handling + validation") │
       │                                  │                           │
       │ 再次審查...                       │                           │
       │ 品質通過 ✓                        │                           │
       │                                  │                           │
       │ team_run(complete,               │                           │
       │  result="所有工作完成")           │                           │
```

---

## 情景 17: CLI Agent 生命週期

```
  Orchestrator                    CliSpawner              CLI Agent (claude)
       │                              │                        │
       │ team_task(create,             │                        │
       │  assign_to="coder")          │                        │
       │                              │                        │
       │ spawnCliIfNeeded()           │                        │
       │ memberConfig.cli = "claude"  │                        │
       │─────────────────────────────>│                        │
       │                              │                        │
       │                              │ resolveCliPath("claude")
       │                              │ → /usr/local/bin/claude
       │                              │                        │
       │                              │ writeMcpConfig(agentId)
       │                              │ → {stateDir}/mcp-config/at--xxx.json
       │                              │   { mcpServers: { "agent-teams": {
       │                              │     command: "node",
       │                              │     args: ["mcp-bridge.js"],
       │                              │     env: { AT_AGENT_ID, AT_SOCK_PATH }
       │                              │   }}}
       │                              │                        │
       │                              │ buildSystemPrompt()    │
       │                              │ → role + team context  │
       │                              │   + initial task       │
       │                              │                        │
       │                              │ pty.spawn("claude", [  │
       │                              │  "--append-system-prompt", ...,
       │                              │  "--mcp-config", ..., │
       │                              │  "--dangerously-skip-permissions",
       │                              │  "-p", taskPrompt     │
       │                              │ ])                     │
       │                              │───────────────────────>│
       │                              │                        │
       │                              │ PTY output → logStream │ 啟動...
       │                              │ (logs/{team}/{member}.log)
       │                              │                        │
       │                              │                        │ MCP client 啟動
       │                              │                        │ → spawn mcp-bridge.js
       │                              │                        │ → 連接 IPC socket
       │                              │                        │
       │                              │                        │ 工作中...
       │                              │                        │ team_task(update, COMPLETED)
       │                              │                        │  → MCP → IPC → tool execute
       │                              │                        │
       │ ← 通知                        │                        │
       │   (via IPC notifyOrchestrator)│                        │
       │                              │                        │
       │                              │ onExit(exitCode=0)     │ process exits
       │                              │                        │
       │                              │ handleCleanExit():
       │                              │  orphaned WORKING? → COMPLETED
       │                              │  clean up temp files
       │                              │  processes.delete(agentId)
       │                              │
       │   ─── 崩潰場景 ─────────────────────────────────────────
       │                              │
       │                              │ onExit(exitCode=1)     │ crash!
       │                              │                        │
       │                              │ handleCrash():
       │                              │  WORKING tasks → FAILED
       │                              │  learning: "CLI agent crashed"
       │                              │  通知 orchestrator (message + system event)
       │                              │  activity: task_failed
```

---

## 資料流總覽圖

```
  ┌────────────────────────────────────────────────────────────────────────────┐
  │                                                                            │
  │  User / External                                                           │
  │       │                                                                    │
  │       ├──► Team Commands: /team list, /team status, /team stop,            │
  │       │    /team agents, /team logs, /team start, /team stop-agent         │
  │       │                                                                    │
  │       └──► Hooks: agent_start, compaction, subagent_ended,                │
  │                   delivery_target                                          │
  │                          │                                                 │
  │                          ▼                                                 │
  │              ┌─── Tools ────────────────────┐                              │
  │              │ team_run    │ team_task       │                              │
  │              │ team_memory │ team_send       │                              │
  │              │ team_inbox  │                 │                              │
  │              └─────────────┬─────────────────┘                              │
  │                            │                                               │
  │               ┌────────────┼────────────────────┐                          │
  │               │            │                    │                          │
  │               ▼            ▼                    ▼                          │
  │        ┌─── TeamStores ──────┐    ┌─── CLI Infrastructure ──────┐         │
  │        │                      │    │                              │         │
  │        │ RunManager           │    │ CliSpawner (PTY)             │         │
  │        │ KvStore              │    │      │                      │         │
  │        │ EventQueue           │    │      ▼                      │         │
  │        │ DocPool              │    │ CLI Agent (claude/codex/    │         │
  │        │ MessageStore         │    │           gemini)           │         │
  │        │ ActivityLog ─────────│──┐ │      │                      │         │
  │        │                      │  │ │      ▼                      │         │
  │        └──────────┬───────────┘  │ │ MCP Bridge                  │         │
  │                   │              │ │      │                      │         │
  │            atomic writes         │ │      ▼                      │         │
  │           (tmp + rename)         │ │ IPC Server ─── Tool Execute │         │
  │                   │              │ │                              │         │
  │                   ▼              │ └──────────────────────────────┘         │
  │    ~/.openclaw/plugins/          │                                          │
  │    agent-teams/{team}/           │                                          │
  │    ├── kv/                       │                                          │
  │    ├── events/                   │                                          │
  │    ├── docs/                     ▼                                          │
  │    ├── runs/active/         Broadcaster                                    │
  │    ├── runs/archive/        → broadcast.jsonl (10MB rotate)                │
  │    ├── messages/            → tail -f | jq                                 │
  │    ├── activity/                                                           │
  │    ├── logs/{team}/{member}.log                                            │
  │    ├── mcp-config/                                                         │
  │    └── ipc.sock                                                            │
  │                                                                            │
  └────────────────────────────────────────────────────────────────────────────┘
```

---

## 檔案結構

```
openclaw-agent-teams-plugin/
├── index.ts                         # Plugin 入口 (activate)
├── package.json
├── tsconfig.json                    # 主 TypeScript 設定
├── tsconfig.mcp-bridge.json         # MCP bridge 獨立編譯設定
├── docs/
│   └── architecture-scenarios.md    # 本文件
├── src/
│   ├── types.ts                     # 所有型別定義 + helper functions
│   ├── config.ts                    # Config 驗證 + 解析
│   ├── registry.ts                  # 全域 Registry singleton + session helpers
│   ├── broadcast.ts                 # .jsonl event broadcasting
│   ├── enforcement.ts               # Timeout, max_rounds, orchestrator auto-complete
│   ├── context.ts                   # Context helpers
│   │
│   ├── init/                        # 初始化模組
│   │   ├── plugin-registrar.ts      # 同步註冊 hooks/tools/commands
│   │   ├── store-initializer.ts     # Per-team stores + broadcaster init
│   │   ├── session-recovery.ts      # 從持久化 runs 重建 sessions
│   │   └── cli-initializer.ts       # IPC server + CLI spawner lazy init
│   │
│   ├── state/                       # 持久化 state stores
│   │   ├── kv-store.ts              # KV store (TTL, eviction)
│   │   ├── event-queue.ts           # Ring buffer event queue
│   │   ├── doc-pool.ts              # File-backed document pool
│   │   ├── run-manager.ts           # Run/Task state machine
│   │   ├── message-store.ts         # Per-member message queue
│   │   ├── activity-log.ts          # Append-only audit log
│   │   └── persistence.ts           # Atomic write (tmp + rename)
│   │
│   ├── tools/                       # 5 核心工具
│   │   ├── team-run.ts              # Run lifecycle
│   │   ├── team-task.ts             # Task CRUD + gates + revision + deps
│   │   ├── team-memory.ts           # KV + docs memory
│   │   ├── team-send.ts             # Direct + topic messaging
│   │   ├── team-inbox.ts            # Inbox + events + activity
│   │   ├── tool-helpers.ts          # Shared helpers (re-exports)
│   │   └── cli-spawn-helper.ts      # CLI agent on-demand spawn
│   │
│   ├── routing/                     # 路由 + 依賴
│   │   ├── task-dispatcher.ts       # 3-layer routing with load balancing
│   │   └── dependency-resolver.ts   # Deps, cascade cancel, cycle detection
│   │
│   ├── workflow/                    # Workflow template engine
│   │   └── template-engine.ts       # Stage chain + fail-loopback
│   │
│   ├── patterns/                    # 協調模式
│   │   ├── orchestrator.ts          # Orchestrator context builder
│   │   └── peer.ts                  # Peer context + auto-complete
│   │
│   ├── hooks/                       # 4 lifecycle hooks
│   │   ├── agent-start.ts           # before_agent_start (prompt injection)
│   │   ├── compaction.ts            # before_compaction (state restore)
│   │   ├── subagent-lifecycle.ts    # subagent_ended + delivery_target
│   │   └── delivery.ts             # Delivery helpers
│   │
│   ├── cli/                         # CLI agent infrastructure
│   │   ├── cli-spawner.ts           # PTY management + crash handlers
│   │   ├── ipc-server.ts            # JSON-RPC server (Unix/TCP)
│   │   ├── mcp-bridge.ts            # Standalone MCP server (separate build)
│   │   ├── prompt-builder.ts        # System prompt builder (shared)
│   │   └── cli-types.ts             # CLI type definitions
│   │
│   ├── commands/                    # /team command
│   │   └── team-command.ts          # 7 subcommands
│   │
│   ├── setup/                       # Agent provisioning
│   │   ├── agent-provisioner.ts     # Agent deployment + injection
│   │   └── runtime-compat.ts        # Host runtime compatibility
│   │
│   └── helpers/                     # Shared helpers
│       ├── learning-helpers.ts      # Learning collect/consolidate/clear
│       ├── notification-helpers.ts  # notifyRequester, wakeActiveNativeAssignee
│       ├── result-helpers.ts        # textResult, errorResult, safeSaveAll
│       └── task-helpers.ts          # autoTransitionPendingToWorking, countByStatus
│
├── tests/                           # Vitest 測試
│   ├── *.test.ts                    # 單元/整合測試
│   └── e2e/                         # End-to-end 測試
│       ├── helpers/
│       └── scenarios/
│
└── dist/                            # 編譯輸出
    ├── src/                         # 主程式碼
    └── cli/                         # MCP bridge (獨立編譯)
```
