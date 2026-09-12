# Session 撤銷 — 設計

- 日期：2026-09-11
- 定位：**P3 的前置條件**，不是 P3 的一部分
- 淵源：計畫 1 明寫「不要拖到 P4，要自己一個 task」；交接文件 §8.1
- 狀態：待審

---

## 1. 問題

`POST /api/auth/refresh` 每次換發都發一張新的 14 天票，**而舊的仍然有效**
（`app/api/routes/auth.py` 的 `refresh()` 只做解碼就發新票，
沒有任何一處記錄或作廢舊票，實測確認）。

所以「refresh token 14 天」不是上限，是一個
**只要裝置持續使用就永遠不會關上的滑動視窗**。

兩個後果：

**安全面。** 手機掉了，唯一的止血是換 `JWT_SECRET` —— 那會把所有使用者
一起登出，而且會同時作廢所有 access token。用整個系統的可用性換一台裝置的
安全，這個代價高到實務上不會有人真的去做，等於沒有止血手段。

**產品面（這一項才是把它變成 P3 前置條件的原因）。**
後端沒有登出端點。前端能做的「登出」只是清掉 localStorage —— 那張票在
伺服器上還活著 14 天。**那會是一個看起來有效、實際上說謊的 UI**，
而這正好是交接文件 §6 那份清單的介面版本。P3 不能建立在這上面。

---

## 2. 範圍

### 範圍內

- refresh token 輪替（rotation）：換發時舊票當場失效
- 重用偵測（reuse detection）：舊票被第二次使用 → 判定外洩 → 撤銷整條鏈
- `POST /api/auth/logout`（單一裝置）與 `POST /api/auth/logout-all`（全部裝置）
- 過期 session 列的清理指令
- 上線時既有 token 的處理（見 §7）

### 範圍外

- **`GET /api/auth/sessions`（已登入裝置列表）與 `user_agent` 欄位。**
  判斷標準跟 P1 規格第 11 節同一個 —— 「事後補的代價」。這兩樣都是
  nullable 欄位加一個新端點，事後補不需要動既有資料、不需要回填、
  不需要改任何既有查詢，所以現在不做。
- access token 的即時撤銷。刻意不做，理由見 §4。

---

## 3. 資料模型

```sql
CREATE TABLE refresh_sessions (
    id          bigserial    PRIMARY KEY,
    user_id     bigint       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    jti         uuid         NOT NULL UNIQUE,
    family_id   uuid         NOT NULL,
    issued_at   timestamptz  NOT NULL,
    expires_at  timestamptz  NOT NULL,
    used_at     timestamptz,   -- 被拿去換過新票的時間；NULL = 還沒用過
    revoked_at  timestamptz,   -- 撤銷時間；NULL = 有效

    CONSTRAINT ck_refresh_sessions_expires_after_issued CHECK (expires_at > issued_at)
);

-- 核心不變量：一個 family 最多只有一張活票（見下）
CREATE UNIQUE INDEX uq_refresh_sessions_one_live_per_family
    ON refresh_sessions (family_id)
    WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE INDEX ix_refresh_sessions_user_id_revoked_at ON refresh_sessions (user_id, revoked_at);
CREATE INDEX ix_refresh_sessions_family_id          ON refresh_sessions (family_id);
```

**`expires_at` 刻意不建索引。** 唯一的消費者是每天跑一次的 `cleanup-sessions`，
而那是一個會掃掉表中數 % 列的 bulk DELETE —— 規劃器本來就會選 seq scan。
這張表是整個 app 寫入率最高的（access token 15 分鐘過期，每台活躍裝置每天
約 100 次輪替 = 100 列），不值得為一個量不到的節省，在最熱的寫入路徑上
多維護一棵 btree。**等真的量到再加**，判斷標準跟 §8.2 的照片縮圖同一個。

**`family_id` 是一次登入衍生出的整條鏈。** 登入時產生一個新的 family，
之後每次輪替都在同一個 family 裡長出下一列。撤銷的單位是 family，
不是單一列 —— 因為攻擊者手上那張票換出來的後續票也必須一起死。

**`used_at` 與 `revoked_at` 分開，不合併成一個 `status` 欄位。**
兩者是不同的事實：「已經被拿去換過」是正常流程的終點，
「被撤銷」是安全事件或使用者登出。合併之後就再也分不出
「這條鏈是正常輪替到底的」與「這條鏈被判定外洩」。

### 3.1 「一個 family 最多一張活票」由資料庫保證

鏈分岔 —— 同一個 family 裡同時存在兩張有效的票 —— **就是這整張表要防的那個
bug**。§5.2 的條件式 UPDATE 保證了它，但那是程式碼：只要那個 WHERE 被改弱，
或哪天有人在沒先作廢前一張的情況下呼叫了簽發，鏈就會**安靜地**分岔，
沒有錯誤、沒有紅燈，只有兩張同時有效的票。

那個部分唯一索引讓資料庫也保證一次。真的發生時，要的是一個大聲的
`IntegrityError`，不是一個沒人發現的分岔。

與所有流程相容，逐一確認過：

| 流程 | 索引裡的活票數 |
|---|---|
| 登入 | 插入一列 → 1 |
| 輪替 | 先 UPDATE 前一列的 `used_at`（退出索引）、再 INSERT 後繼列 → 1。PostgreSQL 逐 statement 檢查唯一索引，順序是對的 |
| 重用偵測 / 登出 | 整個 family 寫 `revoked_at` → 0 |
| 清理 | 刪除過期列 → 不影響 |

**實作風險要先講明：** 部分索引的 `WHERE` 述詞在模型與 migration 兩邊必須
拼得一模一樣，否則 `alembic check` 會報漂移 —— 而且這有可能是**無法收斂**的
那一種（§7 的 `Enum(create_constraint=True)` 就是這個形狀）。實作時若確認
收斂不了，**回報，不要硬凹**：那時的選擇是換一種寫法或放棄這個索引，
不是讓 `alembic check` 長期紅著。

### 3.2 其他

**存 `jti` 不存 token 本身。** token 字串進資料庫等於把一份可直接使用的
憑證留在備份裡，而 `jti` 已經足夠做撤銷判斷。這跟 §4.9 照片不進資料庫是
同一類考量的不同面向。

`ON DELETE CASCADE`：使用者刪除時 session 列一起走，不留孤兒。

---

## 4. 撤銷的粒度與延遲（刻意接受的缺口）

**access token 不查資料庫。** 每個請求都去查一次 session 表，等於把
無狀態驗證的全部好處丟掉，換來 15 分鐘的延遲改善 —— 對這個規模不划算。

所以撤銷的真實語意是：

> 撤銷之後，該裝置**最多還能用 15 分鐘**（access token 的剩餘壽命），
> 但**再也換不到新票**。

這是刻意接受的缺口，不是 bug。規格明寫它，是因為它必須有一條測試釘住
（見 §6 陷阱 4）—— 否則日後有人「順手修好」它（在 `get_current_user`
裡加一次 DB 查詢），效能代價不會有任何東西變紅來提醒他。

---

## 5. 流程

### 5.1 登入

```
POST /api/auth/login
  → 產生 family_id = uuid4()
  → 產生 jti = uuid4()
  → INSERT refresh_sessions (user_id, jti, family_id, issued_at, expires_at)
  → 回傳 access(15m, 無 jti) + refresh(14d, payload 含 jti)
```

### 5.2 換發

```
POST /api/auth/refresh
  decode_refresh_token(refresh_token)  ← payload 必須含 jti
  SELECT ... FROM refresh_sessions WHERE jti = :jti

  查不到           → 401 INVALID_TOKEN
  revoked_at 有值  → 401 INVALID_TOKEN
  used_at 有值     → 【重用偵測】撤銷整個 family，401 INVALID_TOKEN
  否則             → UPDATE used_at = now
                     INSERT 同 family 的新列
                     回傳新的 access + refresh
```

**重用時為什麼一律當作外洩。** `used_at` 有值代表這張票已經換過一次。
兩種可能：(a) 攻擊者拿到舊票來用，(b) 合法 client 因網路重試送了兩次。
**伺服器無法區分這兩者**，而猜錯的代價不對稱 —— 把重試誤判為外洩的代價是
使用者重新登入一次；把外洩誤判為重試的代價是攻擊者得到一條永久有效的鏈。
所以一律撤銷。

**這個決定把一個約束推給前端**，而且是 P3 規格必須處理的：
前端同一時間只能有一個 refresh 在飛。兩個分頁同時發現 401、同時去換票，
其中一個會踩到重用偵測，結果是**使用者莫名其妙被登出**。
後端刻意不做寬限期（寬限期會直接稀釋重用偵測的鑑別力），
前端必須用跨分頁的 single-flight 鎖。見 P3 規格 §6.4。

### 5.3 登出

```
POST /api/auth/logout      body: {refresh_token}   → 撤銷該 family
POST /api/auth/logout-all  需要 access token       → 撤銷該 user 所有 family
```

`logout` 對已經無效的 token 回 **204**，不回 401。登出是冪等的 ——
「讓我登出」在票已經死掉時已經達成了，回錯誤只會讓前端在登出流程裡
多寫一段沒有意義的錯誤處理。

### 5.4 清理

`python -m app.cli cleanup-sessions` —— 刪掉 `expires_at` 已過的列。

**比較用的是 Python 的時鐘（`datetime.now(UTC)`），不是 SQL 的 `now()`。**
這四個時間戳都是應用程式寫進去的（見 §3 的 `issued_at`），
所以比較也要用同一個時鐘。混用的話，NAS 上容器時鐘與 PostgreSQL 時鐘
一旦漂移，session 就會提早或延後過期，而且沒有任何東西指得出原因。
形狀與 `cleanup-photos` 相同，一樣**必須在容器內執行**，一樣寫進部署手冊的 cron。

---

## 6. 測試策略：這個功能的綠燈很會說謊

對照交接文件 §6 那份清單逐條檢查過，這個功能至少有四個位置會發出假綠燈。

### 陷阱 1：測「新票可用」對這個缺陷零鑑別力

```
換發 → 新 token 能打 /api/me → 200 ✅
```

這條測試**現在就是綠的**，修好之後也是綠的。它跟缺陷的重疊區間是空的
（§6 第 6 條）。有鑑別力的形狀只有一種：

```
換發 → 拿【舊】token 再換一次 → 必須 401
```

### 陷阱 2：只驗一層鏈，family 撤銷邏輯不會變紅

`A → B` 之後拿 A 重用，斷言 A 失效 —— 但把「撤銷整個 family」改成
「只撤銷這一列」，這條測試照樣綠。必要的形狀是**至少三層**：

```
A → B → C，然後拿 B 去換
  → B 失效（本來就會）
  → 【C 也必須失效】 ← 這一句才是在測 family 撤銷
```

### 陷阱 3：登出測試斷言錯了東西

斷言「回應 204」或「前端回到登入頁」，證明的是狀態碼與前端狀態，
不是伺服器上那張票死了（§6 第 3 條：狀態碼對、最終狀態也對，錯的是中途）。
必要的形狀：

```
登出 → 拿【同一張】refresh token 去 /api/auth/refresh → 必須 401
```

### 陷阱 4：刻意的缺口沒有測試，就會被無聲地「修好」

§4 那個 15 分鐘的視窗必須有一條**斷言它存在**的測試：

```
登出 → 舊的 access token 在 15 分鐘內【仍然】能打 /api/me → 200
```

寫成測試看起來很怪（在測一個弱點），但它是這份規格裡唯一能阻止
「順手加一次 DB 查詢」悄悄發生的東西。測試名稱要直說這是刻意的。

### 突變清單（每一個都要實際跑過、結果寫回計畫）

| 突變 | 必須變紅的測試 |
|---|---|
| 拿掉 `used_at` 檢查 | 陷阱 1 的形狀 |
| family 撤銷改成只撤銷單列 | 陷阱 2 的形狀 |
| `logout` 改成只回 204 不寫 `revoked_at` | 陷阱 3 的形狀 |
| `decode_refresh_token` 的 `require` 拿掉 `jti` | §7 的既有 token 測試 |

> **這一條原本是錯的預測，實作時實測推翻。** 拿掉 `require` 裡的 `jti` 之後
> 套件仍然全綠 —— 因為 `payload["jti"]` 的 `KeyError` 被 `except` 接住，
> 拋出的還是同一個 `TokenError`。**兩道防線互相掩護（§6 第 5 種），
> 於是這個性質從來沒有被任何單一守衛釘住過。**
>
> 修法是設計層的，不是測試層的（§6 規矩 5）：把 `except` 收窄成只接
> `ValueError`。`require` 負責「有沒有」，`except` 只負責「格式對不對」，
> 兩者不再重疊，這一列的突變才真的會變紅。
| 登入時每次都用同一個 `family_id` | 跨裝置隔離測試（登出手機不該登出桌機） |

---

## 7. 上線：既有 token 一律失效

部署當下，所有已發出的 refresh token 都沒有 `jti`，查不到對應的 session 列。

**行為必須是明確的失效，不是容錯。** `decode_refresh_token` 的
`options={"require": [...]}` 加上 `"jti"`，缺 `jti` 的 token 在解碼階段
就拋 `TokenError`。

後果：**上線後所有人要重新登入一次。** 這是一次性的、可接受的，
但必須寫進部署手冊 —— 否則它會表現成「升級後神秘的全員登出」，
而那種症狀沒人會聯想到這次變更。

不做向後相容的理由：相容期間等於這個缺陷還開著，而相容邏輯本身
（「沒有 jti 就放行」）是一條明確的繞道，日後忘記拿掉就是永久的後門。

---

## 8. 完成標準

- [ ] `refresh_sessions` 表 + migration `0007`，`alembic check` 乾淨
- [ ] 輪替：換發後舊票 401
- [ ] 重用偵測：三層鏈驗證 family 一起撤銷
- [ ] `logout` / `logout-all`，含跨裝置隔離測試
- [ ] §4 那個 15 分鐘缺口有明確斷言它存在的測試
- [ ] 缺 `jti` 的 token 被拒
- [ ] `cleanup-sessions` 指令 + 部署手冊的 cron 與**全員重新登入**的上線備註
- [ ] §6 突變清單全部實際跑過，結果寫回計畫文件
- [ ] `pytest -W error` 全綠、ruff、mypy strict、覆蓋率不低於現況
