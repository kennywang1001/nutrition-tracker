# 運動紀錄

**狀態：** 已實作（2026-10-14，`feat/exercise`；實作跟這份規格不一樣的地方記在計畫的「執行中發現的差異」，摘要在計畫的「與規格的差異」）。
實作後審查改了五處，見 §12「審查後的修正」；內文裡跟著改的地方標了「審查後」
**日期：** 2026-10-14
**分支：** `feat/exercise`
**前置：** 身體資料與目標（`2026-10-14-body-targets-design.md`：`weight_entries`、`app/body_data.py`、隱私掃描）、
帳號與目標設定（`2026-10-08-account-settings-design.md`：`PATCH /api/me`、每日目標卡片）、
修改與刪除餐點、改吃的時間（`2026-10-04-edit-meals-design.md`、`2026-10-07-edit-meal-time-design.md`：編輯畫面、裝置時區的日期與時間欄位）、
電腦版版面（`2026-10-08-desktop-layout-design.md`：內容寬度、飲食頁的 grid）
**計畫：** `docs/superpowers/plans/2026-10-14-exercise.md`

> 這是從第一原理自己設計的功能。熱量用公開的 MET 公式（kcal = MET × 體重 kg × 小時），MET 值取自公開的
> *Compendium of Physical Activities*（Ainsworth BE 等，2011 年版與 2024 年成人版）。
> 沒有參考任何商業 app 的程式碼、提示詞或 API。

---

## 1. 範圍

### 1.1 為什麼要做

每日目標是固定的熱量；今天跑了 30 分鐘，畫面上的分母卻跟躺一整天一樣。使用者會自己心算「多吃一點沒關係」，
或乾脆不記。這一份讓使用者記下運動，後端用 MET 公式估算消耗，今天的熱量額度（選擇性地）加回運動消耗。

### 1.2 做的事

- **運動紀錄**：活動（固定清單或「其他」）、分鐘、時間、熱量（估算或手動）、備註。可改可刪。
- **估算**：後端用 MET × 那一天（或之前）最新的體重 × 小時；沒有體重時要手動輸入熱量。表單在存之前先預覽估算。
- **熱量額度**：`/api/stats/daily` 多 `exercise_kcal`、`kcal_budget`、`exercise_adds_to_budget`。總覽「今天熱量」與
  飲食頁的熱量列用額度當分母，旁邊一行「含運動 +343」。
- **設定**：「運動消耗加回今天的熱量額度」（預設開），在「我的」的每日目標卡片。
- **畫面**：「＋ 新增」多「記運動」；`/exercises/new`、`/exercises/:id/edit`；總覽時間線有運動列；飲食頁「今日運動」卡片。
- **匯出**：`exercises.csv`。

### 1.3 明確不做

- 心率、距離、配速、組數與重量；裝置或其他 app 的匯入（Apple 健康、Google Fit）。
- 依速度、坡度、強度細分 MET（只有重量訓練分兩級）；使用者自訂 MET。
- 三大營養素的目標跟著運動調整（D12）。
- 趨勢與報表的熱量比例用額度（D13）。
- 運動給好友看、進動態或任何社群回應（§8）。
- 每週運動目標、連續天數、提醒。

---

## 2. 決定

| # | 決定 | 選項 | 理由 |
|---|---|---|---|
| D1 | 表 | 新表 `exercise_entries`：`id` identity、`user_id` FK cascade、`performed_at timestamptz`、`activity varchar(32)`、`name text`、`minutes integer`、`kcal numeric(7,2)`、`kcal_source varchar(16)`、`note text`、`created_at`、`updated_at`；索引 `(user_id, performed_at)` | 跟 `meals` 同一種「時間點＋使用者時區決定哪一天」；一天可以有很多筆，所以要 id |
| D2 | 活動清單 | **一個後端模組** `app/exercise.py` 的 `ACTIVITIES`（代碼、中文標籤、MET）；`GET /api/exercise/activities` 回給前端，前端不抄一份 | 一個事實來源；改 MET 不用動前端 |
| D3 | 活動代碼的約束 | `activity` 是 `varchar` ＋**手寫 CHECK 列出所有代碼**（不用 `Enum`） | handover §7：`create_constraint=True` 讓 `alembic check` 永久漂移。代價：新增活動要一個 migration（§10 第 5 點） |
| D4 | 「其他」 | `activity = 'other'` ⇔ `name IS NOT NULL`（CHECK）；`other` 一定是 `kcal_source = 'manual'`（CHECK）。其他活動送了 `name` 一律存 null | 沒有 MET 就沒有估算；名稱只在「其他」有意義，存了也沒地方顯示 |
| D5 | 範圍 | `minutes` 整數 1–600；`kcal` 1–5000（兩位小數）；`name` 清成一行（`single_line`）後 1–50 字；`note` ≤ 200 字（可 null） | 10 小時、5000 kcal 已經是超馬等級；CHECK 與 Pydantic 都擋 |
| D6 | 估算公式 | `kcal = MET × kg × minutes / 60`，**全程 `Decimal`，四捨五入到整數**（`ROUND_HALF_UP`），存成 `numeric(7,2)` | MET 本身只有兩三位有效數字，小數點後沒有意義；整數也讓畫面與手算一致 |
| D7 | 用哪一筆體重 | **運動那一天（使用者時區）或之前**日期最新的那一筆（`weight_as_of(db, user_id, day)`，`app/body_data.py`） | 補記上個月的運動，不該用今天的體重 |
| D8 | 沒有體重 | **不給預設體重**；省略 `kcal` 時 `422 EXERCISE_NEEDS_WEIGHT`。估算端點回 `{ready: false}`，表單顯示「先記一次體重，就能自動估算」並要求手動輸入 | 預設 70 kg 對 50 kg 與 100 kg 的人都差 40% 以上，而且使用者看不出來是猜的 |
| D9 | 估算超過 5000 | `422 EXERCISE_ESTIMATE_TOO_HIGH`（估算端點同一個錯誤），請使用者手動輸入或拆成兩筆 | 不悄悄夾到 5000：存下去的數字要是算出來的或使用者打的 |
| D10 | 手動熱量 | 請求帶 `kcal` → `kcal_source = manual`；省略（POST）或 `null`（PATCH）→ 後端估算、`estimated` | 「null＝讓後端算」讓編輯畫面可以從手動切回估算 |
| D11 | 預覽 | **後端端點** `GET /api/exercise/estimate?activity=&minutes=&performed_at=`，回 `{ready: true, kcal, met, weight_kg, weight_date}` 或 `{ready: false, missing: "weight"}`（兩個模型的普通聯集，不加 discriminator，同身體資料 D10） | 公式只有一份；前端不用知道 MET 與體重怎麼挑 |
| D12 | 三大營養素 | **不動**。只有熱量的額度變大 | 運動多吃的部分該是哪一種營養素沒有共識；多數 app 也只加熱量。簡單、好解釋 |
| D13 | 趨勢與 `/stats/range` | **不變**：比例照舊用目標 | 趨勢是「長期吃得怎麼樣」；用額度的話運動多的那天看起來吃得「剛好」，反而看不出問題。也省掉 range 再撈一次運動 |
| D14 | 設定存哪 | **`users.exercise_adds_to_budget boolean NOT NULL DEFAULT true`**，經 `PATCH /api/me` 改、`GET /api/me` 讀 | `/stats/daily` 本來就有 `user`，零次多的查詢；`PATCH /api/me` 本來就是部分更新。放 `user_profiles` 的話：那一列可能不存在（要 upsert）、`PUT /api/me/body-profile` 是七個鍵整組取代（多一鍵會改掉既有契約） |
| D15 | 額度 | `kcal_budget = target.kcal + exercise_kcal`（設定開）／`target.kcal`（設定關）／`null`（那天沒有目標或熱量沒設） | 「沒有目標」不能變成「額度＝運動消耗」 |
| D16 | `ratio.kcal` | **不變**（仍是 實際 / 目標） | `ratio` 是給趨勢同一套語意的；畫面本來就用 `ratioOf(actual, 分母)` 自己算。改它會讓 `/stats/daily` 與 `/stats/range` 對同一天回不同的比例 |
| D17 | 設定只看現在 | 查過去某一天的 `stats/daily` 也用**現在的**設定 | 設定不是有效期間制；為了它多一張表不值得（§10 第 3 點） |
| D18 | 時間不能是未來 | 前端同餐點（`不能選未來的時間`）；**後端也擋**：`performed_at > now() + 5 分鐘` → `422 EXERCISE_IN_FUTURE` | 餐點只有前端擋（見「與原始決定的差異」第 1 點）；5 分鐘給裝置時鐘誤差 |
| D19 | 清單 | `GET /api/exercises?date=`（省略＝使用者的今天）回 `{date, total_kcal, entries}`，依 `performed_at` 由舊到新 | 飲食頁的卡片要合計；`date` 讓前端不用自己算今天 |
| D20 | 回應帶標籤 | `ExerciseResponse.label`：固定活動是中文標籤、「其他」是 `name` | 時間線與卡片不用另外抓活動清單 |
| D21 | 回應在 commit 之前組好 | POST／PATCH：flush → refresh → 組回應 → commit，commit 之後不碰 ORM 物件 | 身體資料審查 M6 的教訓 |
| D22 | 存的時候重估 | PATCH 時 `kcal_source` 是 `estimated`，而且 `activity`／`minutes`／`performed_at` 任何一個**跟存好的值不一樣**（審查後：原本是「這次帶了這個鍵」）→ 重新估算；手動的一筆帶 `kcal: null` → 改回估算。只改備註、重送一樣的值、已經是估算的一筆帶 `kcal: null` 都**不**重估，留著存好的熱量 | 改了時間可能換一筆體重；只改備註不該讓熱量悄悄變（體重後來更正了也一樣，§10 第 8 點） |
| D23 | 離線快取 | `["exercises", …]` 進離線快取（自己的資料）；`["exercise-estimate", …]` **不進**（每打一個數字一組 key，同 `food-search`） | 同身體資料 D19 |
| D24 | 內容寬度 | `/exercises/new` 是 `form`（480）；`/exercises/:id/edit` 是預設 `narrow`（同 `/meals/:id/edit`） | `contentWidthFor` 只比完整路徑 |
| D25 | 設定的位置 | 「我的」→「每日目標」卡片底部的開關（`role="switch"` 的 checkbox） | 它改的就是每日目標的熱量分母；放身體資料頁的話，沒填身體資料的人找不到 |
| D26 | 飲食頁的卡片位置 | DOM 順序 營養素 → 餐點 → 補劑 → **運動**；電腦版在左欄補劑下面 | 既有測試與 e2e（「補劑緊貼營養素」）不受影響 |
| D27 | 負號 | 時間線寫 `-343 kcal`（ASCII 減號） | 同身體資料「與規格的差異」第 1 點：全 app 的正負號一律 ASCII |
| D28 | 匯出 | `GET /api/export/exercises.csv`：`日期,時間,活動,分鐘,熱量(kcal),熱量來源,備註`，時間用使用者時區、由舊到新；共用限速與「同時一個」 | 照抄 `expense_csv` 的 keyset（時間, id） |

### 與原始決定的差異

1. **後端也擋未來的時間**（D18）。原始決定說「照餐點的規矩」——但餐點的規矩**只在前端**（`EditMeal.tsx` 的
   「不能選未來的時間」），後端收任何時刻。運動的時間會決定用哪一筆體重估算，後端擋比較穩；留 5 分鐘給時鐘誤差。前端照餐點的寫法擋。
2. **估算端點收 `performed_at`（時刻），不是 `date`**（D11）。「哪一天」要用帳號時區算，前端不算日界線（`lib/dates.ts` 的規矩）；
   給時刻讓後端用跟存檔同一條路算出那一天。省略＝現在。
3. **設定放在 `users`，不是 `user_profiles`**（D14）。理由見 D14。
4. **`/stats/daily` 多三個欄位，不是兩個**：多一個 `exercise_adds_to_budget`（設定的值），總覽與飲食頁才知道要不要寫
   「含運動 +N」，不用另外抓 `/api/me`、也不用比兩個 Decimal 字串。
5. **估算超過 5000 是 422，不是夾住**（D9）；原始決定沒提。
6. **e2e 的順序**：原始流程是「編輯 → 刪除 → 關設定 → 額度回到目標」；刪掉之後運動是 0，關不關設定額度都等於目標，那一步沒有鑑別力。
   改成「編輯 → 關設定（運動還在，額度回到目標、沒有『含運動』）→ 刪除」。
7. **活動清單多一項**：重量訓練分「一般」「高強度」兩個代碼，共 18 個活動＋「其他」。

---

## 3. 活動與 MET

`app/exercise.py` 的 `ACTIVITIES`（順序就是選單的順序）。MET 取自 *Compendium of Physical Activities*
（Ainsworth BE, Haskell WL, Herrmann SD, et al. *Med Sci Sports Exerc* 2011;43(8):1575–1581；2024 年成人版
Herrmann SD 等，*J Sport Health Sci* 2024）的對應條目。寫規格時沒有連網核對，數字是常見引用值，**都是近似**：
Compendium 本身就是族群平均，同一個活動依速度、強度差一倍不稀奇。

| 代碼 | 標籤 | MET | Compendium 對應（近似） |
|---|---|---|---|
| `walking` | 走路 | 3.5 | walking, 2.8–3.2 mph, level, moderate pace |
| `brisk_walking` | 快走 | 4.3 | walking, 3.5 mph, level, brisk |
| `jogging` | 慢跑 | 7.0 | jogging, general |
| `running` | 跑步（約 10 km/h） | 9.8 | running, 6 mph (10 min/mile) |
| `cycling` | 騎腳踏車 | 7.5 | bicycling, general |
| `spinning` | 飛輪 | 8.5 | bicycling, stationary, RPM/spin bike class |
| `swimming` | 游泳 | 6.0 | swimming, leisurely, not lap swimming, general |
| `weight_training` | 重量訓練（一般） | 3.5 | resistance training, multiple exercises, light or moderate effort |
| `weight_training_vigorous` | 重量訓練（高強度） | 6.0 | weight lifting, powerlifting or bodybuilding, vigorous effort |
| `yoga` | 瑜伽 | 2.5 | yoga, Hatha |
| `pilates` | 皮拉提斯 | 3.0 | pilates, general |
| `hiit` | HIIT | 8.0 | circuit training, vigorous, with minimal rest |
| `hiking` | 爬山 | 6.0 | hiking, cross country |
| `stair_climbing` | 爬樓梯 | 8.8 | stair climbing, fast pace |
| `basketball` | 籃球 | 6.5 | basketball, general |
| `badminton` | 羽球 | 5.5 | badminton, social singles and doubles, general |
| `table_tennis` | 桌球 | 4.0 | table tennis, ping pong |
| `jump_rope` | 跳繩 | 11.8 | rope jumping, moderate pace, 100–120 skips/min（2011 代碼 15552；慢 8.8、快 12.3。原本寫 11.0，Compendium 沒有這個值——實作時改正） |
| `other` | 其他 | — | 只能手動輸入熱量 |

MET 存成 `Decimal("9.8")` 這種字串建構的 Decimal（不經 float）。

---

## 4. 公式

`app/exercise.py`：

```
estimate_kcal(met, weight_kg, minutes) = round_half_up(met × weight_kg × minutes / 60, 整數)
```

### 4.1 算一次（測試的第一組資料）

跑步 30 分鐘，那天之前最新的體重 70 kg：`9.8 × 70 × 30 / 60 = 343` → **343 kcal**（存 `343.00`）。

### 4.2 其他測試資料

| 案例 | 輸入 | 原始值 | 結果 | 重點 |
|---|---|---|---|---|
| B | 走路 3.5、62.4 kg、45 分鐘 | 163.8 | **164** | 進位 |
| C | 瑜伽 2.5、58 kg、61 分鐘 | 147.4166… | **147** | 捨去、除不盡 |
| D | 快走 4.3、50 kg、15 分鐘 | 53.75 | **54** | .75 |
| E | 桌球 4.0、45.5 kg、3 分鐘 | 9.1 | **9** | 很短 |
| F | 走路 3.5、60 kg、1 分鐘 | 3.5 | **4** | 剛好 .5 → HALF_UP（`ROUND_HALF_EVEN` 會是 4，所以另加 G） |
| G | 走路 3.5、66 kg、10 分鐘 | 38.5 | **39** | .5 進位；HALF_EVEN 會給 38 |
| H | 跳繩 11.8、350 kg、80 分鐘 | 5506.66… | **422** `EXERCISE_ESTIMATE_TOO_HIGH` | 超過 5000 |
| I | 跳繩 11.8、300 kg、80 分鐘 | 4720 | **4720** | 5000 以內 |
| J | 重量訓練（高強度）6.0、250 kg、200 分鐘 | 5000 | **5000** | 剛好在上限上：擋的是 `>`，不是 `>=` |

最小可能的估算：瑜伽 2.5 × 25 kg × 1 分鐘 / 60 = 1.04 → 1，不會低於 1 kcal 的下限。

### 4.3 哪一天、哪一筆體重

`day = performed_at` 換成使用者時區的日期（`performed_at.astimezone(ZoneInfo(tz)).date()`，跟 `day_bounds` 同一個時區庫）；
`weight_as_of(db, user_id, day)` = `weight_entries` 裡 `date <= day` 日期最新的一筆。之後才記的體重不算（D7）。

---

## 5. 資料模型與 migration `0020`

### 5.1 `exercise_entries`

| 欄位 | 型別 | 約束 |
|---|---|---|
| `id` | bigint identity | 主鍵 |
| `user_id` | bigint | NOT NULL、FK `users.id` ON DELETE CASCADE |
| `performed_at` | timestamptz | NOT NULL |
| `activity` | varchar(32) | NOT NULL、`activity_valid`：`IN (...19 個代碼...)` |
| `name` | text | `other_has_name`：`(activity = 'other') = (name IS NOT NULL)`；`name_length`：`char_length(name) BETWEEN 1 AND 50` |
| `minutes` | integer | NOT NULL、`minutes_range`：1–600 |
| `kcal` | numeric(7,2) | NOT NULL、`kcal_range`：1–5000 |
| `kcal_source` | varchar(16) | NOT NULL、`kcal_source_valid`：`IN ('estimated','manual')`；`other_is_manual`：`activity <> 'other' OR kcal_source = 'manual'` |
| `note` | text | `note_length`：`char_length(note) <= 200` |
| `created_at`、`updated_at` | timestamptz | `now()`；`updated_at` 有 `onupdate` |

索引 `ix_exercise_entries_user_id_performed_at (user_id, performed_at)`。

### 5.2 `users.exercise_adds_to_budget`

`boolean NOT NULL server_default true`。既有使用者一律是開。

### 5.3 Migration

`0020_create_exercise_entries.py`：一張新表＋一個有預設值的欄位。舊版程式不讀不寫新表；寫 `users` 的 INSERT 不提新欄位、吃預設值——
**可以退版**，不進 `ROLLBACK_UNSAFE_REVISIONS`。`downgrade` 刪欄位、刪表。驗收：`upgrade head` → `alembic check` → `downgrade -1` → `upgrade head` → `check`。

---

## 6. API

八個新端點（95 → 103）。全部要登入、只讀寫自己的；別人的 id 一律 `404 EXERCISE_NOT_FOUND`（body 跟不存在的一樣）。

| 端點 | 做什麼 | 錯誤 |
|---|---|---|
| `GET /api/exercise/activities` | `[{code, label, met}]`，`other` 的 `met` 是 null | |
| `GET /api/exercise/estimate?activity=&minutes=&performed_at=` | `{ready: true, kcal, met, weight_kg, weight_date}` 或 `{ready: false, missing: "weight"}` | `422 EXERCISE_NOT_ESTIMABLE`（`other`）、`EXERCISE_ESTIMATE_TOO_HIGH`、`EXERCISE_IN_FUTURE`；`minutes` 範圍是 Pydantic 的 422 |
| `GET /api/exercises?date=` | `{date, total_kcal, entries: [ExerciseResponse]}`（D19） | |
| `POST /api/exercises` | body `{activity, name?, minutes, performed_at, kcal?, note?}` → 201 `ExerciseResponse` | `EXERCISE_NEEDS_WEIGHT`、`EXERCISE_ESTIMATE_TOO_HIGH`、`EXERCISE_IN_FUTURE`；`other` 沒有 `name` 或沒有 `kcal` 是 Pydantic 的 422 |
| `GET /api/exercises/{id}` | `ExerciseResponse` | 404 |
| `PATCH /api/exercises/{id}` | 部分更新；`activity`／`minutes`／`performed_at` 不收 null；`kcal: null`＝手動的一筆改回估算（已經是估算的不因此重估，D22）；`note: null`＝清掉 | 同 POST，加上合併之後 `other` 沒有名稱或要估算 → `422 EXERCISE_NEEDS_NAME`／`EXERCISE_NEEDS_KCAL` |
| `DELETE /api/exercises/{id}` | 204 | 404 |
| `GET /api/export/exercises.csv` | D28 | 共用匯出的 429／409 |

`ExerciseResponse`：`{id, performed_at, activity, label, name, minutes, kcal, kcal_source, note, created_at, updated_at}`。

`performed_at` 是 `AwareDatetime`（naive 的 422，同餐點）；**早於 1900-01-01（UTC）也是 422 `VALIDATION_ERROR`**（審查後：
`0001-01-01T00:00:00+14:00` 換到使用者時區會溢位、原本是 500）。新增、修改、估算的查詢參數共用 `app/schemas/exercise.py` 的 `PerformedAt`。

**既有端點的改變：**

- `GET /api/stats/daily` 多 `exercise_kcal`（那一天的合計，沒有是 `0.00`）、`exercise_adds_to_budget`（設定）、`kcal_budget`（D15）。
  查詢從 3 次變 4 次（多一次 `SUM`），仍然跟筆數無關。
- `GET`／`PATCH /api/me`（`UserResponse`、`UpdateMeRequest`）多 `exercise_adds_to_budget`；PATCH 不收 null（同既有兩個欄位）。
  `POST /api/auth/register` 回的也是 `UserResponse`，跟著多。

---

## 7. 前端

### 7.1 檔案

| 檔案 | 內容 |
|---|---|
| `api/exercises.ts`（新） | `useActivities`、`useExerciseEstimate`、`useTodayExercises`、`useExercise`、`createExercise`、`updateExercise`、`deleteExercise`、`invalidateExercises` |
| `api/queries.ts` | `exercisesAll: ["exercises"]`、`exercisesToday: ["exercises","today"]`、`exercise(id): ["exercises", id]`、`exerciseActivities: ["exercise-activities"]`（獨立命名空間：記一筆運動不該連帶重抓固定的清單）、`exerciseEstimate(...)`: `["exercise-estimate", activity, minutes, performedAt]` |
| `api/persist.ts` | `NOT_PERSISTED` 加 `"exercise-estimate"`、`"exercise-activities"`（審查後：活動清單是 `staleTime: Infinity`，存進離線快取就永遠換不掉） |
| `api/stats.ts` | `kcalBudgetOf(stats)`、`exerciseKcalOf(stats)`、`exerciseInBudgetOf(stats)`：離線快取的舊回應沒有新欄位（`undefined`）時退回目標／`"0"`／`false` |
| `lib/timeline.ts` | 第三種列 `kind: "exercise"` |
| `lib/layout.ts` | `/exercises/new` 是 `form` |
| `components/ExerciseForm.tsx`（新） | 新增與編輯共用的表單 |
| `screens/LogExercise.tsx`、`screens/EditExercise.tsx`（新） | `/exercises/new`、`/exercises/:id/edit` |
| `components/TodayExercises.tsx`（新） | 飲食頁「今日運動」卡片 |
| `components/ExerciseBudgetSwitch.tsx`（新） | 每日目標卡片裡的開關 |
| `AddSheet.tsx`、`Overview.tsx`、`Today.tsx`、`MacroBar.tsx`、`TargetsCard.tsx`、`App.tsx`、`api/export.ts` | |

### 7.2 表單（`ExerciseForm`）

- **活動**：`<select>`（選項來自 `/api/exercise/activities`，標籤＋MET 不顯示）。選「其他」多一格「名稱」（必填、≤ 50）。
- **分鐘**：`inputMode="numeric"`，1–600 的整數（`checkRangeInput`，`places: 0`）。
- **熱量**：
  - 不是「其他」、沒勾「手動輸入熱量」：顯示預覽。活動與分鐘有效時，分鐘停 400 ms（`useDebounced`）再打估算端點：
    「約 343 kcal（依 10/14 的體重 70 公斤）」；`ready: false` → 「先記一次體重，就能自動估算」＋連結「記錄體重」（到 `/weight`），
    並把「手動輸入熱量」打開、鎖住（沒有體重不能估算）。
  - 「手動輸入熱量」勾起來（「其他」一定是）：熱量欄（1–5000、兩位小數）。
- **時間**：日期＋時間兩格，裝置時區，新增時預設「現在」（`localDateTime(new Date().toISOString())`），`max` 是今天；
  送出前 `fromLocalDateTime`，未來的 → 「不能選未來的時間」（同 `EditMeal`）。
- **備註**：選填 ≤ 200。
- 錯誤列在 `role="alert"`；送出中「儲存」是 `aria-disabled`＋ref 擋重複送出。
- 存好：失效 `["exercises"]`、`dailyStats`，導回總覽（`/`）。新增時伺服器回 `EXERCISE_NEEDS_WEIGHT`（另一個分頁剛刪了體重）→ 打開手動欄、顯示同一句提示，
  清掉手上的預覽重問；之後的預覽回 `ready: true`（記了體重）就解鎖（審查後）。

### 7.3 編輯（`/exercises/:id/edit`）

路徑參數照 `lib/resource-id.ts`。預填掛載時抓回來的那一筆（`useExercise`，`refetchOnMount: "always"`，同編輯餐點）。
「手動輸入熱量」反映 `kcal_source`。儲存**只送改了的欄位**（審查後，原本是完整的一組加 `kcal: null`）：跟預填的那一筆比
（`lib/exercise.ts` 的 `exercisePatch`；時間比到分鐘）；熱量只在估算→手動、手動的數字改了（送數字）或手動→估算（送 `null`）時帶，
估算的一筆改了活動、分鐘或時間不帶 `kcal`、由後端重估；什麼都沒改就不送、直接回總覽。估算的一筆活動、分鐘、時間都沒動時，
熱量那一行是「目前 343 kcal（估算）」、不問預覽，**沒有體重也不強制手動**（只改備註存得了）；動了才回到預覽與「先記一次體重」。「刪除這筆運動」→ 畫面上的確認框
（`role="alertdialog"`，同體重清單），確定後 `removeQueries(exercise(id))`、失效、導回總覽。

### 7.4 總覽

- **今天熱量**：分母是 `kcalBudgetOf(stats)`；`exerciseInBudgetOf(stats)` 而且 `exercise_kcal` 不是 0 時，數字下面一行小字
  「含運動 +343」（`formatMacro`）。進度條的比例是 `ratioOf(actual, 額度)`。
- **時間線**：`buildTimeline(meals, expenses, exercises)`，運動列是連結到編輯畫面：圖示（lucide `Dumbbell`）、「跑步・30 分鐘」、時間、「-343 kcal」。
  運動清單載入失敗跟餐點一樣算「無法載入今天的紀錄」。

### 7.5 飲食頁

- 熱量的 `MacroBar` 用額度當 `target`，多一個 `note` 屬性顯示「含運動 +343」。其他三列不變。
- 「今日運動」卡片：每筆一列（連到編輯）、合計「共 -686 kcal」、連結「記運動」（`/exercises/new`）；沒有：「今天還沒有運動」。

### 7.6 設定

「每日目標」卡片底部：`<input type="checkbox" role="switch">` 「運動消耗加回今天的熱量額度」，值來自 `useMe()`（舊快取沒有 → `true`）。
切換 → `PATCH /api/me` → 寫回 `["me"]`、失效 `dailyStats`。送出中 `aria-disabled`；失敗 `role="alert"`「沒有存到，請再試一次」並回到原值。

### 7.7 匯出

`EXPORT_KINDS` 多「運動」（五顆）。

---

## 8. 隱私

- 運動不進任何好友或社群的回應：`FriendMeal`、社群的序列化都是白名單，不碰。
- 新的掃描 `tests/test_exercise_privacy.py`（形狀同 `test_body_privacy.py`）：
  1. 好友與社群 schema 可達的每個模型，欄位名不含 `exercise`、`minutes`、`kcal_source`、`budget`。
  2. `ExerciseEntry`、`exercise_entries` 只出現在運動的模組（`models/exercise.py`、`models/__init__.py`、`app/exercise.py`、
     `schemas/exercise.py`、`routes/exercises.py`、`export.py`、`app/exercise_data.py`）。
  3. 運動的模組不寫 log。
  4. 好友與社群的模組不提運動的模組（`app.exercise`、`models.exercise`、`schemas.exercise`、`routes.exercises`、`exercise_data`）或它們定義的函式與類別。
- 端點：跨使用者測試（A 看得到自己的一筆 → B 的 GET／PATCH／DELETE 是 404、A 的那筆還在）。
- 好友看某一天（`FriendDay`）的熱量是 `actual`，不碰額度。

---

## 9. 測試

### 9.1 後端

- `tests/test_exercise_formula.py`：§4.2 的 A–J、MET 表的每一項是 `Decimal`、代碼唯一、`other` 沒有 MET、HALF_UP。
- `tests/test_exercise_model.py`：每個 CHECK（斷言約束名）、cascade、`users.exercise_adds_to_budget` 預設 true。
- `tests/test_exercise_estimate.py`：活動清單；估算的兩種形狀；**體重用運動那一天或之前**（之後的不算；時區邊界：台北的 10/14 00:30 是 UTC 10/13）；
  `other`、太高、未來。
- `tests/test_exercises.py`：POST 估算／手動／`other`、沒體重 422、未來 422（5 分鐘邊界）、範圍邊界（0、1、600、601；1、5000、5000.01；名稱 50／51）、
  名稱清成一行、非 `other` 的名稱存 null；GET 清單（日期邊界、由舊到新、合計、預設今天＋記下時區）；PATCH 的每一條規則（D22）；DELETE；跨使用者；
  commit 之後不送 SQL（D21）。
- `tests/test_stats_daily.py`：`exercise_kcal`、`kcal_budget` 的三種情況、設定關、運動在隔天不算、查詢數 4。
- `tests/test_auth_me.py`（或既有的 `PATCH /api/me` 測試檔）：新欄位讀寫、null 422。
- `tests/test_export.py`：`exercises.csv`。
- `tests/test_exercise_privacy.py`：§8。

### 9.2 前端

`timeline.test.ts`（三種列、排序）、`exercise-api.test.tsx`、`exercise-form.test.tsx`（預覽、沒體重、其他、手動、未來、送出的 body）、
`edit-exercise.test.tsx`（預填、改回估算、刪除確認）、`overview.test.tsx`／`today.test.tsx`（額度、「含運動」、舊快取沒有欄位）、
`add-sheet`（三個入口）、`targets-card`／`me.test.tsx`（開關）、`layout.test.ts`、`export-card.test.tsx`（五顆）。

### 9.3 e2e（`e2e/exercise.spec.ts`，新帳號、手機尺寸）

設目標 2000 → 「＋」→「記運動」→ 選跑步 30 分鐘 → 看到「先記一次體重」、熱量欄必填 → 「記錄體重」70 → 回到記運動 → 預覽「約 343 kcal」
（測試裡用 9.8 × 70 × 30 / 60 算）→ 存 → 總覽「/ 2343 kcal」「含運動 +343」、時間線「跑步・30 分鐘」→ 點它改成 60 分鐘 → 「含運動 +686」
→ 「我的」關掉開關 → 總覽「/ 2000 kcal」、沒有「含運動」→ 刪掉那筆運動 → 時間線沒有它。量表單的觸控高度與輸入框字級。

---

## 10. 已知限制

1. MET 是族群平均的近似（§3）：實際消耗依體能、強度、體重組成可以差 ±30%。
2. 只看體重，不看性別、年齡（MET 的定義就是這樣）。
3. 設定只看現在（D17）：關掉之後，過去每一天的額度也一起變回目標。
4. 存的時候才估算：表單上看到的預覽，跟按下儲存那一刻算的可能不同（另一個分頁剛改了體重）；存好的回應是準的。
5. 新增活動要一個 migration（D3 的 CHECK）。
6. 運動紀錄沒有實際的「多久以前」的下限（體重有兩年）：`performed_at` 擋未來，往前只擋 1900-01-01（UTC）以前（審查後，衛生下限）。
7. 趨勢、報表、好友看到的熱量都不含運動（D13）。
8. **估算的一筆存好之後不跟著體重變**（審查後寫明）：之後更正了那一天的體重，熱量仍是當初算的；只有活動、分鐘或時間改了、
   或手動的一筆改回估算時才用當時的體重重算。編輯畫面上勾「手動輸入熱量」再取消、或把分鐘改一下再改回來都不算（值沒變、不送）；
   要用新體重算得先存成手動、再打開改回估算——或直接手動輸入。

---

## 11. 交付

- 後端：`app/models/exercise.py`、`migrations/versions/0020_create_exercise_entries.py`、`app/exercise.py`、`app/exercise_data.py`、
  `app/body_data.py`（`weight_as_of`）、`app/schemas/exercise.py`、`app/api/routes/exercises.py`、`app/main.py`、`routes/stats.py`、
  `schemas/stats.py`、`models/user.py`、`schemas/auth.py`、`schemas/user.py`、`app/export.py`／`routes/export.py`；測試見 §9.1。
- 前端：§7.1；`schema.d.ts` 每個後端 task 重新產生。
- e2e：`e2e/exercise.spec.ts`。
- 文件：`docs/handover.md`（§2 數字、功能章節、已知限制）、`docs/deployment.md`（`0020`）、這份規格的狀態。

---

## 12. 審查後的修正

實作完成後的審查（2026-10-15）找到的問題與修法。每一條都先寫會紅的測試、修好、再把修法拿掉確認測試會紅（mutation check）。

- **I1　編輯畫面每存一次估算的運動就重估一次，只改備註也一樣。** 編輯畫面送完整的一組加 `kcal: null`，後端看「帶了這個鍵」就重估：
  那一天的體重從 70 更正成 72 之後只改個錯字，熱量就從 343 悄悄變 353；體重全刪了的話，打開估算的一筆會被強制改成手動、熱量欄是空的，
  連備註都存不了。兩層一起修：
  - 後端（D22）：活動、分鐘、時間**跟存好的值比**，真的變了才重估；`kcal: null` 只對手動的一筆表示「改回估算」。
    測試：重送一樣的值（時間換一種時差寫法）不重估；估算的一筆帶 `kcal: null`、其他沒變不重估（沒有體重也是 200）。
  - 前端（§7.3）：`EditExercise` 只送改了的欄位（`exercisePatch`），什麼都沒改不送；`ExerciseForm` 的 `stored`：估算的一筆活動、
    分鐘、時間沒動時顯示「目前 N kcal（估算）」、不問預覽、沒有體重也不強制手動。e2e：更正體重之後只改備註，熱量不變。
- **M1　太早的 `performed_at` 是 500。** `0001-01-01T00:00:00+14:00` 在 `local_day` 換時區時 `OverflowError`（估算、新增、修改都是）。
  `PerformedAt`（`AwareDatetime`＋早於 1900-01-01 UTC 的 422）用在兩個請求 schema 與估算的查詢參數（§6）。
- **M2　伺服器回 `EXERCISE_NEEDS_WEIGHT` 之後表單永遠是手動。** 那個旗標從來不清：在別的分頁記了體重回來也一樣鎖著。收到 422 時清掉手上的
  預覽（那是刪體重之前問的、還說有體重）重問，之後的預覽回 `ready: true` 就解鎖（§7.2）。
- **M3　活動清單永遠是第一次抓的那一份。** `staleTime: Infinity` 又進離線快取，沒有任何東西會換掉它；之後的 migration 新增或改名活動代碼，
  用過的裝置看不到。`"exercise-activities"` 加進 `NOT_PERSISTED`（§7.1；一次載入裡仍然只抓一次）。離線打開表單時清單是 paused、
  等不到：說「無法載入活動清單」，不是一直「載入中…」（離線本來就存不了）。
- **M4　e2e 跨午夜可能紅（只改文件）。** `exercise.spec.ts` 記「今天」的體重與運動、比對預覽上的日期；跑到一半跨過午夜（台北）會對不上，
  同其他記今天資料的 spec。寫進 handover 的已知限制。
