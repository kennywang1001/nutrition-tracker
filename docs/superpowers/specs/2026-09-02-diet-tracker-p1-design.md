# 飲食紀錄系統 — P1 核心資料模型與 API 設計

- 日期：2026-09-02
- 階段：P1（核心資料模型 + CRUD API + 測試框架）
- 狀態：待審

---

## 1. 專案目標

做一套個人飲食紀錄系統，記錄每天攝取的三大營養素與補劑，支援拍照，並可透過 AI
分析未曾記錄過的食物。最終部署在群暉 NAS 上，透過 Tailscale 供手機使用，並放上
GitHub 作為作品集。

這個專案有兩層目標，設計時兩者都要顧：

| 層次 | 目標 |
|---|---|
| 產品 | 一套自己每天真的會用的飲食紀錄軟體 |
| 學習 | 資料庫設計深度、Docker 部署、API 測試框架、多 agent 調用、AI 協作 |

學習目標是主線，軟體是載體。當兩者衝突時（例如「這樣做比較快，但學不到東西」），
以學習目標優先；但不為了展示技術而加入沒有用途的功能。

---

## 2. 階段拆分

整份需求太大，無法放進單一 spec。拆成五個階段，各自跑一次
「spec → 實作計畫 → 實作」的循環。

| 階段 | 內容 | 對應學習目標 |
|---|---|---|
| **P0 骨架** | Docker Compose 起 API + DB、CI 綠燈、repo 結構 | Docker、環境一致性 |
| **P1 核心** | 資料模型 + 飲食紀錄 CRUD API + 測試框架 | **資料庫設計深度**、API 測試框架 |
| **P2 AI 分析** | 拍照 → 食物辨識 → 營養素估算 → 驗證 → 寫回食物庫 | 多 agent 調用、AI 協作 |
| **P3 介面** | 手機可用的前端（PWA，TypeScript + React） | 前後端整合 |
| **P4 上線** | 群暉 NAS 部署 + Tailscale + 作品集包裝 | 部署、CI/CD、技術寫作 |

**本文件只涵蓋 P1。** P0 的骨架會在 P1 實作過程中順帶長出來（因為 P1 的測試
本來就需要一個能跑的 Docker Compose 環境）。

---

## 3. P1 範圍

### 範圍內

- 使用者註冊、登入、JWT 驗證、角色（一般使用者 / 管理員）
- 食物主檔：全域（維基式，編輯需審核）+ 私人
- 食物版本化與編輯審核流程
- 份量換算（1 碗 = 200g）
- 餐點紀錄（一餐多項）+ 照片上傳與存取
- 補劑：主檔、每日計畫、實際攝取紀錄
- 每日營養素目標（有效期間制）
- 每日 / 期間統計 API
- 完整測試套件（含跨使用者隔離測試）

### 範圍外（留給後續階段）

- AI 影像分析與營養素估算 → P2
- 前端介面 → P3
- NAS 部署、Tailscale、CI/CD → P4
- 密碼重設、Email 驗證（需要 email 服務，P1 不做）
- 推播提醒
- 資料匯出

---

## 4. 技術棧

```
語言      Python 3.12
框架      FastAPI（async）
ORM       SQLAlchemy 2.0（async）+ Alembic
驗證      Pydantic v2
資料庫    PostgreSQL 16
測試      pytest + httpx AsyncClient
品質      ruff（lint + format）+ mypy
容器      Docker Compose
```

### 為什麼是 Python 而不是 TypeScript

使用者最熟 Python 與 C++，作品集目標是全端。

P3 的前端無論如何都得寫 TypeScript，這件事跑不掉。所以真正的問題是「後端要不要
也用 TS」。若後端也用 TS，等於同時學：新語言 + 資料庫設計 + Docker + 測試框架 +
多 agent 調用。卡關時無法分辨是語言不熟還是概念沒懂，五件事都會學成半吊子。

用 Python 寫後端，既有能力可直接投入最難也最重要的部分（資料庫設計），
TypeScript 留到 P3 才學，那時它被隔離在前端，範圍小、回饋快。

「Python 後端 + React/TS 前端」是業界常見的全端組合，加上 AI 分析功能，
比純 TS 更有說服力。

### 為什麼是 PostgreSQL

設計中用到 `EXCLUDE` 期間不重疊約束、`citext`、`pg_trgm` 模糊搜尋、
JSONB（P2 存 AI 原始回覆）、window function（統計）。
MySQL 與 SQLite 都不支援或支援不足。

需要的擴充：

```sql
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

---

## 5. 核心設計決策

以下決策是整份設計的骨幹，每一個都附上理由，因為理由比結論更重要。

### 決策 1：一餐一筆，而非一項一筆

```
meals (一餐，含照片) ─┬─ meal_items (滷肉飯)
                      ├─ meal_items (滷蛋)
                      └─ meal_items (燙青菜)
```

**理由：**

1. AI 的輸出形狀天然就是這樣 —— 一張照片吐出一組食物。扁平化的話，
   照片欄位要複製 N 次。
2. 「一餐」是使用者腦中真實存在的概念。
3. 扁平化會把「這幾樣是同一餐吃的」這個結構資訊丟掉，之後只能靠時間戳猜回來。

### 決策 2：食物分層 —— 全域（維基式，需審核）+ 私人

```
owner_id = NULL  → 全域食物（如超商商品），所有人可查、可提案編輯
owner_id = 3     → 3 號使用者的私人食物（如自助餐便當）
```

查詢一律是 `WHERE owner_id IS NULL OR owner_id = :me`。

**為什麼不是全部私有：** 每個使用者都要從零建自己的食物庫，AI 分析的成果無法
累積 —— 一萬個人拍一萬次滷肉飯，就要呼叫一萬次 LLM。分層可讓 AI 產出沉澱成
全域資料，用得越久越省、越準。

**為什麼全域編輯需要審核：** 開放編輯的共用資料若無把關，錯誤與破壞會直接影響
所有人的歷史統計。審核是必要成本。

### 決策 3：版本化，而非快照

```
foods           (id, name, owner_id, current_revision_id)
food_revisions  (id, food_id, 營養素…, status, created_by, reviewed_by…)
meal_items      (…, food_revision_id)   ← 指向記錄當下那一版
```

**核心問題：** 全域的「茶葉蛋」熱量被人從 70 改成 700，上個月的紀錄要不要跟著變？

不能變。若會變，歷史統計就是浮動的，昨天看跟今天看不一樣，紀錄軟體便失去意義。

**為什麼選版本化而非快照（把數值抄進 meal_items）：**
維基模式本來就需要一張編輯歷史表（誰改的、改了什麼、能否回退）。
`food_revisions` 同時就是那張表，一張表解決兩個問題。用快照的話仍得另外做
編輯歷史，表數量一樣多卻少了溯源能力。

版本化還解鎖一個快照做不到的功能：「你這筆紀錄引用的食物資料已更新，
要套用新版本嗎？」—— 快照不知道自己引用的是哪一版。

**注意：** 快照法不是壞設計，電商訂單明細幾乎都這樣做。差別在於商品價格改了
不需要溯源，而維基需要。

### 決策 4：用 `current_revision_id` 指標，而非 `WHERE status = 'approved'`

`foods.current_revision_id` 指向目前生效的版本。**只有審核通過時才更新這個指標。**

**理由：** 直覺做法是所有查詢都加 `WHERE status = 'approved'`。但只要有一支
query 忘了加，未審核的資料就會外洩到正式畫面。這種 bug 平常不發作，只在剛好
有待審提案時出現，極難察覺。

用指標之後，「這個食物現在的營養素」就是
`JOIN food_revisions ON id = foods.current_revision_id`，
未審核資料在結構上就不可能被查到，不依賴任何人記得寫條件。

> **把「不能出錯」的規則交給資料結構保證，而不是交給工程師的記性。**
> 這是本階段最重要的觀念，在決策 5 會再出現一次。

### 決策 5：目標用有效期間（effective dating）

```
user_targets (user_id, kcal, protein_g, fat_g, carb_g,
              effective_from, effective_to)
```

**核心問題：** 三月減脂期蛋白質目標 150g，六月轉增肌改成 180g。若只存單一目標值，
三月的達成率會突然用六月的標準重算。

這與決策 3 是同一類問題：**會隨時間改變、但歷史不能動**。認出「這又是同一類
問題」，比記住個別解法更重要。

這個結構同時涵蓋使用者的三種使用模式，不需要任何分支邏輯：

| 使用者行為 | 資料狀態 |
|---|---|
| 不設目標 | 沒有任何 `user_targets` 資料列 |
| 只看單一目標值 | 一筆，`effective_to = NULL`（持續至今） |
| 設定期間目標 | 多筆，各有起訖日 |

查詢永遠是同一句：「找出涵蓋這一天的目標；找不到就是沒設，不比對。」

**期間重疊由資料庫擋掉**，不是靠程式檢查（決策 4 的觀念再次應用）：

```sql
ALTER TABLE user_targets ADD CONSTRAINT no_overlapping_targets
  EXCLUDE USING gist (
    user_id WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  );
```

### 決策 6：補劑獨立於食物，但同樣貢獻三大營養素

**為什麼不塞進 `foods` 加個 `is_supplement` 旗標：**
補劑專屬欄位（劑量單位、每份含量）在食物上全為 NULL，反之亦然。這種稀疏表是
把兩種不同的東西硬塞進一張表的典型症狀。

**為什麼補劑表要有三大營養素欄位：**
乳清蛋白 25g 確實含蛋白質與熱量，必須算進當日總攝取。統計時食物與補劑
`UNION` 後加總。魚油、維他命 D 的營養素欄位填 0，但仍需記錄「今天吃了沒」。

**計畫 vs 實際：** 分成 `supplement_plans`（我的固定清單）與
`supplement_intakes`（實際吃了）。這組概念讓「這個月該吃 30 次魚油，實際吃了
23 次」這種依從率統計成為可能。只記錄實際攝取的話，這個功能事後補不回來 ——
因為過去沒有計畫資料可以回填。

`supplement_plans` 同樣採用有效期間制（決策 5 的第二次應用）。

### 決策 7：哪些列舉用原生 enum，哪些用 text + CHECK

PostgreSQL 的原生 `enum` 型別很好用，但它有兩個實測確認過的硬限制：

- `ALTER TYPE ... ADD VALUE` 可以在交易裡執行，但**同一個交易裡不能使用那個新值**
  （`unsafe use of new value`）。而 Alembic 預設會把所有待跑的 migration 包在
  同一個交易裡，所以「加一個值並且用它」的 migration 會整批失敗。
- **`ALTER TYPE ... DROP VALUE` 根本不存在。** 要移除或重新排序，只能重建型別
  並改寫所有相依欄位。

所以判準不是「這是不是一組固定選項」，而是：**這組值以後有沒有可能增加？**

| 列舉 | 選擇 | 理由 |
|---|---|---|
| `user_role` | 原生 enum | 新增角色是罕見的、跟權限程式碼綁在一起的部署事件 |
| `revision_status` | 原生 enum | 封閉的三態流程，直接決定 `current_revision_id` 的可見性邏輯 |
| `base_unit` | 原生 enum | 只有 g / ml 兩種，跟「每 100 單位」的正規化邏輯綁死 |
| **`meal_type`** | **text + CHECK** | 使用者面對的標籤。用了幾個月之後想加「早午餐」是很合理的事 |
| **`time_of_day`** | **text + CHECK** | 服用時段因人而異，六個值已經像是一個開放集合 |

前三個是**程式邏輯的一部分**，加一個值本來就要改程式；後兩個是**使用者的詞彙**，
應該能靠一次 migration 改掉，而不是重建型別。

同樣的道理，`supplements.serving_unit` 本來就是 `text` —— 單位是開放集合。

> **所有 CHECK 約束都必須明確命名**（`ck_<表名>_<用途>`）。
> 這是 `app/models/base.py` 的 `NAMING_CONVENTION` 強制的：`ck` 樣式用了
> `%(constraint_name)s`，沒給名字 SQLAlchemy 會直接拋 `InvalidRequestError`。
> 這是刻意的 —— 讓 PostgreSQL 自動命名的後果，是 `alembic` 的漂移檢查會對
> 完全沒改過的約束產生假的 drop + create。
>
> **注意：下面第 6 節的 DDL 為了可讀性，仍把大部分 CHECK 寫成欄位內嵌形式
> （`kcal numeric(8,2) NOT NULL CHECK (kcal >= 0)`）。**
> 寫實作計畫時要把它們改成具名的表層級約束：
> `CONSTRAINT ck_food_revisions_kcal_non_negative CHECK (kcal >= 0)`，
> 並在對應的 SQLAlchemy 模型用同一個名字。名字對不上，`alembic check` 就會紅。

---

## 6. 資料模型

### 6.1 users

```sql
CREATE TYPE user_role AS ENUM ('user', 'admin');

CREATE TABLE users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         citext NOT NULL UNIQUE,
  password_hash text   NOT NULL,
  display_name  text   NOT NULL,
  role          user_role NOT NULL DEFAULT 'user',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

- `citext` 讓 email 比對不分大小寫，避免 `A@x.com` 與 `a@x.com` 被視為兩個帳號。
- 密碼雜湊用 Argon2id（`argon2-cffi`），不用 bcrypt。

### 6.2 foods / food_revisions / food_portions

```sql
CREATE TYPE revision_status AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE base_unit AS ENUM ('g', 'ml');

CREATE TABLE foods (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                text NOT NULL,
  brand               text,
  owner_id            bigint REFERENCES users(id) ON DELETE CASCADE,  -- NULL = 全域
  current_revision_id bigint,   -- FK 於下方以 deferrable 方式加入
  created_by          bigint NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (owner_id, name, brand)
);

CREATE TABLE food_revisions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  food_id       bigint NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  base_unit     base_unit NOT NULL DEFAULT 'g',   -- 營養素基準：每 100g 或每 100ml
  kcal          numeric(8,2) NOT NULL CHECK (kcal >= 0),
  protein_g     numeric(8,2) NOT NULL CHECK (protein_g >= 0),
  fat_g         numeric(8,2) NOT NULL CHECK (fat_g >= 0),
  carb_g        numeric(8,2) NOT NULL CHECK (carb_g >= 0),
  status        revision_status NOT NULL DEFAULT 'pending',
  change_note   text,
  created_by    bigint NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_by   bigint REFERENCES users(id),
  reviewed_at   timestamptz,
  reject_reason text,
  -- P2 預留（見第 11 節），P1 的第一版 migration 就建好
  source         text NOT NULL DEFAULT 'user',   -- 'user' | 'ai' | 'official'
  ai_confidence  numeric(3,2) CHECK (ai_confidence BETWEEN 0 AND 1),
  ai_raw_response jsonb,
  CHECK (status <> 'rejected' OR reject_reason IS NOT NULL)
);

ALTER TABLE foods
  ADD CONSTRAINT fk_foods_current_revision
  FOREIGN KEY (current_revision_id) REFERENCES food_revisions(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE food_portions (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  food_id    bigint NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  label      text NOT NULL,                    -- '1 碗'、'1 顆'
  grams      numeric(8,2) NOT NULL CHECK (grams > 0),
  is_default boolean NOT NULL DEFAULT false,
  UNIQUE (food_id, label)
);
```

**營養素一律以「每 100g / 100ml」為基準儲存。** 不這樣做的話，「半碗」「一碗半」
「180g」會讓同一個食物存出無限多種格式，加總時是災難。

`foods` 與 `food_revisions` 互相參照，因此 `current_revision_id` 的外鍵必須是
`DEFERRABLE INITIALLY DEFERRED`，讓「建立食物 + 建立第一版」能在同一個交易內完成。

私人食物的編輯直接生效（建立 revision 時即 `approved` 並更新指標）；
全域食物的編輯進入 `pending`，等待管理員審核。

### 6.3 meals / meal_items

```sql
-- meal_type 刻意用 text + CHECK 而非原生 enum，理由見決策 7

CREATE TABLE meals (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  eaten_at   timestamptz NOT NULL,
  meal_type  text NOT NULL,
  photo_path text,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_meals_meal_type
    CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack'))
);

CREATE TABLE meal_items (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meal_id          bigint NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  food_revision_id bigint NOT NULL REFERENCES food_revisions(id),
  portion_id       bigint REFERENCES food_portions(id),  -- 使用者選了「1 碗」則記錄
  quantity         numeric(8,2) NOT NULL CHECK (quantity > 0),   -- 使用者輸入的數量
  quantity_g       numeric(8,2) NOT NULL CHECK (quantity_g > 0), -- 正規化後的克數
  created_at       timestamptz NOT NULL DEFAULT now()
);
```

**為什麼 `quantity_g` 要另外存一份：**
`food_portions` 沒有版本化。若有人把「1 碗 = 200g」改成 250g，所有引用該份量的
歷史紀錄都會跟著變 —— 這正是決策 3 要避免的問題。存下當下換算的克數，歷史就
固定了。`quantity` 與 `portion_id` 只用於顯示（「你當時輸入的是 1.5 碗」）。

### 6.4 supplements / supplement_plans / supplement_intakes

```sql
CREATE TABLE supplements (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         text NOT NULL,
  brand        text,
  owner_id     bigint REFERENCES users(id) ON DELETE CASCADE,  -- NULL = 全域（管理員維護）
  serving_unit text NOT NULL,          -- 'capsule'、'g'、'ml'、'IU'
  serving_size numeric(8,2) NOT NULL CHECK (serving_size > 0),
  kcal         numeric(8,2) NOT NULL DEFAULT 0 CHECK (kcal >= 0),
  protein_g    numeric(8,2) NOT NULL DEFAULT 0 CHECK (protein_g >= 0),
  fat_g        numeric(8,2) NOT NULL DEFAULT 0 CHECK (fat_g >= 0),
  carb_g       numeric(8,2) NOT NULL DEFAULT 0 CHECK (carb_g >= 0),
  created_by   bigint NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (owner_id, name, brand)
);

CREATE TABLE supplement_plans (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  supplement_id  bigint NOT NULL REFERENCES supplements(id),
  dose           numeric(8,2) NOT NULL CHECK (dose > 0),
  -- time_of_day 刻意用 text + CHECK 而非原生 enum，理由見決策 7
  time_of_day    text NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  CONSTRAINT ck_supplement_plans_time_of_day
    CHECK (time_of_day IN ('morning', 'noon', 'evening', 'bedtime',
                           'preworkout', 'postworkout')),
  CONSTRAINT ck_supplement_plans_effective_range
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE supplement_intakes (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  supplement_id bigint NOT NULL REFERENCES supplements(id),
  plan_id       bigint REFERENCES supplement_plans(id),  -- NULL = 臨時吃的
  dose          numeric(8,2) NOT NULL CHECK (dose > 0),
  taken_at      timestamptz NOT NULL,
  -- 快照：保護歷史不受補劑主檔修改影響
  kcal          numeric(8,2) NOT NULL DEFAULT 0,
  protein_g     numeric(8,2) NOT NULL DEFAULT 0,
  fat_g         numeric(8,2) NOT NULL DEFAULT 0,
  carb_g        numeric(8,2) NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

**為什麼補劑用快照，食物用版本化（刻意的不一致）：**
食物是群眾協作編輯的維基，需要溯源與回退，因此版本化。補劑的數值印在罐子標籤
上，是固定事實，不需要協作修正，用快照保護歷史即可，不值得為它建一整套審核流程。

若日後想讓全域補劑也開放協作編輯，可比照 `food_revisions` 補上
`supplement_revisions`，成本約一天。

### 6.5 user_targets

```sql
CREATE TABLE user_targets (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kcal           numeric(8,2) CHECK (kcal >= 0),
  protein_g      numeric(8,2) CHECK (protein_g >= 0),
  fat_g          numeric(8,2) CHECK (fat_g >= 0),
  carb_g         numeric(8,2) CHECK (carb_g >= 0),
  label          text,                -- '減脂期'、'增肌期'
  effective_from date NOT NULL,
  effective_to   date,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
```

加上決策 5 所述的 `EXCLUDE` 約束。四個營養素欄位皆可為 NULL —— 允許使用者
只設熱量目標、不設三大營養素。

### 6.6 索引

```sql
-- 「某天吃了什麼」：最高頻查詢
CREATE INDEX idx_meals_user_time ON meals (user_id, eaten_at DESC);
CREATE INDEX idx_meal_items_meal ON meal_items (meal_id);

-- 食物模糊搜尋（打「滷肉」要找到「滷肉飯」）
CREATE INDEX idx_foods_name_trgm ON foods USING gin (name gin_trgm_ops);

-- 分層查詢：WHERE owner_id IS NULL OR owner_id = :me
CREATE INDEX idx_foods_owner ON foods (owner_id);

-- 「我常吃 / 最近吃」：使用者每天走最多次的路徑
CREATE INDEX idx_meal_items_revision ON meal_items (food_revision_id);

-- 管理員待審佇列（部分索引，只索引 pending）
CREATE INDEX idx_revisions_pending ON food_revisions (status, created_at)
  WHERE status = 'pending';

-- 補劑與目標
CREATE INDEX idx_intakes_user_time ON supplement_intakes (user_id, taken_at DESC);
CREATE INDEX idx_plans_user_active ON supplement_plans (user_id, effective_from, effective_to);
```

「我常吃 / 最近吃」在 P1 用查詢 + 索引解決，**不建快取表**。等實際量到慢再優化
—— 過早的反正規化很難收回。

---

## 7. API 設計

所有端點（除註冊 / 登入外）都需要 `Authorization: Bearer <JWT>`。

### 7.1 認證

```
POST   /api/auth/register      註冊
POST   /api/auth/login         登入，回傳 access + refresh token
POST   /api/auth/refresh       換發 access token
GET    /api/me                 目前使用者資訊
```

### 7.2 食物

```
GET    /api/foods?q=&scope=            搜尋（scope: all | global | mine）
POST   /api/foods                      建立私人食物（含第一版營養素）
GET    /api/foods/{id}                 取得食物（含目前生效版本）
GET    /api/foods/{id}/revisions       版本歷史
POST   /api/foods/{id}/revisions       提出編輯（私人=直接生效，全域=待審）
POST   /api/foods/{id}/portions        新增份量換算
GET    /api/foods/frequent             我最常吃的（供快速紀錄）
GET    /api/foods/recent               我最近吃的
```

### 7.3 審核（僅管理員）

```
GET    /api/admin/food-revisions?status=pending   待審佇列
POST   /api/admin/food-revisions/{id}/approve     核准（更新 current_revision_id）
POST   /api/admin/food-revisions/{id}/reject      駁回（附理由）
```

### 7.4 餐點

```
POST   /api/meals                建立一餐（含多個項目）
GET    /api/meals?date=          某天的所有餐
GET    /api/meals/{id}
PATCH  /api/meals/{id}
DELETE /api/meals/{id}
POST   /api/meals/{id}/photo     上傳照片（上傳時壓縮至長邊 1280px、JPEG q80）
GET    /api/meals/{id}/photo     取得照片（驗證擁有權後才回傳）
```

### 7.5 補劑

```
GET    /api/supplements?q=&scope=
POST   /api/supplements
GET    /api/supplement-plans                  我的固定清單
POST   /api/supplement-plans
PATCH  /api/supplement-plans/{id}             修改（關閉舊期間、開新期間）
DELETE /api/supplement-plans/{id}
GET    /api/supplements/today                 今日待打卡清單（計畫 vs 已服用）
POST   /api/supplement-intakes                打卡或臨時記錄
DELETE /api/supplement-intakes/{id}
```

### 7.6 目標與統計

```
GET    /api/targets?date=          某天生效的目標（無則回傳 null）
GET    /api/targets                所有期間
POST   /api/targets                設定新目標
PATCH  /api/targets/{id}
GET    /api/stats/daily?date=      當日總攝取（食物 + 補劑）vs 目標
GET    /api/stats/range?from=&to=  期間趨勢、目標達成率、補劑依從率
```

---

## 8. 照片儲存

**決定：檔案系統 + Docker volume。** DB 只存路徑。

**為什麼不存進資料庫：** 照片會逐年累積（壓縮後單人約 500MB/年），DB 會持續變大。
真正的致命傷不是效能，是備份心理學 —— 一年後 `pg_dump` 變成數 GB，備份變慢變
麻煩，然後就不備份了，反而失去「一致性」這個唯一優勢。

**為什麼不用 MinIO：** 部署目標明確是家用 NAS 單機。為一個不會發生的雲端遷移，
付出額外容器、額外記憶體、額外故障點的代價。而檔案系統在 NAS 上還有實際好處：
照片就是資料夾裡的普通檔案，可用 Synology 內建工具瀏覽與備份。

**不預先抽象 storage interface。** 只要求所有檔案讀寫集中在單一模組
（`app/storage/photos.py`）。真要換 MinIO，改動範圍就是那個檔案。

### 孤兒檔案處理

刪除時**先刪 DB 資料列，檔案刪失敗就算了**，另有背景清理工作定期掃描。

理由是兩種孤兒的嚴重性不對稱：多一個沒人引用的檔案只是浪費磁碟，少一個被引用的
檔案是壞掉的功能。所以順序永遠是「先確保 DB 正確，容許檔案暫時落後」。

### 照片權限

照片**不透過靜態檔案服務提供**，一律走 `GET /api/meals/{id}/photo`，先驗證 JWT
與擁有權才回傳檔案。

用不可猜的 UUID 檔名 + 公開資料夾也是一種做法，但本質是「靠對方猜不到」，網址
一旦外流就永久有效。既然選了完整多使用者，權限就該是真的。

---

## 9. 錯誤處理

統一錯誤格式：

```json
{
  "error": {
    "code": "FOOD_NOT_FOUND",
    "message": "找不到該食物",
    "details": {}
  }
}
```

| 情境 | 狀態碼 |
|---|---|
| 驗證失敗（Pydantic） | 422 |
| 未登入 / token 失效 | 401 |
| 已登入但權限不足（如一般使用者呼叫審核 API） | 403 |
| **存取他人資源** | **404（非 403）** |
| 違反唯一約束（重複食物名） | 409 |
| 違反期間重疊約束 | 409 |

**為什麼他人資源回 404 而非 403：**
403 等於告訴對方「這個 ID 存在，只是你不能看」，本身就是資訊洩漏，攻擊者可藉此
列舉系統中有哪些資源。回 404 則對方無法分辨「不存在」與「不屬於你」。

資料庫層的約束違反（`EXCLUDE`、`UNIQUE`、`CHECK`）要攔截並轉譯成上表的錯誤格式，
不可讓 psycopg 的原始錯誤訊息外洩到 API 回應。

---

## 10. 測試策略

這是 P1 的學習重點之一，規格與功能同等重要。

### 10.1 硬性規定：測試跑真的 PostgreSQL

**不准用 SQLite 代替。**

設計中有 `EXCLUDE` 期間約束、`citext`、`pg_trgm`、`NULLS NOT DISTINCT`、JSONB
—— SQLite 全都沒有。用 SQLite 測等於測了一個跟正式環境不同的系統，測試全綠但
上線爆炸，且完全查不出原因。

### 10.2 測試架構

```
docker compose 起測試專用 PostgreSQL
  ↓
session 級 fixture：跑 alembic upgrade head
  ↓
每個測試包在 transaction 內 → 跑完 rollback
  ↓
測試之間完全隔離，且不需手動清資料
```

- `httpx.AsyncClient` 直接打 ASGI app，不經過網路
- factory 產生測試資料，不在每個測試手刻 JSON
- 測試分層：unit（純函式，如營養素換算）/ integration（API + DB）

### 10.3 必要測試項目

| 類別 | 內容 |
|---|---|
| **跨使用者隔離** | 每個涉及使用者資料的 endpoint，都要有「用 B 的 token 存取 A 的資源 → 404」的測試 |
| **權限** | 一般使用者呼叫審核 API → 403 |
| **版本不變性** | 建立紀錄 → 修改食物營養素並核准 → 該筆紀錄的數值不變 |
| **審核流程** | 待審版本不會出現在 `GET /api/foods/{id}` |
| **期間重疊** | 建立重疊的目標期間 → 409 |
| **份量快照** | 建立紀錄 → 修改份量換算 → 該筆紀錄的 `quantity_g` 不變 |
| **照片權限** | 用 B 的 token 取 A 的照片 → 404 |
| **統計正確性** | 食物 + 補劑的營養素確實合併加總 |

「跨使用者隔離」這組測試在作品集裡特別值錢，因為多租戶隔離漏洞是真實系統最常見
的資安問題。

### 10.4 後續可加

`schemathesis` 從 OpenAPI schema 自動產生上千組畸形輸入攻擊 API。P1 完成後再加，
屬於加分項。

---

## 11. 產品流程備註（影響設計，實作於 P2 / P3）

使用者記錄一餐的兩條路徑：

```
已經吃過的食物 → 從「常吃 / 最近吃」直接選 + 拍照存檔 → 不呼叫 AI
沒吃過的食物   → 拍照 → AI 分析 → 確認後存入食物庫
```

第一條是每天走最多次的路徑，因此 `GET /api/foods/frequent` 與 `/recent` 的效能
在 P1 就要顧好（見 6.6 索引）。

P2 的 AI pipeline 預計形狀（本階段不實作，但資料模型需相容）：

```
照片 → ① 辨識 agent（有什麼食物、估份量）
     → ② 查自己的食物庫（DB query，不是 agent）
     → ③ 查不到才用估算 agent（LLM 估三大營養素）
     → ④ 驗證 agent（熱量 ≈ 蛋白質×4 + 碳水×4 + 脂肪×9？份量合理嗎？）
     → ⑤ 落庫，標記來源與可信度
```

②「能用 DB 解決的就別呼叫 LLM」是省錢與準確度的關鍵。
④ 是這個作品集最有價值的部分：展示「我知道 LLM 會胡說，所以我設計了驗證層」。

**P1 需為 P2 預留的欄位** —— 已包含在 6.2 節 `food_revisions` 的第一版
migration 中，P1 不使用，但先建好以避免日後痛苦的資料表變更：

```sql
source          text NOT NULL DEFAULT 'user'   -- 'user' | 'ai' | 'official'
ai_confidence   numeric(3,2)                   -- 0.00 ~ 1.00
ai_raw_response jsonb                          -- 原始回覆，供稽核
```

判斷標準是「事後補的代價」：這三個欄位現在加只是多打幾行，日後補則要動既有
資料、回填、改所有查詢。相對地，登入系統這類不動既有資料結構的東西，就可以
放心延後。**哪些決定要提早做、哪些可以延後 —— 這個判斷本身就是設計能力。**

---

## 12. 待決問題（不阻擋 P1 實作）

### 已決定：註冊維持開放，不設邀請碼

實作 Task 11 時審查提出：任何能連到 API 的人都能自己註冊，沒有邀請碼、沒有審核、
沒有上限，而規格第 1 節寫的是「自己跟少數受邀的人」。

**決定：維持開放註冊。** 邊界交給 Tailscale —— 連得到 API 就代表已經在 tailnet 裡。

**已知的殘留風險（接受）：** tailnet 的範圍通常比單一 app 寬。例如為了讓家人用
Plex 而把他們加進 tailnet，他們就也能在這裡註冊。真的需要收緊時，最便宜的做法是
一個環境變數的共用邀請碼（沒設就等於關閉註冊），不需要改資料庫、不需要審核流程。

| # | 問題 | 何時決定 |
|---|---|---|
| 1 | 第一個管理員帳號如何產生（種子資料 vs 環境變數） | P1 實作時 |
| 2 | P2 的 AI 產生的全域食物是否也送審？會不會洗版審核佇列 | P2 |
| 3 | 全域補劑是否需要版本化與審核 | 有需求時 |
| 4 | 補劑計畫是否需要「每週特定幾天」而非每天 | 有需求時 |
| 5 | 密碼重設流程（需要 email 服務） | P4 |

---

## 13. P1 完成標準

1. `docker compose up` 一鍵起 API + PostgreSQL，可存取 `/docs`
2. 所有 migration 可從空資料庫跑到最新版
3. 第 7 節所有 API 端點可用，且有對應測試
4. 第 10.3 節列出的必要測試項目全部通過
5. 測試覆蓋率 > 80%，且跨使用者隔離測試 100% 覆蓋
6. `ruff` 與 `mypy` 無錯誤
7. CI 在每次 push 時跑完整測試套件
