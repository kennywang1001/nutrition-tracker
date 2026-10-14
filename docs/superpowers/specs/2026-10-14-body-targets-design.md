# 身體資料與目標（含體重紀錄）

**狀態：** 規格（2026-10-14，`feat/body-targets`；尚未實作）
**日期：** 2026-10-14
**分支：** `feat/body-targets`
**前置：** 帳號與目標設定（`2026-10-08-account-settings-design.md`：目標是有效期間、`PUT /api/targets/today` 從使用者的今天起存）、
電腦版版面（`2026-10-08-desktop-layout-design.md`：內容寬度依路由）、趨勢（`TrendChart` 的 SVG 慣例）、
好友與社群（`2026-10-07-friends-design.md`、`2026-10-10-social-interactions-design.md`：好友看得到什麼）
**計畫：** `docs/superpowers/plans/2026-10-14-body-targets.md`

> 這是從公開的營養學公式自己設計的功能（Mifflin-St Jeor、活動係數、每公斤 7700 大卡的經驗值）。
> 沒有參考任何商業 app 的程式碼、提示詞或 API。

---

## 1. 範圍

### 1.1 為什麼要做

每日目標現在只能手打四個數字。多數人不知道自己該吃多少；知道的人也是拿別的計算機算好再抄過來。
體重沒有地方記，所以「目標跟著體重調整」也無從做起。這一份補上三件事：身體資料、體重紀錄、
用公式算出建議目標並一鍵套用。

### 1.2 這份規格做的事

- **身體資料**（每人一份）：性別、出生年、身高、活動量、目標（減重／維持／增重）、速度（每週 0.25 或 0.5 公斤）、
  目標體重（選填）。「我的」多一張「身體資料」卡片，`/me/body` 是表單。
- **體重紀錄**：一天一筆（使用者時區的日期），可補記過去兩年內的日子、可改可刪。「我的」多一張「體重」卡片
  （最新體重、跟 7 天前比、行內記錄），`/weight` 是圖表（30 天／90 天／全部，每筆一點、7 天移動平均線、目標體重線）與清單。
- **建議目標**：後端用純函式算 BMR → TDEE → 依目標加減 → 下限 → 三大營養素。`/me/targets` 多一個「建議目標」區塊
  （數字、簡短的算法說明、免責聲明、「套用建議目標」）；缺資料時說缺什麼、連到哪裡補。
- **套用**：後端端點在一個交易裡重算、存成今天起的目標、記下套用時的體重。之後最新體重跟那個體重差 ≥ 1 公斤，
  「每日目標」卡片上出現「體重變了 X 公斤，要重算建議目標嗎？」。
- **匯出**：多一個 `weights.csv`（「匯出資料」多一顆「體重」）。

### 1.3 明確不做

- 自動套用建議、排程重算、推播提醒記體重。
- 體脂率、腰圍、其他身體數據；BMI 的顯示與分級。
- 出生月日（年齡只看出生年，§3.3）；性別以外的 BMR 公式（Katch-McArdle 等）。
- 體重給好友看、出現在動態或任何社群回應裡（§7）。
- 總覽的體重列（決定 D25）。
- 從體重紀錄回推實際的 TDEE（自適應估算）。
- 匯入其他裝置或 app 的體重。

---

## 2. 決定

| # | 決定 | 選項 | 理由 |
|---|---|---|---|
| D1 | 身體資料存哪 | **新的 1:1 表 `user_profiles`**（主鍵就是 `user_id`，FK cascade） | `users` 是認證與身分的表，每一條登入路徑都讀它；健康資料分開放，掃描測試也好寫（§7） |
| D2 | 列舉欄位 | `sex`：`male`／`female`；`activity_level`：`sedentary`／`light`／`moderate`／`active`／`very_active`；`goal`：`lose`／`maintain`／`gain`。`Enum(native_enum=False, create_constraint=False)`＋**手寫** `CheckConstraint` | handover §7：`create_constraint=True` 讓 `alembic check` 永久漂移；只寫 False 不寫約束＝沒有約束 |
| D3 | 速度 | `rate_kg_per_week numeric(3,2)`，只能是 0.25 或 0.50，可為 null；**目標是減重或增重時才必填** | 維持不需要速度；存了也不用 |
| D4 | 範圍 | 身高 100–250 cm（一位小數）；體重與目標體重 25–350 kg（兩位小數）；出生年在「使用者的今年 − 100」到「今年 − 13」 | 出生年的範圍跟「今天」有關，資料庫 CHECK 不能用非 immutable 的函式——CHECK 只擋 1900–2100 的衛生範圍，真正的範圍在端點用 `today_in_timezone` 擋 |
| D5 | 身體資料的寫法 | `PUT /api/me/body-profile`：**七個鍵都必填、值可以 null**（整組取代），`INSERT … ON CONFLICT (user_id) DO UPDATE` | 跟 `PUT /api/targets/today` 同一種語意；表單送整組。upsert 讓兩台裝置同時第一次存不會 500 |
| D6 | 公式 | 純函式 `app/body_targets.py`，全程 `Decimal`、`ROUND_HALF_UP`（§3） | 可以用手算的數字逐一測；跟 `app/nutrition.py` 同一種「計算關在一個模組」 |
| D7 | 年齡 | `使用者今天的年份 − 出生年` | 只存出生年（決定給的）；誤差最多一歲 ≈ 5 kcal，遠小於活動係數的誤差 |
| D8 | 下限與四捨五入的順序 | 先算原始熱量；**原始值低於下限 → 用下限、`floor_applied: true`**；否則四捨五入到 10 | 下限本身是 10 的倍數；「有沒有套用下限」看的是原始值，不是四捨五入後的值（1497 → 1500 也算套用了下限） |
| D9 | 碳水 < 0 | 夾在 0；**套用時 0 存成 null（未設定）** | `PUT /api/targets/today` 不收 0（帳號設定規格：0 的目標算不出比例，畫面上跟未設定分不出來）；套用走同一條規矩 |
| D10 | 建議的回應形狀 | `{ready: true, …}` 與 `{ready: false, missing: [...]}` 兩個 Pydantic 模型的**普通聯集，不加 discriminator** | 實測（§10）：加了 `Field(discriminator="ready")`，OpenAPI 的 mapping 鍵是字串 `"True"`／`"False"`，openapi-typescript 產生 `ready: "True"`——型別是錯的；不加的話是 `ready: true`／`ready: false`，前端可以直接收窄 |
| D11 | 缺什麼 | `missing` 依固定順序：`sex`、`birth_year`、`height_cm`、`activity_level`、`goal`、`rate_kg_per_week`（只有減重／增重缺它時）、`weight` | 前端照順序列出、決定連到 `/me/body` 還是「記錄體重」 |
| D12 | 體重表 | `weight_entries`：**主鍵 `(user_id, date)`**、`weight_kg numeric(5,2)`、`created_at`、`updated_at` | 一人一天一筆就是主鍵；不需要另一個 id 跟唯一索引。前端用日期當 key |
| D13 | 記一筆 | `PUT /api/weights/{date}`：`INSERT … ON CONFLICT (user_id, date) DO UPDATE … RETURNING`。日期 **≤ 使用者的今天**、**≥ 今天 − 730 天**（後端判斷） | 冪等；同一天記兩次是更正。日期界線跟其他地方一樣只有後端算 |
| D14 | 讀清單 | `GET /api/weights?from=&to=`：**兩個都可省略**（`to` 預設今天、`from` 預設 `to − 799`），最多 800 天；回 `{today, entries}`，由舊到新 | 前端不用先問今天是哪天（瀑布）；`today` 順便給表單當預設日期、給圖表當右端 |
| D15 | 套用 | **後端端點 `POST /api/me/target-suggestion/apply`**：同一個交易裡重算建議、存成今天起的目標（跟 `PUT /api/targets/today` 共用寫入函式）、記下 `targets_applied_weight_kg`。請求帶**畫面上看到的四個數字**，跟重算的不一樣 → `409 SUGGESTION_CHANGED`，什麼都不寫 | 一個事實來源，存的數字不來自前端；但使用者按下去的那一刻，看到的必須就是會存的（另一個分頁剛記了體重、離線快取裡的舊建議） |
| D16 | 手動改目標之後 | `PUT /api/targets/today` 在同一個交易裡把 `targets_applied_weight_kg` 清成 null | 「體重變了，要重算嗎」只對「目前的目標來自建議」有意義；自己手打的目標不該被提醒蓋掉 |
| D17 | 重算提示的資料 | 建議的回應多三個欄位：`applied_weight_kg`、`weight_change_kg`（最新 − 套用時，沒套用過是 null）、`resuggest`（`|變化| ≥ 1`） | 判斷在後端，前端只顯示；數字差用 Decimal 算 |
| D18 | 體重匯出 | **做**：`GET /api/export/weights.csv`（日期、體重），共用既有的限速、單一匯出、串流 | `app/export.py` 的形狀照抄一支 generator；前端 `EXPORT_KINDS` 多一項 |
| D19 | 隱私 | 不進任何好友或社群的回應；不寫 log；**進離線快取**（自己的資料，跟今日營養素一樣） | 健康資料只給本人。離線時看得到自己的體重是功能；裝置本身是本人的（§7） |
| D20 | 內容寬度 | `/me/body` 是 `form`（480）；`/weight` 是預設的 `narrow`（640） | 單欄表單跟 `/me/targets` 一樣；圖表要寬一點 |
| D21 | 「我的」的卡片順序 | 通知 → 帳號 → 每日目標 → **身體資料 → 體重** → 好友 → 匯出 → … | 跟目標放在一起；體重是每天會碰的，放在好友前面 |
| D22 | `/weight` 的資料 | 一個 query（最近 800 天）；30／90／全部在前端篩 | 一個人一天最多一筆，800 筆是幾十 KB；切換不用等網路，也不用 `keepPreviousData` |
| D23 | 建議放哪 | `/me/targets` 的手動表單**上面**；「每日目標」卡片只放重算提示（連到 `/me/targets`） | 卡片保持精簡；套用與手動在同一頁 |
| D24 | 套用之後 | 失效 `dailyStats`、`rangeStatsAll`、`["body"]`，導回 `/me`（同手動儲存） | `/me/targets` 的手動表單是掛載時的值，套用之後留在原頁，表單就是舊的 |
| D25 | 總覽 | **不動** | 決定說「除非很簡單」；總覽已經是兩欄的版面，加一列要再處理電腦版 |
| D26 | 免責聲明 | 建議區塊裡一直顯示：「依公式估算，僅供參考，不是醫療建議；懷孕、哺乳、慢性病或未滿 18 歲請諮詢專業人員。」 | 決定給的原文 |
| D27 | `/me/body` 的預填 | 跟 `/me/targets` 一樣：**離線快取還原完才掛、掛載時一定重抓、只用掛載後抓回來的那一份** | PUT 是整組取代——拿快取裡的舊值預填，沒動的欄位會被悄悄改回去（帳號設定審查 M5） |

### 與原始決定的差異

1. **套用的請求帶四個數字**（D15）。原始決定傾向「不從前端送數字」。存的仍然是後端重算的值；四個數字只用來確認
   「使用者看到的就是要存的」，不一樣就 409。少了這一步，另一個分頁剛記的體重會讓按下去存的數字跟畫面上的不同。
2. **手動存目標會清掉套用時的體重**（D16）。原始決定沒提；不清的話，手動改過的目標仍然會被「要重算嗎」提醒覆蓋。
3. **碳水夾到 0 之後，套用存成 null**（D9）。原始決定只說夾在 0；但目標不能是 0（帳號設定規格）。
4. **`GET /api/weights` 的 `from`／`to` 可省略，回應包一層 `{today, entries}`**（D14）。原始決定是兩個參數、回陣列。
5. **`weight_entries` 沒有 `id`，主鍵是 `(user_id, date)`**（D12）。原始決定列的欄位都有，只是唯一約束直接當主鍵。
6. **建議的回應不用 discriminator**（D10）：bool 當 discriminator 會讓產生的 TypeScript 型別錯掉（實測）。
7. **「全部」是最近 800 天**（D14、D22）。可以補記的最早日期是兩年前，所以剛記的都在範圍內；但兩年多以前記的會慢慢超出「全部」（§9 第 3 點）。
8. **趨勢頁的分段切換樣式搬到共用的 `components/Segmented.module.css`**，`/weight` 的期間切換用同一份——原始決定說「參考趨勢頁的期間切換」；
   直接 import 另一個畫面的 CSS 模組會讓兩個畫面互相綁住。純搬家，趨勢頁的畫面不變。

---

## 3. 公式

全部在 `app/body_targets.py` 的 `suggest_targets(inputs) -> Suggestion`，輸入輸出都是 `Decimal`，不碰資料庫。

### 3.1 步驟

| 步驟 | 公式 |
|---|---|
| 年齡 | `today.year − birth_year` |
| BMR | 男：`10·kg + 6.25·cm − 5·age + 5`；女：`10·kg + 6.25·cm − 5·age − 161` |
| TDEE | `BMR × 活動係數`（久坐 1.2、輕度 1.375、中度 1.55、高度 1.725、非常高 1.9） |
| 調整 | `rate × 7700 / 7`（0.25 → 275、0.5 → 550）；減重是負、增重是正、維持是 0 |
| 原始熱量 | `TDEE + 調整` |
| 下限 | 女 1200、男 1500；原始熱量 < 下限 → 熱量＝下限、`floor_applied: true` |
| 熱量 | 否則 `round_half_up(原始 / 10) × 10` |
| 蛋白質 | `round_half_up(g/kg × 目前體重)`，g/kg：減重 1.8、維持 1.6、增重 2.0 |
| 脂肪 | `round_half_up(熱量 × 0.25 / 9)` |
| 碳水 | `max(0, round_half_up((熱量 − 蛋白質·4 − 脂肪·9) / 4))`——用**已經四捨五入的**蛋白質與脂肪，四個數字自洽 |
| 顯示用 | `bmr`、`tdee` 四捨五入到整數；`adjustment_kcal` 是整數（−550、−275、0、275、550） |

目前體重＝`weight_entries` 裡日期最新的那一筆（`based_on_date`）。

### 3.2 算一次（測試的第一組資料）

男、1990 年生、今天 2026-10-14（36 歲）、175 cm、80 kg、中度、減重每週 0.5 kg：

- BMR = 800 + 1093.75 − 180 + 5 = **1718.75**（顯示 1719）
- TDEE = 1718.75 × 1.55 = **2664.0625**（顯示 2664）
- 調整 = −0.5 × 7700 / 7 = **−550**；原始 2114.0625 ≥ 1500，沒有下限
- 熱量 = round(211.40625) × 10 = **2110**
- 蛋白質 = 1.8 × 80 = **144** g；脂肪 = 2110 × 0.25 / 9 = 58.61 → **59** g
- 碳水 = (2110 − 576 − 531) / 4 = 250.75 → **251** g

### 3.3 其他測試資料（腳本算過，見計畫 Task 2）

| 案例 | 輸入 | BMR / TDEE | 熱量 | P / F / C | 重點 |
|---|---|---|---|---|---|
| B 下限 | 女、66 歲、155 cm、50 kg、久坐、減 0.5 | 977.75 / 1173.3 | **1200** | 90 / 33 / 136 | 原始 623.3 → 下限 |
| C 增重 | 男、26 歲、180 cm、70 kg、高度、增 0.25 | 1700 / 2932.5 | **3210** | 140 / 89 / 462 | +275 |
| D 維持 | 女、41 歲、165 cm、60 kg、輕度 | 1265.25 / 1739.71875 | **1740** | 96 / 48 / 231 | 速度不用 |
| E 碳水夾 0 | 女、100 歲、100 cm、150 kg、久坐、減 0.5 | 1464 / 1756.8 | **1210** | 270 / 34 / **0** | (1210−1080−306)/4 < 0 |

---

## 4. 資料模型與 migration `0019`

### 4.1 `user_profiles`

| 欄位 | 型別 | 約束 |
|---|---|---|
| `user_id` | bigint | 主鍵、FK `users.id` ON DELETE CASCADE |
| `sex` | varchar(8) | null 或 `male`／`female` |
| `birth_year` | smallint | null 或 1900–2100（真正的範圍在端點，D4） |
| `height_cm` | numeric(4,1) | null 或 100–250 |
| `activity_level` | varchar(16) | null 或五個值之一 |
| `goal` | varchar(8) | null 或三個值之一 |
| `rate_kg_per_week` | numeric(3,2) | null 或 0.25、0.50 |
| `target_weight_kg` | numeric(5,2) | null 或 25–350 |
| `targets_applied_weight_kg` | numeric(5,2) | null 或 25–350（D15、D16；只有後端寫） |
| `created_at`、`updated_at` | timestamptz | `now()`；`updated_at` 有 `onupdate` |

### 4.2 `weight_entries`

| 欄位 | 型別 | 約束 |
|---|---|---|
| `user_id` | bigint | FK `users.id` ON DELETE CASCADE |
| `date` | date | 主鍵 `(user_id, date)` |
| `weight_kg` | numeric(5,2) | NOT NULL、25–350 |
| `created_at`、`updated_at` | timestamptz | `now()`；upsert 時明確設 `updated_at = now()`（`ON CONFLICT DO UPDATE` 不走 ORM 的 `onupdate`） |

主鍵的索引同時涵蓋「某人某段日期」與「某人最新一筆」（`ORDER BY date DESC LIMIT 1`）。

### 4.3 Migration

`0019_create_body_tables.py`：只有兩張新表，舊版程式不讀不寫——**可以退版**，不進 `ROLLBACK_UNSAFE_REVISIONS`。
`downgrade` 刪兩張表。驗收：`alembic upgrade head` → `alembic check` 沒有漂移 → `downgrade -1` → `upgrade head`。

---

## 5. API

八個新端點（87 → 95）。全部要登入，只讀寫自己的；沒有路徑上的使用者 id。

### 5.1 身體資料

- `GET /api/me/body-profile` → `BodyProfile`（七個欄位，沒有那一列＝全部 null；**不回** `targets_applied_weight_kg`）。
- `PUT /api/me/body-profile`，body 是七個鍵（必填、可 null）→ `BodyProfile`。
  - 422：Pydantic 的範圍與小數位；`BIRTH_YEAR_OUT_OF_RANGE`（D4，訊息寫出允許的年份）。
  - `goal = maintain` 時 `rate_kg_per_week` 照存（可能是 null），公式不用它。

### 5.2 建議

- `GET /api/me/target-suggestion` →
  - `{ready: true, kcal, protein_g, fat_g, carb_g, bmr, tdee, adjustment_kcal, floor_applied, floor_kcal, weight_kg, based_on_date, applied_weight_kg, weight_change_kg, resuggest}`
  - 或 `{ready: false, missing: [...]}`（D11）。
- `POST /api/me/target-suggestion/apply`，body `{kcal, protein_g, fat_g, carb_g}`（畫面上看到的）→ `TargetResponse`。
  - `422 PROFILE_INCOMPLETE`（`details.missing`）；`409 SUGGESTION_CHANGED`（重算的不一樣）；`409 TARGET_CONFLICT`（同 `PUT /api/targets/today`）。
  - 一個交易：重算 → 比對 → 寫目標（`write_target_from_today`，從 `set_target_from_today` 抽出來、不 commit）→
    `targets_applied_weight_kg = weight_kg` → commit。碳水 0 存 null（D9）。

### 5.3 體重

- `PUT /api/weights/{date}`，body `{weight_kg}` → `{date, weight_kg}`（200，新增或更正都一樣）。
  `422 WEIGHT_DATE_IN_FUTURE`、`422 WEIGHT_DATE_TOO_OLD`；範圍與小數位是 Pydantic 的 422。
- `DELETE /api/weights/{date}` → 204；沒有那一筆 → `404 WEIGHT_NOT_FOUND`。
- `GET /api/weights?from=&to=` → `{today, entries: [{date, weight_kg}]}`，由舊到新。
  `422 INVALID_RANGE`（from > to）、`422 RANGE_TOO_LONG`（> 800 天）。
- `GET /api/export/weights.csv` → `日期,體重(kg)`，由舊到新（D18）。

### 5.4 既有端點的改變

- `PUT /api/targets/today`：同一個交易裡 `UPDATE user_profiles SET targets_applied_weight_kg = NULL`（D16）。回應不變。
- `PUT /api/targets/today` 的寫入邏輯抽成 `write_target_from_today(db, user_id, today, values)`（留在 `routes/targets.py`，
  既有測試 monkeypatch 的 `today_in_timezone`、`_new_period_end` 照樣生效）。

---

## 6. 前端

### 6.1 檔案

| 檔案 | 內容 |
|---|---|
| `api/body.ts`（新） | `useBodyProfile`、`useFreshBodyProfile`、`saveBodyProfile`、`useTargetSuggestion`、`applySuggestion`、`useWeights`、`saveWeight`、`deleteWeight`、`invalidateBody` |
| `api/queries.ts` | `bodyProfile: ["body","profile"]`、`targetSuggestion: ["body","suggestion"]`、`weights: ["body","weights"]`、`bodyAll: ["body"]` |
| `lib/body.ts`（新） | 列舉的中文標籤（性別、五個活動量含說明、三個目標、兩個速度）、`MISSING_LABELS` |
| `lib/weights.ts`（新） | `movingAverage`、`weekChange`、`entriesInSpan` |
| `lib/decimal.ts` | `differenceOf`、`paddedExtent`、`positionIn`、`checkWeightInput` |
| `lib/civil-date.ts` | `daysBetween` |
| `components/BodyProfileCard.tsx`、`WeightCard.tsx`、`WeightChart.tsx`、`TargetSuggestion.tsx`（新） | |
| `components/Segmented.module.css`（新，從 `Trend.module.css` 搬來） | 分段切換 |
| `screens/BodyProfile.tsx`（`/me/body`）、`screens/Weight.tsx`（`/weight`）（新） | |
| `TargetsCard.tsx`、`Targets.tsx`、`Me.tsx`、`ExportCard`（經 `api/export.ts`）、`App.tsx`、`lib/layout.ts` | |

### 6.2 「我的」的兩張卡片

- **身體資料**：一行摘要（「男・36 歲・175 cm・中度活動・減重每週 0.5 公斤・目標 72 公斤」，沒設的略過；整份都沒設：「還沒有填」），
  「修改」連結（可及名稱「修改身體資料」）到 `/me/body`。
- **體重**：最新一筆（「72.4 公斤・10/14」）、跟 7 天前比（`weekChange`：最新一筆跟「日期 ≤ 最新 − 7 天」的最新一筆比；
  沒有就不顯示）；「記錄體重」按鈕展開行內表單（體重、日期，日期預設 `today`、`max=today`、`min=today − 730`），存了收起來；
  「看全部」連到 `/weight`。

### 6.3 `/me/body`

`form` 寬度。性別、目標、速度是 `fieldset`＋單選鈕（`legend` 看得到）；活動量是 `<select>`（五個選項帶說明：「中度（每週運動 3–5 天）」）；
出生年、身高、目標體重是 `inputMode="decimal"` 的輸入框（16px）。速度只在目標是減重或增重時出現（維持時送它原本的值，不清掉——
切回減重時還在）。送出前在前端檢查範圍（`checkWeightInput` 等），錯誤列在 `role="alert"`。儲存成功 → 失效 `["body"]`、導回 `/me`。
預填規則見 D27。

### 6.4 `/weight`

- 期間切換（30 天／90 天／全部，預設 30）用 `Segmented.module.css`。
- `WeightChart`：純渲染。x 軸是日期（`daysBetween(起點, 日期) / 天數`），起點是 30／90 天前或「全部」的第一筆；y 軸是
  `paddedExtent`（所有體重、目標體重，各往外留 1 公斤、取整）。每筆一個 `<circle role="img" aria-label="10/14，72.4 公斤">`；
  移動平均是一條 `<polyline>`（`aria-hidden`，摘要寫在圖下面）；目標體重是一條虛線（`.trend-target` 同款）。幾何全部算成屬性（同 `TrendChart`）。
- 圖下面：「最近 7 天平均 72.1 公斤」。
- 清單：由新到舊，每列「10/14　72.4 公斤」＋「修改」（就地變成輸入框＋儲存／取消）＋「刪除」（`window.confirm`）。
- 沒有任何紀錄：「還沒有體重紀錄」＋記錄的表單。

### 6.5 建議目標（`/me/targets` 的上半）

- `ready: true`：四個數字；說明列「基礎代謝 1719 kcal × 活動量 → 每日消耗 2664 kcal，減重每週 0.5 公斤 −550 kcal」；
  套用了下限時多一行「已調到最低建議熱量 1500 kcal」；「依 10/14 的體重 80 公斤」；免責聲明；「套用建議目標」按鈕（送出中 `aria-disabled`）。
  `409 SUGGESTION_CHANGED` → 重抓建議、顯示「建議目標剛剛變了，請看過新的數字再套用」。
- `ready: false`：「還差：性別、出生年、體重」，缺身體資料 → 連到 `/me/body`（「填寫身體資料」），缺體重 → 連到 `/weight`（「記錄體重」）。
- 手動表單照舊在下面，標題「自己設定」。

### 6.6 「每日目標」卡片的提示

`resuggest: true` 時卡片底部：「體重變了 −1.5 公斤，要重算建議目標嗎？」，連結「重算建議目標」到 `/me/targets`。
（`weight_change_kg` 帶正負號，`formatMacro`。）

---

## 7. 隱私

- **好友與社群**：`FriendMeal`、`SocialMealResponse`、通知、好友清單的序列化都是白名單，這份規格不碰它們。
  新增掃描測試（`tests/test_body_privacy.py`）：
  1. 走遍 `app/schemas/friend.py`、`app/schemas/social.py` 每個模型（含巢狀），欄位名不含 `weight`、`height`、`birth`、`sex`、`activity`、`goal`、`profile`。
  2. `UserProfile`、`WeightEntry`、`user_profiles`、`weight_entries` 這幾個字只准出現在身體資料的模組（模型、`body_targets.py`、
     `routes/body.py`、`routes/weights.py`、`routes/targets.py`、`export.py`、`routes/export.py`、`models/__init__.py`）。
  3. 這幾個模組裡沒有 `logger`／`logging`。
- **端點**：每個端點只用 token 的使用者；跨使用者測試：A 記的體重、資料，B 的 GET 看不到、B 的 DELETE 同一個日期是 404 而且 A 的那筆還在。
- **離線快取**：`["body", …]` 進 localStorage（D19）。登出時整個 query 快取清掉（既有行為）。
- **log**：後端不記數值；前端不 `console.log`。

---

## 8. 測試

### 8.1 後端

- `tests/test_body_targets.py`：§3 的 A–E 五組逐欄比對；年齡用固定的 `today`；`round_half_up` 的 .5（`2105 → 2110`、`400.5 → 401`）；
  每一種缺項（D11 的順序；維持不缺速度）。
- `tests/test_body_model.py`：每個 CHECK 擋得住（`begin_nested` 包 raw SQL）；cascade；主鍵擋同一天兩筆。
- `tests/test_body_profile.py`：GET 空的是全 null；PUT 整組、少一個鍵 422、範圍邊界（100、250、99.9、250.1……）、出生年邊界（monkeypatch
  `app.api.routes.body.today_in_timezone`，並記下它收到的時區——§6 第 2 種）；並行第一次存（獨立 session）兩個都 200、一列。
- `tests/test_target_suggestion.py`：GET 的兩種形狀；最新體重是**日期**最新的不是最後寫的；套用寫目標、記體重、409 什麼都不寫、
  `PUT /api/targets/today` 清掉套用體重、`resuggest` 在 ±1 的邊界（0.99 → false、1.00 → true、−1.00 → true）。
- `tests/test_weights.py`：upsert（同一天第二次是更正、`updated_at` 變、`created_at` 不變）、日期邊界（今天、明天、730、731 天前，
  用使用者時區——台北的今天在 UTC 還是昨天）、清單順序與範圍、800／801 天、刪除、跨使用者。
- `tests/test_export.py`：`weights.csv` 的欄位、順序、只有自己的。
- `tests/test_body_privacy.py`：§7 的三條掃描。

### 8.2 前端

`decimal.test.ts`（新函式）、`civil-date.test.ts`（`daysBetween` 跨月、跨年、閏日）、`weights.test.ts`（移動平均：缺日、7 天窗的邊界；
`weekChange`）、`weight-chart.test.tsx`（點的位置、平均線、目標線、`role="img"`）、`body-profile.test.tsx`（預填只用新鮮的、整頁重新載入、
送出整組、速度的顯示）、`weight.test.tsx`（期間切換、修改、刪除）、`target-suggestion.test.tsx`（兩種形狀、套用、409）、
`targets-card.test.tsx`／`me.test.tsx`（提示、新卡片）、`layout.test.ts`（`/me/body` 是 form）、`export-card.test.tsx`（四顆）。

### 8.3 e2e（`e2e/body-targets.spec.ts`，新帳號）

1. 「我的」→「修改身體資料」→ 填完 → 回「我的」→「記錄體重」80 → `/me/targets` 看到建議 → 套用 → 「總覽」的熱量分母是建議的數字
   → 「我的」記 78.5（另一天，用日期欄）→ 每日目標卡片出現「體重變了 −1.5 公斤」。
2. `/weight`：兩筆、修改一筆、刪除一筆，清單與圖的點數跟著變。

登入之後只用點擊換頁、名稱 `exact: true`、等頁面獨有的元素；固定手機尺寸量一次觸控高度與輸入框字級。

---

## 9. 已知限制

1. 年齡只看出生年，最多差一歲（≈ 5 kcal）。
2. 公式是族群平均：個人的實際消耗可能差 ±10% 以上；活動量是自評。
3. 「全部」是最近 800 天；兩年多以前記的會慢慢掉出圖表（資料還在，匯出看得到）。
4. 蛋白質乘的是目前體重：體重很高的人會得到偏高的蛋白質、碳水可能被擠到 0（D9）。
5. 只有男／女兩種 BMR 公式。
6. 重算提示只看體重，不看身體資料或活動量改過。
7. 目標只能從今天起（沿用帳號設定的限制）。

---

## 10. 交付

- 後端：`app/models/body.py`、`migrations/versions/0019_create_body_tables.py`、`app/body_targets.py`、`app/schemas/body.py`、
  `app/api/routes/body.py`、`app/api/routes/weights.py`、`routes/targets.py`（抽寫入函式、清套用體重）、`app/export.py`／`routes/export.py`（體重）、
  `app/main.py`；測試見 §8.1。
- 前端：§6.1；`schema.d.ts` 每個後端 task 重新產生。
- e2e：`e2e/body-targets.spec.ts`。
- 文件：`docs/handover.md`（§2 數字、功能章節、已知限制）、`docs/deployment.md`（`0019`）、這份規格的狀態。

**寫規格時實測過的事：** Pydantic 的 bool discriminator 在 OpenAPI 變成 `"True"`／`"False"` 字串的 mapping，openapi-typescript 7.13 產生
`ready: "True"`；不加 discriminator 是 `anyOf`，產生 `ready: true`／`ready: false`（D10）。§3 的五組數字用同一套 `Decimal` 運算的腳本算過。
