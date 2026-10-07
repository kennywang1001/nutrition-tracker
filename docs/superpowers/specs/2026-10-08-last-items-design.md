# 最後幾件：管理員建立公開食物、液體顯示 ml、報表確認框焦點

**狀態：** 已實作（使用者授權「剩下的待辦用推薦的做法做完」，2026-10-08）
**前置：** 趨勢的期間切換已合併（master `61bb1f1`）

## 1. 範圍

- handover §8.2「建立全域食物只有 API，沒有 UI」——`POST /api/foods` 的 `is_global` 管理員限定，`/foods/new` 只建私人食物。
- handover §8.2「記一餐的餐點清單對液體仍顯示 g」——`MealItemResponse` 沒有帶 `base_unit`。
- 上一包審查留下的：報表頁的刪除確認框沒有移動焦點。

## 2. 決定（推薦的做法）

| 項目 | 做法 |
|---|---|
| 公開食物 | `/foods/new` 對管理員多一個勾選「公開到共用食物庫（所有人都看得到）」，預設不勾；勾了送 `is_global: true`。一般使用者看不到這個勾選（後端仍是授權的唯一依據）。AI 面板存出的食物不受影響（照舊私人） |
| 液體單位 | `MealItemResponse` 與好友的 `FriendMealItem` 多 `base_unit`（`"g"`／`"ml"`，取項目釘住的那個 revision 的 `base_unit`——同營養素的凍結規則）。飲食頁卡片、編輯畫面的項目、好友卡片顯示 `{數字} {base_unit}`。欄位名 `quantity_g` 不改（改名是破壞性的 API 變更） |
| 報表確認框 | 同編輯畫面：打開時焦點到「取消」，取消後回到「刪除」按鈕（用 `lib/use-confirm-focus.ts`） |

## 3. 測試

- 後端：`MealItemResponse.base_unit` 跟著 revision（ml 的食物 → `"ml"`；食物後來的新版本改成 g，舊紀錄仍是 ml）；
  好友的餐也帶；`schema.d.ts` 重新產生。
- 前端：管理員看得到勾選、勾了送 `is_global: true`、一般使用者沒有勾選且不送；三個地方顯示 ml；報表確認框焦點。
- 既有測試的假資料若因型別要求補 `base_unit`，那是刻意的改變。

## 4. 交付

後端（`base_unit`）→ 前端（三件）→ 交接文件。不用 migration。
