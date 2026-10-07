# 上線前的安全補強：換票與登出限速、只有 401 才登出、一餐一筆餐費、公克數範圍

**狀態：** 設計定稿，待寫實作計畫
**日期：** 2026-10-07
**前置：** 好友關係已合併（master `f751007`）

---

## 1. 目標與範圍

### 1.1 為什麼要做

這一批功能要一起部署之前，把交接文件裡標成「仍需優先處理」與幾個已知會 500 的洞補掉：

1. **`/api/auth/refresh` 與 `/api/auth/logout` 沒有限速**（handover §8.1b）。兩者不需認證、可無限重放，
   而且都會取每使用者的 advisory lock。實測：12 條並行連線拿同一張**早就死掉的** refresh token 重放
   `/logout`，每秒 302 次，把同一個使用者的合法換發從中位數 7.2ms 拉到 34.2ms。
2. **前端換票時，任何非成功的回應都會登出**（這次查到的）。加了限速之後，429 會讓正常使用者被踢出；
   更大的問題是現在就有——NAS 部署重啟那幾秒，正在換票的人收到 502 全被登出。
3. **一餐可能有兩筆餐費**（handover §8.2）：兩個請求同時替同一餐「補金額」，`expenses.meal_id` 沒有唯一約束。
4. **公克數超出 `Numeric(8,2)`**（handover §8.2）：份量（≤10000 g）× 數量（≤10000）可以到一億，
   asyncpg `DataError` → 500。新增一餐、加一項、改一項都有。
5. **公克數四捨五入成 0**（這次查到的）：份量 0.01 g × 數量 0.01 = 0.0001 → 0.00，撞上
   `CHECK (quantity_g > 0)` → 500。

### 1.2 明確不做

- 登入以外的端點限速、依 IP 限速（所有請求都經過 Tailscale 與 Caddy，後端看到的 IP 幾乎都一樣）。
- 計數器持久化（單一容器、重啟歸零——handover 已記）。
- 同一餐同時補金額的「自動合併」。

---

## 2. 已經做出的決定

| 決定 | 選項 | 理由 |
|---|---|---|
| 範圍 | 交接文件的三件**加上**「只有 401 才登出」與「公克數變 0」（使用者選 A） | 前者不做，限速反而讓人被登出；後者跟「太大」是同一行程式的兩端 |
| 同時補金額 | 第二個請求 **409**，請他重新整理（A） | 極少見；自動合併要在 rollback 後重做整個請求 |
| 限速的做法 | **新的通用限速器**，鍵是 token 的 `sub`（A） | 登入的限速器只算失敗、成功就重置——換票要算每一次；IP 在這個架構沒有意義 |

---

## 3. 後端

### 3.1 `/refresh`、`/logout` 限速

`app/ratelimit.py` 新增 `KeyedRateLimiter`：固定視窗，每個鍵每個視窗最多 N 次，**每一次 `hit` 都算**。

```python
class KeyedRateLimiter:
    def __init__(self, *, limit: int, window_seconds: float, code: str, message: str,
                 clock: Callable[[], float] = time.monotonic) -> None: ...
    def hit(self, key: str) -> None:   # 超過就丟 TooManyRequestsError（附 retry_after_seconds）
    def reset(self) -> None: ...
```

實例 `session_rate_limiter`：**每個使用者每 60 秒 10 次**，`code="TOO_MANY_SESSION_REQUESTS"`、
`message="操作太頻繁，請稍後再試"`。`/refresh` 與 `/logout` 共用（鍵是 `str(user_id)`）。

兩個端點的順序：

1. **先驗 token 的簽章與期限**（`decode_refresh_token`），取 `sub`。驗不過 → 照現在的行為
   （`/refresh` 401、`/logout` 204）。**不計數**：驗簽是 HMAC，不碰資料庫、不取鎖，本來就便宜。
2. `session_rate_limiter.hit(str(claims.user_id))`——超過 → `429` ＋ `Retry-After`。
3. 才呼叫 `rotate_session`／`revoke_session`（資料庫、advisory lock）。

`sub` 是 token 自己聲稱的，但簽章驗過了，偽造不了；攻擊者能消耗的只有**他手上那張票**所屬使用者的額度——
最壞是那個使用者一分鐘內換不了票（§4.1 讓這不會變成登出）。

`tests/conftest.py` 的 autouse fixture 每個測試都重置它（同 `login_rate_limiter`）。

### 3.2 一餐最多一筆餐費

**migration `0015`：**

1. 先查重複：`SELECT meal_id, count(*) FROM expenses WHERE meal_id IS NOT NULL GROUP BY meal_id HAVING count(*) > 1`。
   有的話 **migration 失敗**（`RuntimeError`），訊息列出那些 `meal_id`，並說「這是錢的紀錄，不自動刪；
   在報表裡刪掉多的那筆再升級」。
2. 刪 `ix_expenses_meal_id`，建**部分唯一索引** `uq_expenses_meal_id ON expenses (meal_id) WHERE meal_id IS NOT NULL`
   （它同時服務 `ON DELETE SET NULL` 的查找）。模型同步（`Index(..., unique=True, postgresql_where=...)`）。

**`PATCH /api/meals/{id}`**：補金額（原本沒有餐費）撞上唯一約束 → `IntegrityError` → `rollback` →
`409 MEAL_COST_CONFLICT`「這一餐的金額剛被另一台裝置改過，請重新整理再試」。同一個請求裡的其他改動
（餐別、備註、`is_private`）一起 rollback。

`_costs_by_meal`、`update_meal` 裡「萬一一餐有兩筆，取 id 最小的」的防禦說明改成「資料庫保證最多一筆」
（`order_by(Expense.id)` 留著，無害）。

### 3.3 公克數範圍

`_quantity_g`（新增一餐、加一項、改一項共用）換算完之後：

```python
if not (QUANTITY_G_MIN <= quantity_g <= QUANTITY_G_MAX):   # 0.01 與 999999.99（Numeric(8,2)）
    raise UnprocessableEntityError(
        "QUANTITY_OUT_OF_RANGE",
        "換算後的公克數超出範圍（0.01 到 999,999.99 g），請改數量",
    )
```

沒有份量時 `quantity` 就是公克數，欄位限制（`gt=0, le=10000, decimal_places=2`）已經保證在範圍內——
檢查放在函式最後，兩條路都經過，不分支。

---

## 4. 前端

### 4.1 只有 401 才登出

`frontend/src/auth/refresh.ts` 的 `performRefresh`：

- `response.status === 401` → 清 token、清快取、回 `false`（現在的行為）。
- 其他非成功（429、5xx、代理的錯誤頁）→ **保留 token**、回 `false`。
- `fetch` 本身丟例外（網路斷線）→ **保留 token**、回 `false`。

回 `false` 時，`fetchWithAuthRetry` 交回原本那個 401，畫面照常顯示錯誤；下一次請求會再試換票。

### 4.2 錯誤訊息

- 記一餐（`LogMeal.tsx`）、編輯這一餐的項目（`EditMealItems.tsx`）：`QUANTITY_OUT_OF_RANGE` → 顯示後端訊息。
- 編輯這一餐（`EditMeal.tsx` 的 `describeSaveError`）：`MEAL_COST_CONFLICT` → 顯示後端訊息，並失效這一餐的
  query（`queryKeys.meal(id)`），金額欄位換成另一台存的值。

---

## 5. 測試

### 5.1 後端

- 限速：同一個使用者第 11 次 → 429、`Retry-After` 有值；`/refresh` 與 `/logout` 共用額度；假時鐘過了視窗恢復；
  別的使用者不受影響；簽章不對的 token 打 20 次不計數（之後同一個使用者的正常換票成功）；被擋的請求
  **不呼叫** `rotate_session`／`revoke_session`（spy）。
- 餐費：資料庫直接擋同一個 `meal_id` 的第二筆（`IntegrityError` 指名 `uq_expenses_meal_id`）；`meal_id` 是
  null 的多筆共存；補金額撞上 → 409、同一個請求的其他改動沒有存（monkeypatch 在補之前先插一筆）。
- 公克數：份量 10000 g × 10000 → 422；份量 0.01 g × 0.01 → 422；三條路（新增一餐、加一項、改一項）都驗，
  而且都**沒寫進資料庫**。
- migration 的「有重複就失敗」：測試資料庫從空升級，驗不到——部署前對 dev 資料庫手動跑一次重複查詢。

### 5.2 前端

- refresh：401 清；429、500、網路錯誤不清（`getRefreshToken()` 還在）。既有的測試照樣綠。
- 記一餐、編輯項目：`QUANTITY_OUT_OF_RANGE` 顯示後端訊息。
- 編輯：`MEAL_COST_CONFLICT` 顯示訊息、這一餐被重新抓。

---

## 6. 交付

1. 後端：`KeyedRateLimiter`、`/refresh` 與 `/logout` 限速
2. 前端：只有 401 才登出
3. 後端＋前端：一餐一筆餐費（migration `0015`、409、顯示並重抓）
4. 後端＋前端：公克數範圍（422、顯示）
5. 交接文件（§8.1b、§8.2 改成已完成）、部署手冊（`0015` 與「有重複就失敗」的處理）

**部署：有 migration（`0015`）。** 升級前先在 NAS 上跑 §3.2 的重複查詢；有結果就先處理。
