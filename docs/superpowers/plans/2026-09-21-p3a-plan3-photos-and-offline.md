# P3-A 計畫三：照片與離線

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 P3-A 收尾 —— 今天吃了哪幾餐、每一餐可以拍照、離線時看得到最後一次的資料而且知道它是舊的。

**Architecture:** 餐點清單走 `GET /api/meals`（同樣不傳 `date`）。照片**不是 URL** —— 要帶 token 取 blob，而且卸載時要 `revokeObjectURL`。離線 L2 用 TanStack Query 的持久化，**不用 Workbox 快取 API 回應**（理由見 Task 4）。

**Tech Stack:** TanStack Query + persistQueryClient · Playwright

**規格：** [docs/superpowers/specs/2026-09-11-p3a-frontend-design.md](../specs/2026-09-11-p3a-frontend-design.md)
**前兩份計畫：** [計畫一](2026-09-14-p3a-plan1-foundation-and-login.md) · [計畫二](2026-09-15-p3a-plan2-daily-loop.md)

---

## 範圍

| | 內容 |
|---|---|
| **這一份** | 今日餐點清單 · 照片顯示 · 照片上傳 · 離線 L2 · 兩條契約 E2E |
| 之後 | Task 1 的 HTTPS 與兩個真機驗證（待 NAS）；P3-B 的趨勢圖 / 食物庫 / 管理員審核 |

**為什麼先做餐點清單：** 照片要附在某一餐上，而目前沒有任何畫面看得到「今天吃了哪幾餐」—— 記一餐之後就消失了。清單本身也是「看今天吃了什麼」的一半（另一半是計畫二做的營養素總計）。

---

## 前提

- 計畫二已合併（PR #8）。master 上：後端 **503**、前端 **108**、E2E **4 條**，CI 全綠。
- dev 環境：`docker compose up -d`、`cd frontend && npm run dev`。
- dev 帳號：`kenny.demo@example.com` / `demo-pass-12345`。dev 資料庫有 1 張含 GPS 但已去除 EXIF 的照片。

---

## 前兩份計畫的教訓，帶著走

計畫一 11 個缺陷、計畫二 4 個。其中**兩類重複出現過**：

1. **「工具跑了、回報成功，但它從來沒看過那個東西」** —— `tsc -b` 不看 `tests/`、`typecheck` 指到空殼 tsconfig、Vitest 吃掉 Playwright 的檔案、Biome 讀不到根 `.gitignore`。**新加任何測試檔或產出目錄，都要用突變確認它真的被檢查。**
2. **「Files 清單與內文是兩個講同一件事的地方」** —— 兩次都漂移了（計畫一的 react-router、計畫二的 `App.tsx`）。

**所以這份計畫沒有 Files 清單。** 每個 task 的檔案由 step 裡的路徑決定，只有一個來源。

還有一個計畫二剛學到的：

3. **綠燈也要問「它為什麼綠」。** `invalidateQueries` 那條 E2E 曾經因為 remount 自動重取而通過，跟被測的性質無關。**每個突變都要實際跑，而且跑出來不符預期就深究，不要改測試去迎合。**

---

### Task 1：今日餐點清單

- [ ] **Step 1: 寫失敗的測試**

Create `frontend/tests/meal-list.test.tsx`（`wrap` / `mockApi` / `json` 從**目前版本**的 `tests/today.test.tsx` 複製 —— 注意 `mockApi` 用的是 `Object.entries(...).find(...)?.[1]`，不是更早的 `routes[match]!()`）：

```tsx
const MEALS = [
	{
		id: 11,
		eaten_at: "2026-09-21T12:30:00+08:00",
		meal_type: "lunch",
		note: null,
		photo_path: "3/abc123.jpg",
		items: [
			{
				id: 1,
				food_id: 3,
				food_name: "滷肉飯",
				portion_id: null,
				quantity: "200.00",
				quantity_g: "200.00",
				kcal: "440.00",
				protein_g: "13.00",
				fat_g: "14.00",
				carb_g: "44.00",
			},
		],
		kcal: "440.00",
		protein_g: "13.00",
		fat_g: "14.00",
		carb_g: "44.00",
	},
	{
		id: 12,
		eaten_at: "2026-09-21T19:00:00+08:00",
		meal_type: "dinner",
		note: null,
		photo_path: null,
		items: [],
		kcal: "0.00",
		protein_g: "0.00",
		fat_g: "0.00",
		carb_g: "0.00",
	},
];

describe("今日餐點清單", () => {
	it("不傳 date 參數——日界線由伺服器決定", async () => {
		// 跟 /api/stats/daily 同一條規矩（計畫二 Task 4）。後端的
		// `list_meals` 省略 date 時走 today_in_timezone(user.timezone)，
		// 跟 stats/daily 與 supplements/today 是同一個函式。
		const fetchMock = mockApi({ "/api/meals": () => json(MEALS) });

		render(wrap(<MealList />));
		await screen.findByText("滷肉飯");

		const call = fetchMock.mock.calls.find(([input]) => String(input).includes("/api/meals"));
		expect(String(call?.[0])).toBe("/api/meals");
	});

	it("列出每一餐的項目與熱量", async () => {
		mockApi({ "/api/meals": () => json(MEALS) });

		render(wrap(<MealList />));

		expect(await screen.findByText("滷肉飯")).toBeInTheDocument();
		expect(screen.getByText(/440/)).toBeInTheDocument();
	});

	it("photo_path 不會被當成網址塞進 img", async () => {
		// **規格 §5.2：`photo_path` 是伺服器端的相對路徑，不是 URL。**
		// 它唯一的用途是判斷「這一餐有沒有照片」。真的要拿到圖必須打
		// GET /api/meals/{id}/photo，而那個端點會先驗 JWT 與擁有權。
		//
		// 直接塞進 <img src> 的話：瀏覽器會對 /3/abc123.jpg 發一個沒有
		// Authorization 的請求，回 404（SPA fallback 的話更糟——回 HTML）。
		mockApi({ "/api/meals": () => json(MEALS) });

		render(wrap(<MealList />));
		await screen.findByText("滷肉飯");

		// **不要用 `getByRole("img")`（計畫原本就是這樣寫的，錯的）。**
		// ARIA 規則下 `alt=""`（裝飾用圖片）會把 img 的 role 改成
		// presentation，於是它從 accessibility tree 消失、
		// `queryAllByRole("img")` 找不到它 —— 這條守衛就瞎了。
		//
		// 實測踩過：用 `<img src={photo_path} alt="" />` 做突變時，
		// 原本的寫法「巧合地」通過了。改成直接斷言那個字串從來沒有進到
		// DOM 之後，同一個突變才會紅。
		//
		// 這是這個性質最直接的表達：photo_path 不該被渲染成任何東西的網址。
		expect(document.body.innerHTML).not.toContain("abc123.jpg");
	});

	it("沒有照片的餐不顯示照片區塊", async () => {
		mockApi({ "/api/meals": () => json(MEALS) });

		render(wrap(<MealList />));
		await screen.findByText("滷肉飯");

		// photo_path 為 null 的那一餐（id 12）不該有任何照片相關的東西
		expect(screen.queryByTestId("meal-photo-12")).not.toBeInTheDocument();
		expect(screen.getByTestId("meal-photo-11")).toBeInTheDocument();
	});
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `cd frontend && npm run test` → 找不到 `MealList`

- [ ] **Step 3: 實作**

Create `frontend/src/screens/MealList.tsx`。**行為要求**：

- `useQuery` 取 `/api/meals`（**不帶參數**）
- 每一餐顯示時間（用 `lib/dates.ts` 的 `formatTime`）、餐別、項目清單、熱量
- `photo_path !== null` → 顯示照片區塊（`data-testid="meal-photo-{id}"`），**這個 task 先放一個佔位的「有照片」標示，Task 2 才真的取圖**
- `photo_path === null` → 不顯示照片區塊

`src/api/queries.ts` 加 `queryKeys.meals = ["meals"] as const`。

`src/screens/Today.tsx` 把 `<MealList />` 放在營養素總計下面。

**記一餐送出成功後也要讓 `queryKeys.meals` 失效** —— `src/screens/LogMeal.tsx` 的 `onSuccess` 加一行。

> **那一行跟 `dailyStats` 那一行是同一類，而且同樣沒有單元測試守得到**
> （計畫二 Task 5 已經確認過）。Task 5 的 E2E 會一起守。

- [ ] **Step 4: 驗證與突變**

```bash
cd frontend && npm run lint && npm run typecheck && npm run test && npm run build
npx playwright test        # 預期 4 passed（前兩份的）
```

| 突變 | 預期變紅 |
|---|---|
| `/api/meals` 加上 `?date=...` | 「不傳 date 參數」 |
| 把 `photo_path` 直接當成 `<img src>` | 「photo_path 不會被當成網址」。**突變時用 `alt=""`** —— 那是最容易逃掉的形式（見上面的說明），也是 Task 2 最可能真的寫出來的形式 |
| `photo_path === null` 也顯示照片區塊 | 「沒有照片的餐不顯示照片區塊」 |

- [ ] **Step 5: Commit**

```bash
git add frontend/
git commit -m "feat: 今日餐點清單

不傳 date 參數，跟 /api/stats/daily 同一條規矩：後端的 list_meals 省略
date 時走 today_in_timezone(user.timezone)。

photo_path 只當成「有沒有照片」的布林判斷，不當網址——它是伺服器端的
相對路徑，直接塞進 img src 會發一個沒有 Authorization 的請求。"
```

---

### Task 2：照片顯示 —— blob、token、以及那個不會有人發現的記憶體洩漏

規格 §5.2：`GET /api/meals/{id}/photo` **需要認證**，回 `image/jpeg` 的位元組。**不能當成靜態 URL 塞進 `<img src>`。**

- [ ] **Step 1: 寫失敗的測試**

Create `frontend/tests/meal-photo.test.tsx`:

```tsx
describe("useMealPhoto", () => {
	it("帶著 Authorization 取圖", async () => {
		const fetchMock = mockApi({
			"/api/meals/11/photo": () =>
				new Response(new Blob(["fake-jpeg"], { type: "image/jpeg" }), {
					status: 200,
					headers: { "content-type": "image/jpeg" },
				}),
		});

		const { result } = renderHook(() => useMealPhoto(11), { wrapper: QueryWrapper });
		await waitFor(() => expect(result.current.objectUrl).not.toBeNull());

		const call = fetchMock.mock.calls.find(([input]) => String(input).includes("/photo"));
		expect(new Headers(call?.[1]?.headers).get("authorization")).toBe("Bearer a");
	});

	it("卸載時釋放 object URL", async () => {
		// **沒有這條測試，這個洩漏永遠不會有人發現。**
		// 每一個 createObjectURL 都在文件的生命週期裡佔著那個 blob，
		// 直到 revoke 或整頁關掉。清單頁滑動幾十張照片之後，
		// 手機上的分頁會被系統殺掉——而那看起來像「app 很爛」，
		// 不像「有一行 revokeObjectURL 沒寫」。
		const revoke = vi.spyOn(URL, "revokeObjectURL");
		mockApi({
			"/api/meals/11/photo": () =>
				new Response(new Blob(["fake-jpeg"], { type: "image/jpeg" }), { status: 200 }),
		});

		const { result, unmount } = renderHook(() => useMealPhoto(11), { wrapper: QueryWrapper });
		await waitFor(() => expect(result.current.objectUrl).not.toBeNull());
		const url = result.current.objectUrl;

		unmount();

		expect(revoke).toHaveBeenCalledWith(url);
	});

	it("404 時 objectUrl 是 null，不是壞掉的 URL", async () => {
		// DB 有 photo_path 但檔案不在磁碟上，是後端正常操作下可達的狀態
		// （delete_photo 是 best-effort），後端會回 404 MEAL_PHOTO_NOT_FOUND。
		mockApi({
			"/api/meals/11/photo": () =>
				new Response(
					JSON.stringify({
						error: { code: "MEAL_PHOTO_NOT_FOUND", message: "這一餐沒有照片", details: {} },
					}),
					{ status: 404, headers: { "content-type": "application/json" } },
				),
		});

		const { result } = renderHook(() => useMealPhoto(11), { wrapper: QueryWrapper });

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.objectUrl).toBeNull();
	});
});
```

> `renderHook` 來自 `@testing-library/react`。`QueryWrapper` 是一個包了
> `QueryClientProvider` 的小元件 —— 從 `today.test.tsx` 的 `wrap` 改寫。

- [ ] **Step 2: 跑測試確認它失敗**

- [ ] **Step 3: 實作**

Create `frontend/src/api/photos.ts`：

```ts
/** 取一餐的照片，回一個可以塞進 `<img src>` 的 object URL。
 *
 *  **為什麼不能直接用 `/api/meals/{id}/photo` 當 `<img src>`：**
 *  那個端點需要 `Authorization` 標頭（規格 §5.2），而 `<img>` 發的請求
 *  帶不了自訂標頭。後端刻意不掛 `StaticFiles` —— 掛上去的那一刻所有
 *  照片就對所有人公開了，而且既有測試不會變紅（有一個路由表內省的
 *  測試專門守這件事）。
 *
 *  **卸載時一定要 `revokeObjectURL`。** 每一個 `createObjectURL` 都在
 *  文件的生命週期裡佔著那個 blob，直到 revoke 或整頁關掉。清單頁滑過
 *  幾十張照片之後，手機上的分頁會被系統殺掉 —— 而那看起來像「app 很爛」，
 *  不像「有一行沒寫」。
 */
```

**行為要求**（讓三條測試通過）：

- 用 `useQuery` 取 blob（`queryKey: ["meals", mealId, "photo"]`）
- `queryFn` 用 `apiFetch` 拿不到 —— 它會對 body 呼叫 `.json()`。**需要一個回 blob 的變體**：自己 `fetch` + 帶 token + 失敗時走 `parseErrorResponse`
- 用 `useEffect` 在 blob 變動或元件卸載時 `URL.revokeObjectURL`
- 回 `{ objectUrl: string | null, isError: boolean }`

> **`apiFetch` 需要一個 blob 變體，這是計畫沒預料到就會踩的地方。**
> `src/api/client.ts` 的 `parseBody` 一律 `.json()`。**不要為了照片去改
> `apiFetch` 的行為** —— 那會讓所有呼叫端都要處理一個它們用不到的分支。
> 抽一個共用的「帶 token + 401 重送」內核，讓 `apiFetch` 與
> `fetchPhotoBlob` 各自決定怎麼解 body。
>
> **這一步會動到 `client.ts`，而它有 7 條既有測試。改完那 7 條必須全綠。**

`MealList.tsx` 把 Task 1 的佔位標示換成真的 `<img src={objectUrl}>`。

- [ ] **Step 4: 驗證與突變**

| 突變 | 預期變紅 |
|---|---|
| 拿掉 `revokeObjectURL` 的 `useEffect` 清理 | 「卸載時釋放 object URL」 |
| `fetchPhotoBlob` 不帶 `Authorization` | 「帶著 Authorization 取圖」 |
| 404 時仍然 `createObjectURL`（對錯誤的 body） | 「404 時 objectUrl 是 null」 |

**`client.ts` 的 7 條既有測試也要全綠** —— 重構那個內核時最容易在這裡出事。

- [ ] **Step 5: 手動驗證**

`npm run dev` → 登入 → 今日總覽。dev 資料庫有一張真的照片（含 GPS 但已去除 EXIF）。**確認它真的顯示出來。**

如果今天沒有那一餐，用 `curl` 查哪一天有：

```bash
TOKEN=$(curl -s -X POST http://localhost:8000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"kenny.demo@example.com","password":"demo-pass-12345"}' | python -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
curl -s "http://localhost:8000/api/meals?date=2026-09-08" -H "Authorization: Bearer $TOKEN" | python -m json.tool | grep -A2 photo_path
```

（那一天有照片的話，暫時把 `MealList` 的 query 改成帶那個 date 看一眼，**看完改回來**。）

- [ ] **Step 6: Commit**

---

### Task 3：照片上傳

- [ ] **Step 1: 寫失敗的測試**

Create `frontend/tests/meal-photo-upload.test.tsx`。四條：

```tsx
it("上傳時用 multipart，欄位名是 file", async () => {
	// 後端的簽章是 `file: UploadFile = File(...)` —— 欄位名寫錯的話
	// FastAPI 會回 422 VALIDATION_ERROR，而那個錯誤訊息不會直接說
	// 「你的欄位名叫錯了」。
});

it("超過 10MB 的檔案在前端就被擋下來，不會送出", async () => {
	// 後端有 PHOTO_TOO_LARGE（413），所以這不是不信任後端 ——
	// 是不要讓手機在慢速連線上傳了 30 秒才被拒。
	// MAX_PHOTO_BYTES = 10 * 1024 * 1024。
});

it("上傳成功後讓餐點清單與今日總覽失效", async () => {
	// 照片不影響營養素，但 MealResponse 的 photo_path 變了 ——
	// 清單要重取才看得到照片。
});

it("後端回 INVALID_PHOTO 時顯示的是「無法識別的圖片」", async () => {
	// 422 INVALID_PHOTO。前端先降尺寸之後理論上不會發生，
	// 但「理論上不會發生」的東西如果讓畫面白掉，代價不對稱。
});
```

**完整的測試內容由實作者照這四條的意圖寫**，計畫不逐字提供 —— 上傳的測試要建 `File` 物件與 `FormData`，寫法跟 jsdom 的版本有關，我不知道你裝到的版本怎麼處理。**意圖在註解裡，斷言自己寫。**

> **⚠️ 先處理一件會讓這四條測試全部寫不出來的事：jsdom 沒有 canvas。**
>
> 下面的實作要用 `<canvas>` 把照片降尺寸，而 **jsdom 沒有實作 canvas 的
> 繪圖 context** —— `canvas.getContext("2d")` 會回 `null`（或在有些版本
> 直接丟「not implemented」）。所以只要上傳流程裡直接呼叫 canvas，
> 那四條測試會在降尺寸那一步就炸掉，跟它們要驗的東西無關。
>
> **把降尺寸抽成一個獨立的函式**（例如 `src/lib/resize-image.ts` 的
> `shrinkToLongestEdge(file, maxEdge)`），上傳流程只呼叫它。測試裡
> `vi.mock` 掉那個模組，讓它原樣回傳傳進去的 `File`。
>
> **那代表降尺寸本身沒有單元測試 —— 這是刻意接受的，要如實記下來。**
> 它需要真的 canvas，只有瀏覽器（Playwright 或手動）驗得到。
> 這跟前兩份計畫的「service worker 在 jsdom 不註冊」「`navigator.locks`
> 在 jsdom 不存在」是同一個家族：**測試環境裡沒有那個東西**。
>
> 不要為了讓它「有測試」而去 mock canvas 的 API —— 那會測到
> 「我對 canvas API 的假設」，不是「降尺寸真的有效」。

- [ ] **Step 2: 實作**

**行為要求：**

- `<input type="file" accept="image/*" capture="environment">` —— `capture` 讓手機直接開相機
- **送出前先檢查大小**，超過 `10 * 1024 * 1024` 直接擋並顯示訊息
- **送出前用 canvas 降尺寸**（長邊 1280，跟後端一致），**抽成
  `src/lib/resize-image.ts` 的獨立函式**（見上面 jsdom 的說明）
  > 手機拍出來的原圖經常超過 10MB。降尺寸**不是為了取代伺服器的處理** ——
  > EXIF 去除仍然由伺服器負責，那是安全邊界，不能交給 client。
  > 前端降尺寸只是為了不要在慢速連線上白傳 30 秒。
- `POST /api/meals/{id}/photo`，`FormData` 欄位名 `file`
- 成功後 invalidate `queryKeys.meals` 與該餐的照片 key
- 錯誤：`PHOTO_TOO_LARGE`（413）、`INVALID_PHOTO`（422）各自顯示對應訊息

- [ ] **Step 3: 驗證與突變**

| 突變 | 預期變紅 |
|---|---|
| `FormData` 的欄位名改成 `photo` | 「欄位名是 file」 |
| 拿掉前端的大小檢查 | 「超過 10MB 在前端就被擋下來」 |
| 上傳成功後不 invalidate | 「讓餐點清單失效」 |
| `shrinkToLongestEdge` 直接回傳原檔（不降尺寸） | **預期沒有東西變紅** —— 測試把它 mock 掉了。這一條只有 Step 4 的手動驗證（上傳後 `size_download` 明顯變小）守得到。如實回報 |

- [ ] **Step 4: 手動驗證 —— 真的上傳一張**

`npm run dev` → 記一餐 → 在清單上傳一張照片 → **確認它顯示出來**，然後用 curl 確認後端真的存了：

```bash
curl -s -o /tmp/check.jpg -w "%{http_code} %{size_download}\n" \
  "http://localhost:8000/api/meals/<id>/photo" -H "Authorization: Bearer $TOKEN"
```

**預期 200，而且 size 明顯小於你上傳的原圖**（後端縮到長邊 1280 並重新編碼）。

- [ ] **Step 5: Commit**

---

### Task 4：離線 L2

規格 §8：L2 是「讀取離線：快取最近一次的今日總覽、常吃/最近吃清單」，而且**快取的資料一律標示「離線資料，最後更新於 X」**。

> **顯示陳舊數字而不說明它是陳舊的，比不顯示更糟。**

#### 一個要修正規格措辭的設計決定

規格 §8 寫「L2 用 TanStack Query 的持久化 **+ Workbox 的 runtime caching**」。

**這份計畫只用前者，不用 Workbox 快取 API 回應。** 理由：

Workbox 在 service worker 層快取 HTTP 回應。離線時它把快取的回應交給 `fetch`，而 TanStack Query 收到一個 200 就把它當成**新鮮的資料** —— `dataUpdatedAt` 是「剛剛」。**那正好讓陳舊資料看起來是新的**，也就是規格自己警告的那件事。

TanStack Query 的持久化不一樣：它存的是 query 的**狀態**，包含 `dataUpdatedAt`。離線開啟時 hydrate 回來，`dataUpdatedAt` 仍然是上一次真的成功取得的時間 —— 那正是「最後更新於 X」需要的那個值。

**Workbox 仍然負責 app shell（L1，計畫一已經做了）**，只是不碰 `/api/*`。

- [ ] **Step 1: 寫失敗的測試**

Create `frontend/tests/offline.test.tsx`。三條，意圖如下（斷言自己寫）：

```tsx
it("離線時顯示持久化的資料，而不是空白", async () => {
	// 先讓 query 成功一次、persist，然後讓 fetch 一律 reject（模擬離線），
	// 重新 render，確認數字還在。
});

it("資料來自快取時顯示「最後更新於」", async () => {
	// 規格 §8：顯示陳舊數字而不說明它是陳舊的，比不顯示更糟。
	// 斷言畫面上有那個標示，而且它用的是 dataUpdatedAt 不是 Date.now()。
});

it("連線正常時不顯示「最後更新於」", async () => {
	// 這條跟上一條是一對。只有上一條的話，把標示寫成「永遠顯示」
	// 也會綠——而那會讓使用者以為自己一直是離線的。
});
```

- [ ] **Step 2: 實作**

- 裝 `@tanstack/react-query-persist-client` 與 `@tanstack/query-sync-storage-persister`（**以實際裝到的套件名為準**，TanStack 的 persist 套件拆分方式改過，看官方文件）
- 用 `localStorage` 當 persister
  > 不用 IndexedDB：這份要存的是幾個 KB 的 JSON，`localStorage` 夠用而且同步、沒有 async 的啟動順序問題。照片 blob **不快取**（那是 IndexedDB 的量級，而且規格沒要求）—— 離線時照片顯示不出來是可接受的。
- `maxAge` 設 24 小時 —— 超過就不 hydrate
  > 一天前的「今日總覽」已經不是今日了。與其顯示一個標著「最後更新於昨天」的今日總覽，不如顯示空的。
- 在 `Today.tsx` 顯示「離線資料，最後更新於 X」：條件是 `query.isStale && query.isError`（或等價的「這次沒取到、用的是舊資料」）
  > **不要用 `navigator.onLine` 判斷。** 它只知道「有沒有連上網路介面」，不知道「連得到這個後端嗎」 —— 而這個 app 走 Tailscale，`navigator.onLine` 為 true 但 tailnet 不通是完全正常的情況。**用請求實際失敗與否判斷。**

- [ ] **Step 3: 驗證與突變**

| 突變 | 預期變紅 |
|---|---|
| 拿掉 persister | 「離線時顯示持久化的資料」 |
| 「最後更新於」改用 `Date.now()` | 「顯示最後更新於」那條（如果它有斷言時間值的話） |
| 「最後更新於」改成永遠顯示 | 「連線正常時不顯示」 |

- [ ] **Step 4: 手動驗證 —— 這一步只能手動**

`npm run dev` → 登入 → 看到今日總覽 → **開瀏覽器 DevTools 的 Network，切成 Offline** → 重新整理。

**預期：** 數字還在，畫面上有「離線資料，最後更新於 HH:MM」。

> **這一步不能用單元測試代替。** persist 的 hydrate 發生在 app 啟動時，
> 而測試裡的 `render()` 跟真的重新載入頁面不是同一件事。

- [ ] **Step 5: Commit**

---

### Task 5：最後兩條契約 E2E

計畫一 2 條、計畫二 2 條，這份補完最後 2 條（規格 §9.1 的六條）。

- [ ] **Step 1: 寫 E2E**

Append to `frontend/e2e/daily-loop.spec.ts`（或新建 `e2e/photo-and-limits.spec.ts`）：

**第五條：照片上傳 → 帶 token 取回**

```ts
test("照片上傳之後，取回來的是圖不是 404", async ({ page, request }) => {
	// 規格 §9.1。這條守的是「照片端點需要認證」這個後端保證 ——
	// fetch mock 證明不了它。
	//
	// 跟計畫二第一條 E2E 一樣自給自足：自己建食物、記一餐，
	// 因為 CI 的資料庫是空的。
});
```

**第六條：429 倒數**

```ts
test("連續登入失敗 6 次會看到倒數，而且倒數是真的", async ({ page }) => {
	// 後端 PER_EMAIL_LIMIT = 5 / 60 秒，回 429 帶 Retry-After。
	//
	// **用一個不存在的 email，不要用 demo 帳號。**
	// 後端的限速鍵是「送進來的 email 字串本身」，帳號存不存在完全不影響
	// 行為（那是 P4 決定 2，為了不讓人用限速問出「這個 email 有沒有註冊」）。
	// 所以用 nonexistent-429@example.com 就能觸發限速，而且**不會把
	// demo 帳號鎖住 60 秒** —— Playwright 預設跑 2 個 worker，
	// 鎖住 demo 帳號會讓其他 E2E 隨機失敗。
});
```

> **第六條那個 email 的選擇是這條測試能不能跟其他測試並行的關鍵。**
> 它直接來自後端的一個安全決定（限速按送進來的字串算，不查帳號存不存在）——
> 那個決定讓這條測試變得安全，是一個意外的好處。

- [ ] **Step 2: 跑 E2E**

```bash
cd F:/wallet && docker compose up -d
cd frontend && npx playwright test        # 預期 6 passed
```

**如果第六條讓其他測試變得不穩定，那代表限速鎖到了 demo 帳號** —— 回頭檢查那個 email。

> **實作 Task 1 時已經觀察到一次既有的登入不穩定**（2 個 worker 並行、
> 送出鈕停在 disabled、5 秒逾時，重跑就過）。那**不是**限速 ——
> 成功的登入會重置計數。比較可能的原因是後端的
> `MAX_CONCURRENT_HASHES = 2`：Argon2 被刻意限制同時只跑兩個
> （P4 決定 3，為了不讓 NAS 的記憶體爆掉），所以並行登入會排隊。
>
> **第六條 E2E 會連續送 6 次登入**，等於一口氣佔滿那個佇列。
> 如果加進去之後其他測試開始不穩，**先試把 Playwright 的 worker 數降到 1**
> （`playwright.config.ts` 的 `workers: 1`），而不是去動後端的並行上限 ——
> 那個上限是實測出來的（`/api/health` 的最高延遲從 1094ms 降到 153ms），
> 不該為了測試方便而放寬。

- [ ] **Step 3: 突變驗證**

| 突變 | 預期變紅 |
|---|---|
| `fetchPhotoBlob` 不帶 Authorization | 第五條 |
| 登入畫面的 429 分支不設 `cooldown` | 第六條 |

- [ ] **Step 4: 推上去看 CI**

CI 的 `e2e` job 會在 Linux 上跑這六條。**429 那條在 CI 上要特別注意** —— 限速是容器內記憶體的，CI 每次都是新的容器，所以狀態乾淨。但如果 CI 用了多個 worker，兩條測試同時打登入端點可能撞到**全域**限速（20 次/60 秒）。**看 CI 實際跑出來的結果再決定要不要限制 worker 數。**

---

## 完成標準

- [ ] 前端 `lint` / `typecheck` / `test` / `build` 全綠
- [ ] **六條契約 E2E 全綠**，CI 全綠
- [ ] `photo_path` **沒有任何一處被當成 URL 使用**，有測試守著
- [ ] `revokeObjectURL` 有測試守著（那個洩漏不會有人自己發現）
- [ ] 離線時顯示持久化資料 **且標示「最後更新於」**，且連線正常時**不**顯示
- [ ] **手動驗證過**：真的上傳一張照片並看到它、DevTools 切離線後重新整理看到舊資料與標示
- [ ] 各 task 的突變全部實際跑過，結果寫回這份文件
- [ ] 後端 503 個測試不因這份計畫而變動

---

## P3-A 走完之後還剩什麼

- **Task 1 的 HTTPS 與兩個真機驗證** —— 待 NAS。沒有它，PWA 裝不起來、跨分頁鎖不存在
- **P3-B**：趨勢圖、食物庫管理與編輯送審、管理員審核佇列
- **離線 L3（寫入佇列）** —— 規格 §8 列了四個前置條件（日界線、食物版本化、照片、冪等性），其中冪等性要先改後端
- **`/refresh` 與 `/logout` 的限速** —— session 撤銷那輪記在規格 §7.1 的延後項目
