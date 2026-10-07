# 照片縮圖與看大圖 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 上傳時同時存長邊 640 的縮圖（舊照片第一次被要時補做）；照片端點多 `?size=thumb`；飲食頁與好友的餐點卡片顯示縮圖，點了全螢幕看原圖。

**Architecture:** 縮圖的規則全部在 `app/storage/photos.py`（`thumbnail_path`、`read_thumbnail`、存檔與刪除一起處理）；兩個照片端點只多一個 `size` 參數、授權不變；清孤兒指令把縮圖算進「被引用」。前端 `api/photos.ts` 的兩個 hook 多一個 `size`，新元件 `ZoomablePhoto` 包住縮圖、按下才抓原圖。

**Tech Stack:** FastAPI · Pillow · React 19 · TypeScript · TanStack Query · CSS Modules · Vitest · Playwright

**依據規格：** `docs/superpowers/specs/2026-10-07-thumbnails-design.md`

---

## 執行環境

- 分支 `feat/thumbnails`（規格 commit `5f77f25`）。
- 後端在 repo 根目錄：`PYTHONUTF8=1 ./.venv/Scripts/python.exe -m pytest -q`（**一定用 `.venv`**）、`… -m ruff check app tests migrations`、`… -m mypy app`。每個測試的 `settings.photo_dir` 都指到 `tmp_path`（conftest 的 autouse）。
- 前端在 `frontend/`：`npx vitest run tests/xxx`、`npm run -s typecheck`、`npm run -s lint`（格式問題 `npx biome check --write <檔案>`）、`npm run -s test`（**數字是實際的兩倍**）。e2e：`npx playwright test`（後端是本機 docker 的 `wallet-api-1`；後端改了要 `docker compose up -d --build api` 等 healthy）。
- 基準線（master `23dc4f3`）：後端 778；前端 106 檔 1036；e2e 29。
- **Write/Edit；LF**（工作目錄裡有些 `.py` 是 CRLF，寫的時候用 LF，git 會正規化）。不要在 repo 或 scratchpad 以外留備份或暫存腳本。突變用 Edit 改、跑、改回。
- Commit：`git commit -F <scratchpad 裡的檔案>`，結尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不要 stage `lunch.jpg`。不要 amend。

## 開工前必讀

1. 「Expected: FAIL」沒有如預期失敗 → 停下來回報。預測的紅燈數對不上 → 照實回報是哪幾條。
2. 引用的程式碼對不上現況 → 以現況為準並回報。
3. 先寫測試、看它紅，再寫實作。
4. 既有測試如果因為「多了一個縮圖檔」或「卡片改要 `?size=thumb`」而紅，那是**刻意的行為改變**——改那條測試的斷言，照實列出改了哪幾條、為什麼。其他原因的紅燈不准靠改測試解決。

## 開工前已經查證過的事實

| 事實 | 出處 |
|---|---|
| `save_photo(content, *, user_id) -> rel_path`：解碼、擋炸彈、`convert("RGB")`、`_resized(image)`（長邊 ≤ `MAX_DIMENSION` 1280，只縮不放）、存 `<photo_dir>/<user_id>/<uuid>.jpg`（quality 85，不帶 EXIF）；`_assert_within_photo_root(dest, root)` | `app/storage/photos.py:85-135` |
| `read_photo(rel_path)`：讀檔，`FileNotFoundError` 往外丟；`delete_photo(rel_path)`：best-effort（`FileNotFoundError` 忽略、`OSError` 記 log） | 同檔:138-165 |
| `GET /api/meals/{id}/photo`：`_load_owned_meal` → 沒 `photo_path` 404 → `read_photo` → `FileNotFoundError` 轉 404 `MEAL_PHOTO_NOT_FOUND` | `app/api/routes/meals.py:745-770` |
| `GET /api/friends/{fid}/meals/{mid}/photo`：`load_visible_friend` → `shared_meals([friend.id])` → 同樣的讀檔與 404 | `app/api/routes/friends.py:427-445` |
| 換照片、刪照片、刪整餐都呼叫 `delete_photo(old_path)` | `meals.py:490, 731, 802` |
| 清孤兒：`_scan_and_clean(root, referenced_paths, cutoff, dry_run)` 掃 `rglob("*")`，**不在 `referenced_paths` 裡、夠舊的檔案都刪**；`referenced_paths` 是 `meals.photo_path` 的集合 | `app/cli.py:140-210` |
| 測試：`tests/test_photo_storage.py`（`_jpeg_bytes(w, h)`、`_jpeg_with_gps_exif()`）、`tests/test_photo_cleanup.py`（`_write_file(path, *, age_hours)`）、`tests/test_meals_photo.py`、`tests/test_friend_meals.py`（好友照片、`pals` fixture） | 同檔 |
| 前端 `api/photos.ts`：私有 `usePhotoObjectUrl(queryKey, path)`；`useMealPhoto(mealId)` → `queryKeys.mealPhoto(id)`＝`["meal-photo", id]`；`useFriendMealPhoto(friendId, mealId)` → `queryKeys.friendPhoto(fid, mid)`＝`["friend-photo", fid, mid]` | `frontend/src/api/photos.ts`、`api/queries.ts` |
| `MealList.tsx` 的 `MealPhoto`（`data-testid="meal-photo-{id}"`，`objectUrl` 有了才畫 `<img>`、`isError` →「照片無法顯示」）；`FriendMealCard.tsx` 的 `FriendPhoto`；`EditMeal.tsx` 的 `PhotoPreview` 用 `useMealPhoto(mealId)` | 同檔 |
| `frontend/tests/meal-photo.test.tsx` 用 `mockApiByPath` 的 `"/api/meals/11/photo"`（`includes` 比對，`?size=thumb` 照樣命中） | 同檔 |

## 檔案結構

| 檔案 | 負責什麼 |
|---|---|
| `app/storage/photos.py`（改） | `thumbnail_path`、`read_thumbnail`、`read_photo_as`、存與刪一起處理縮圖 |
| `app/api/routes/meals.py`、`app/api/routes/friends.py`（改） | `size` 參數 |
| `app/cli.py`（改） | 清孤兒把縮圖算進被引用 |
| `tests/test_photo_thumbnails.py`（新） | |
| `frontend/src/api/photos.ts`、`api/queries.ts`（改） | `size` |
| `frontend/src/components/ZoomablePhoto.tsx`、`ZoomablePhoto.module.css`（新） | 縮圖按鈕＋全螢幕看原圖 |
| `frontend/src/screens/MealList.tsx`、`frontend/src/components/FriendMealCard.tsx`（改） | 用縮圖＋`ZoomablePhoto` |
| `frontend/tests/zoomable-photo.test.tsx`（新）；`meal-photo.test.tsx`、`friend-feed.test.tsx`、`edit-meal.test.tsx`（只新增測試） | |
| `docs/handover.md`、規格（改） | |

---

## Task 1：後端——縮圖的存、補做、刪除、清孤兒、`?size=thumb`

**Files:**
- Modify: `app/storage/photos.py`、`app/api/routes/meals.py`、`app/api/routes/friends.py`、`app/cli.py`
- Create: `tests/test_photo_thumbnails.py`

- [ ] **Step 1: 寫失敗的測試** `tests/test_photo_thumbnails.py`：

```python
import io
import os
import time
from pathlib import Path

import pytest
from PIL import Image

from app.cli import cleanup_orphan_photos
from app.config import settings
from app.security.tokens import create_access_token
from app.storage import photos
from app.storage.photos import (
    THUMBNAIL_DIMENSION,
    delete_photo,
    read_thumbnail,
    save_photo,
    thumbnail_path,
)
from tests.factories import create_friendship, create_meal, create_user
from tests.test_photo_storage import _jpeg_bytes, _jpeg_with_gps_exif


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


def _root() -> Path:
    return Path(settings.photo_dir)


def _size_of(content: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(content)) as image:
        return image.size


# ---------- 存檔 ----------


def test_the_thumbnail_path_sits_next_to_the_original():
    assert thumbnail_path("7/ab12.jpg") == "7/ab12_thumb.jpg"


def test_saving_writes_a_640px_thumbnail_without_exif():
    rel_path = save_photo(_jpeg_with_gps_exif(), user_id=1)  # 2000×1500，帶 GPS

    thumb = _root() / thumbnail_path(rel_path)
    assert (_root() / rel_path).is_file()
    assert thumb.is_file()
    with Image.open(thumb) as image:
        assert image.size == (THUMBNAIL_DIMENSION, 480)
        assert len(image.getexif()) == 0


def test_a_small_photo_is_not_upscaled_for_its_thumbnail():
    rel_path = save_photo(_jpeg_bytes(300, 200), user_id=1)

    assert _size_of((_root() / thumbnail_path(rel_path)).read_bytes()) == (300, 200)


# ---------- 補做 ----------


def test_an_old_photo_gets_its_thumbnail_made_once(monkeypatch):
    rel_path = save_photo(_jpeg_bytes(2000, 1000), user_id=1)
    (_root() / thumbnail_path(rel_path)).unlink()  # 像這個功能之前上傳的照片
    calls: list[str] = []
    real_write = photos._write_thumbnail

    def counting_write(image, path):
        calls.append(path)
        real_write(image, path)

    monkeypatch.setattr(photos, "_write_thumbnail", counting_write)

    first = read_thumbnail(rel_path)
    second = read_thumbnail(rel_path)

    assert _size_of(first) == (THUMBNAIL_DIMENSION, 320)
    assert first == second
    assert calls == [rel_path]
    assert (_root() / thumbnail_path(rel_path)).is_file()


def test_a_missing_original_is_file_not_found():
    with pytest.raises(FileNotFoundError):
        read_thumbnail("1/nothing-here.jpg")


# ---------- 刪除 ----------


def test_deleting_a_photo_deletes_its_thumbnail_too():
    rel_path = save_photo(_jpeg_bytes(800, 600), user_id=1)

    delete_photo(rel_path)

    assert not (_root() / rel_path).exists()
    assert not (_root() / thumbnail_path(rel_path)).exists()


async def test_replacing_a_photo_deletes_the_old_thumbnail(client, db_session):
    user = await create_user(db_session)
    meal = await create_meal(db_session, user=user)
    first = await client.post(
        f"/api/meals/{meal.id}/photo",
        headers=auth(user),
        files={"file": ("a.jpg", _jpeg_bytes(900, 600), "image/jpeg")},
    )
    old_thumb = _root() / thumbnail_path(first.json()["photo_path"])
    assert old_thumb.is_file()

    await client.post(
        f"/api/meals/{meal.id}/photo",
        headers=auth(user),
        files={"file": ("b.jpg", _jpeg_bytes(900, 600), "image/jpeg")},
    )

    assert not old_thumb.exists()


# ---------- 清孤兒 ----------


def _age(path: Path, hours: float) -> None:
    stamp = time.time() - hours * 3600
    os.utime(path, (stamp, stamp))


async def test_cleanup_keeps_the_thumbnail_of_a_referenced_photo(db_session):
    user = await create_user(db_session)
    rel_path = save_photo(_jpeg_bytes(800, 600), user_id=user.id)
    await create_meal(db_session, user=user, photo_path=rel_path)
    for path in (_root() / rel_path, _root() / thumbnail_path(rel_path)):
        _age(path, 48)

    result = await cleanup_orphan_photos(db_session)

    assert (_root() / thumbnail_path(rel_path)).is_file()
    assert thumbnail_path(rel_path) not in result.deleted


async def test_cleanup_deletes_an_orphan_and_its_thumbnail(db_session):
    rel_path = save_photo(_jpeg_bytes(800, 600), user_id=1)
    for path in (_root() / rel_path, _root() / thumbnail_path(rel_path)):
        _age(path, 48)

    result = await cleanup_orphan_photos(db_session)

    assert set(result.deleted) >= {rel_path, thumbnail_path(rel_path)}


# ---------- 端點 ----------


async def _meal_with_photo(client, db_session, user):
    meal = await create_meal(db_session, user=user)
    await client.post(
        f"/api/meals/{meal.id}/photo",
        headers=auth(user),
        files={"file": ("a.jpg", _jpeg_bytes(2000, 1500), "image/jpeg")},
    )
    return meal


async def test_my_photo_as_a_thumbnail(client, db_session):
    user = await create_user(db_session)
    meal = await _meal_with_photo(client, db_session, user)

    full = await client.get(f"/api/meals/{meal.id}/photo", headers=auth(user))
    thumb = await client.get(
        f"/api/meals/{meal.id}/photo", headers=auth(user), params={"size": "thumb"}
    )

    assert _size_of(full.content) == (1280, 960)
    assert thumb.status_code == 200
    assert thumb.headers["content-type"] == "image/jpeg"
    assert _size_of(thumb.content) == (THUMBNAIL_DIMENSION, 480)


async def test_a_thumbnail_follows_the_same_ownership_rule(client, db_session):
    owner = await create_user(db_session)
    stranger = await create_user(db_session)
    meal = await _meal_with_photo(client, db_session, owner)

    response = await client.get(
        f"/api/meals/{meal.id}/photo", headers=auth(stranger), params={"size": "thumb"}
    )

    assert response.status_code == 404


async def test_an_unknown_size_is_422(client, db_session):
    user = await create_user(db_session)
    meal = await _meal_with_photo(client, db_session, user)

    response = await client.get(
        f"/api/meals/{meal.id}/photo", headers=auth(user), params={"size": "huge"}
    )

    assert response.status_code == 422


async def test_a_friends_thumbnail_and_a_private_one(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    await create_friendship(db_session, alice, bob)
    shared = await _meal_with_photo(client, db_session, alice)
    hidden = await _meal_with_photo(client, db_session, alice)
    await client.patch(f"/api/meals/{hidden.id}", headers=auth(alice), json={"is_private": True})

    ok = await client.get(
        f"/api/friends/{alice.id}/meals/{shared.id}/photo",
        headers=auth(bob),
        params={"size": "thumb"},
    )
    private = await client.get(
        f"/api/friends/{alice.id}/meals/{hidden.id}/photo",
        headers=auth(bob),
        params={"size": "thumb"},
    )

    assert ok.status_code == 200
    assert _size_of(ok.content) == (THUMBNAIL_DIMENSION, 480)
    assert private.status_code == 404
```

> `from tests.test_photo_storage import …` 只匯入那兩個 helper 名字，pytest 不會重複收集那個檔的測試。`create_meal` 的 `photo_path`、`create_friendship` 的參數照 `tests/factories.py` 現況。

- [ ] **Step 2: 跑測試確認失敗**

```
PYTHONUTF8=1 ./.venv/Scripts/python.exe -m pytest tests/test_photo_thumbnails.py -q
```

Expected：收集失敗（`THUMBNAIL_DIMENSION` 等不存在）。

- [ ] **Step 3: 實作**

`app/storage/photos.py`：
1. import 加 `import os`、`from typing import Literal`。
2. `MAX_DIMENSION` 之後加：

```python
# 縮圖（縮圖規格 §3.1）：清單與好友動態用。手機上卡片寬度約 360 CSS px，640 在
# 兩倍密度的螢幕上剛好清楚。品質比原圖低一點——它只在清單裡出現。
THUMBNAIL_DIMENSION = 640
THUMBNAIL_QUALITY = 80

PhotoSize = Literal["full", "thumb"]
```

3. `_resized(image)` 改成 `_resized(image, longest_edge: int = MAX_DIMENSION)`，函式裡的 `MAX_DIMENSION` 換成 `longest_edge`（原本的呼叫端不用改）。
4. 新增：

```python
def thumbnail_path(rel_path: str) -> str:
    """`"7/ab12.jpg"` → `"7/ab12_thumb.jpg"`。**全系統唯一一份規則**——資料庫只存
    原圖的路徑，縮圖的路徑永遠從它推出來（存、讀、刪、清孤兒都用這個函式）。"""
    return f"{rel_path.removesuffix('.jpg')}_thumb.jpg"


def _write_thumbnail(image: Image.Image, rel_path: str) -> None:
    """把 `image`（已經是 RGB、不帶 EXIF）縮到 640 存成縮圖。

    先寫到暫存檔再 `os.replace`：兩個請求同時替同一張舊照片補做縮圖時，
    讀的那一邊不會讀到寫到一半的檔案。"""
    root = _photo_root()
    dest = root / thumbnail_path(rel_path)
    _assert_within_photo_root(dest, root)
    dest.parent.mkdir(parents=True, exist_ok=True)
    temporary = dest.with_name(f"{dest.name}.{uuid.uuid4().hex}.tmp")
    _resized(image, THUMBNAIL_DIMENSION).save(
        temporary, format="JPEG", quality=THUMBNAIL_QUALITY
    )
    os.replace(temporary, dest)


def read_thumbnail(rel_path: str) -> bytes:
    """讀縮圖；這個功能之前上傳的照片沒有縮圖，第一次被要時從原圖補做、存起來。
    原圖也不在 → `FileNotFoundError`（呼叫端照 `read_photo` 的規矩轉 404）。"""
    root = _photo_root()
    try:
        return (root / thumbnail_path(rel_path)).read_bytes()
    except FileNotFoundError:
        pass
    with Image.open(root / rel_path) as original:
        original.load()
        _write_thumbnail(original.convert("RGB"), rel_path)
    return (root / thumbnail_path(rel_path)).read_bytes()


def read_photo_as(rel_path: str, size: PhotoSize) -> bytes:
    """照片端點用：原圖或縮圖。同步、可能要縮圖（CPU）——呼叫端用 run_in_threadpool。"""
    return read_thumbnail(rel_path) if size == "thumb" else read_photo(rel_path)
```

5. `save_photo` 在 `image.save(dest, format="JPEG", quality=85)` 之後加：

```python
    # 用同一張已縮到 1280、已去 EXIF 的圖再縮一次——不從上傳內容重新解碼。
    _write_thumbnail(image, rel_path)
```

6. `delete_photo` 改成刪兩個檔案：

```python
    for target in (_photo_root() / rel_path, _photo_root() / thumbnail_path(rel_path)):
        try:
            target.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            logger.warning("刪除照片檔案失敗：%s", target, exc_info=True)
```

（docstring 補一句「縮圖一起刪」。）

`app/api/routes/meals.py` 的 `read_meal_photo` 與 `app/api/routes/friends.py` 的 `friend_meal_photo`：
- 參數加 `size: PhotoSize = Query(default="full")`（`PhotoSize` 從 `app.storage.photos` import；`Query` 從 `fastapi`）。
- `content = read_photo(meal.photo_path)` 換成 `content = await run_in_threadpool(read_photo_as, meal.photo_path, size)`（`from starlette.concurrency import run_in_threadpool`）。`FileNotFoundError` → 404 的處理不變。
- docstring 補一句：`size=thumb` 是縮圖（第一次可能要補做，所以在執行緒池裡跑）；授權規則不變。

`app/cli.py` 的 `cleanup_orphan_photos`：`referenced_paths` 建好之後加：

```python
    # 縮圖不在資料庫裡，但被引用的原圖的縮圖也是被引用的——不算進來的話，
    # 每一張縮圖都會被當成孤兒刪掉（縮圖規格 §3.3）。
    referenced_paths |= {thumbnail_path(path) for path in referenced_paths}
```

（`thumbnail_path` 從 `app.storage.photos` import。）

- [ ] **Step 4: 跑測試確認通過**：同 Step 2，Expected：13 passed。再跑 `tests/test_photo_storage.py tests/test_meals_photo.py tests/test_photo_cleanup.py tests/test_friend_meals.py tests/test_cross_user_isolation.py -q`——照「開工前必讀」第 4 點處理因多一個檔案而紅的既有測試。

- [ ] **Step 5: 突變**（Edit 改、跑 Step 2、確認紅、改回）：
  - `cleanup_orphan_photos` 拿掉那一行 `referenced_paths |= …` → `test_cleanup_keeps_the_thumbnail_of_a_referenced_photo` 紅。
  - `read_thumbnail` 補做之後不存（`_write_thumbnail` 改成只回傳 bytes 不寫檔、或拿掉呼叫並自己縮）→ `made_once` 紅。
  - `delete_photo` 只刪原圖 → 兩條刪除的測試紅。

- [ ] **Step 6: 全部後端、ruff、mypy**。Expected：791（778 + 13）。

- [ ] **Step 7: Commit**

```
feat(photos): 上傳時同時存 640 的縮圖；照片端點多 size=thumb

舊照片第一次被要縮圖時補做並存起來；刪照片、換照片一起刪縮圖；清孤兒指令把
被引用原圖的縮圖算進被引用。授權規則不變。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add app/storage/photos.py app/api/routes/meals.py app/api/routes/friends.py app/cli.py tests/test_photo_thumbnails.py
```

（加上 Step 4 刻意調整過的既有測試檔。）

---

## Task 2：前端——卡片用縮圖、點了看大圖

**Files:**
- Create: `frontend/src/components/ZoomablePhoto.tsx`、`ZoomablePhoto.module.css`、`frontend/tests/zoomable-photo.test.tsx`
- Modify: `frontend/src/api/photos.ts`、`frontend/src/api/queries.ts`、`frontend/src/screens/MealList.tsx`、`frontend/src/components/FriendMealCard.tsx`；`frontend/tests/meal-photo.test.tsx`、`friend-feed.test.tsx`、`edit-meal.test.tsx`（只新增測試）

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/zoomable-photo.test.tsx`：

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ZoomablePhoto } from "../src/components/ZoomablePhoto";

const ALT = "午餐（12:30）的照片";

function renderPhoto(full: { objectUrl: string | null; isError: boolean }) {
	const useFull = vi.fn(() => full);
	render(<ZoomablePhoto alt={ALT} thumbUrl="blob:thumb" useFull={useFull} />);
	return useFull;
}

describe("可以放大的照片", () => {
	it("一開始只顯示縮圖，還沒抓原圖", () => {
		const useFull = renderPhoto({ objectUrl: "blob:full", isError: false });

		expect(screen.getByRole("img", { name: ALT })).toHaveAttribute("src", "blob:thumb");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(useFull).not.toHaveBeenCalled();
	});

	it("點了打開大圖、抓原圖、焦點在「關閉」", async () => {
		const useFull = renderPhoto({ objectUrl: "blob:full", isError: false });

		await userEvent.click(screen.getByRole("button", { name: `看大圖：${ALT}` }));

		const dialog = screen.getByRole("dialog", { name: ALT });
		expect(within(dialog).getByRole("img")).toHaveAttribute("src", "blob:full");
		expect(within(dialog).getByRole("button", { name: "關閉" })).toHaveFocus();
		expect(useFull).toHaveBeenCalled();
	});

	it("原圖還沒好時先顯示縮圖", async () => {
		renderPhoto({ objectUrl: null, isError: false });

		await userEvent.click(screen.getByRole("button", { name: `看大圖：${ALT}` }));

		expect(within(screen.getByRole("dialog")).getByRole("img")).toHaveAttribute(
			"src",
			"blob:thumb",
		);
	});

	it("Esc 關閉，焦點回到照片按鈕", async () => {
		renderPhoto({ objectUrl: "blob:full", isError: false });
		const trigger = screen.getByRole("button", { name: `看大圖：${ALT}` });

		await userEvent.click(trigger);
		await userEvent.keyboard("{Escape}");

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});

	it("「關閉」與點遮罩都會關；點圖本身不會", async () => {
		renderPhoto({ objectUrl: "blob:full", isError: false });
		const trigger = screen.getByRole("button", { name: `看大圖：${ALT}` });

		await userEvent.click(trigger);
		await userEvent.click(within(screen.getByRole("dialog")).getByRole("img"));
		expect(screen.getByRole("dialog")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("dialog"));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		await userEvent.click(trigger);
		await userEvent.click(screen.getByRole("button", { name: "關閉" }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});
```

整合（照各檔現有的寫法**新增**）：
- `frontend/tests/meal-photo.test.tsx`：「餐點卡片要的是縮圖，點了才抓原圖」——卡片出現後，fetch 呼叫裡有 `/api/meals/11/photo?size=thumb`、**沒有**不帶 `size` 的 `/api/meals/11/photo`；點 `看大圖：…` 之後才有不帶 `size` 的那一個。用 `fetchMock.mock.calls.map(([url]) => String(url))` 比對完整網址（`endsWith`），不要用 `includes`（`/photo` 是 `/photo?size=thumb` 的子字串——第 5 種的形狀）。
- `frontend/tests/friend-feed.test.tsx`：有照片的卡片要的是 `/api/friends/2/meals/7/photo?size=thumb`（`endsWith`）。既有那條「用好友的照片端點」如果因為網址多了 `?size=thumb` 而紅，照第 4 點處理。
- `frontend/tests/edit-meal.test.tsx`：編輯畫面的預覽要的是不帶 `size` 的原圖網址（`endsWith("/api/meals/5/photo")`；`MEAL` 要有 `photo_path` 才會畫預覽——用一個有照片的版本）。

- [ ] **Step 2: 跑測試確認失敗**

```
cd frontend
npx vitest run tests/zoomable-photo.test.tsx tests/meal-photo.test.tsx tests/friend-feed.test.tsx tests/edit-meal.test.tsx
```

Expected：`zoomable-photo` 收集失敗（元件不存在）；`meal-photo`、`friend-feed` 新的那條 FAIL；`edit-meal` 新的那條 **PASS**（守現況：預覽本來就用原圖）。照實回報。

- [ ] **Step 3: 實作**

`frontend/src/api/queries.ts` 的 `queryKeys`：`mealPhoto` 之後加

```ts
	/** 縮圖（縮圖規格 §4.1）：掛在 `mealPhoto(id)` 底下——上傳、刪照片時失效
	 *  `mealPhoto(id)` 是前綴比對，原圖與縮圖一起失效。 */
	mealPhotoThumb: (mealId: number) => ["meal-photo", mealId, "thumb"] as const,
```

`friendPhoto` 之後加

```ts
	friendPhotoThumb: (friendId: number, mealId: number) =>
		["friend-photo", friendId, mealId, "thumb"] as const,
```

`frontend/src/api/photos.ts`：

```ts
export type PhotoSize = "full" | "thumb";

function sized(path: string, size: PhotoSize): string {
	return size === "thumb" ? `${path}?size=thumb` : path;
}

export function useMealPhoto(mealId: number, size: PhotoSize = "full") {
	return usePhotoObjectUrl(
		size === "thumb" ? queryKeys.mealPhotoThumb(mealId) : queryKeys.mealPhoto(mealId),
		sized(`/api/meals/${mealId}/photo`, size),
	);
}

export function useFriendMealPhoto(
	friendId: number,
	mealId: number,
	size: PhotoSize = "full",
) {
	return usePhotoObjectUrl(
		size === "thumb"
			? queryKeys.friendPhotoThumb(friendId, mealId)
			: queryKeys.friendPhoto(friendId, mealId),
		sized(`/api/friends/${friendId}/meals/${mealId}/photo`, size),
	);
}
```

（取代原本的兩個函式；註解保留並補一句 `size`。）

`frontend/src/components/ZoomablePhoto.module.css`（只用設計變數；遮罩用既有的深色變數——先看 `index.css` 有沒有適合的，例如 `--color-scrim` 或 `--color-text`；**沒有就新增一個變數**，淺色與深色模式各一組，`css-tokens.test.ts` 會掃色碼）：

```css
.trigger {
	display: block;
	width: 100%;
	padding: 0;
	border: none;
	border-radius: var(--radius-button);
	background: none;
	cursor: zoom-in;
}

.trigger img {
	display: block;
	width: 100%;
	border-radius: var(--radius-button);
}

.backdrop {
	position: fixed;
	inset: 0;
	z-index: 100;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: var(--space-4);
	background: var(--color-scrim);
}

.full {
	max-width: 100%;
	max-height: 100%;
	object-fit: contain;
	border-radius: var(--radius-button);
}

.close {
	position: absolute;
	top: calc(var(--space-3) + env(safe-area-inset-top, 0px));
	right: var(--space-3);
	min-width: 44px;
	min-height: 44px;
	padding: 0 var(--space-3);
	border: none;
	border-radius: var(--radius-button);
	background: var(--color-surface);
	color: var(--color-text);
	font-size: 15px;
	font-weight: 600;
}
```

`frontend/src/components/ZoomablePhoto.tsx`：

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./ZoomablePhoto.module.css";

type PhotoState = { objectUrl: string | null; isError: boolean };

type Props = {
	alt: string;
	thumbUrl: string;
	/** 原圖的 hook（`() => useMealPhoto(id)` 之類）。**只有打開時才呼叫**——
	 *  清單裡十幾張照片不會一次抓十幾張原圖。 */
	useFull: () => PhotoState;
};

/** 清單裡的照片：顯示縮圖，點了全螢幕看原圖（縮圖規格 §4.2）。 */
export function ZoomablePhoto({ alt, thumbUrl, useFull }: Props) {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const close = useCallback(() => {
		setOpen(false);
		triggerRef.current?.focus();
	}, []);

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				className={styles.trigger}
				aria-label={`看大圖：${alt}`}
				onClick={() => setOpen(true)}
			>
				<img src={thumbUrl} alt={alt} />
			</button>
			{open && (
				<Viewer alt={alt} thumbUrl={thumbUrl} useFull={useFull} onClose={close} />
			)}
		</>
	);
}

function Viewer({
	alt,
	thumbUrl,
	useFull,
	onClose,
}: Props & { onClose: () => void }) {
	const full = useFull();
	const closeRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		closeRef.current?.focus();
	}, []);

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") onClose();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: 鍵盤用 Esc（掛在 window）與「關閉」按鈕；點遮罩只是滑鼠／觸控的捷徑
		<div
			role="dialog"
			aria-modal="true"
			aria-label={alt}
			className={styles.backdrop}
			onClick={(event) => {
				// 只有點到遮罩本身才關——點圖片不關（想看細節時一碰就關掉很煩）。
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<button ref={closeRef} type="button" className={styles.close} onClick={onClose}>
				關閉
			</button>
			<img className={styles.full} src={full.objectUrl ?? thumbUrl} alt={alt} />
		</div>
	);
}
```

> biome 可能還有別的 a11y 規則（例如 `noStaticElementInteractions`）——有的話照實加 `biome-ignore` 並寫理由；**不要**為了過 lint 拿掉點遮罩關閉的行為。

`frontend/src/screens/MealList.tsx` 的 `MealPhoto`：

```tsx
function MealPhoto({ meal }: { meal: Meal }) {
	const thumb = useMealPhoto(meal.id, "thumb");
	const alt = `${MEAL_TYPE_LABELS[meal.meal_type]}（${formatTime(meal.eaten_at)}）的照片`;

	return (
		<div data-testid={`meal-photo-${meal.id}`}>
			{thumb.objectUrl !== null && (
				<ZoomablePhoto
					alt={alt}
					thumbUrl={thumb.objectUrl}
					useFull={() => useMealPhoto(meal.id)}
				/>
			)}
			{thumb.isError && <p>照片無法顯示</p>}
		</div>
	);
}
```

（註解更新：清單用縮圖、點了看原圖。）

`frontend/src/components/FriendMealCard.tsx` 的 `FriendPhoto` 同樣改成 `useFriendMealPhoto(meal.user.id, meal.id, "thumb")` ＋ `ZoomablePhoto`（`useFull={() => useFriendMealPhoto(meal.user.id, meal.id)}`）。

> `useFull={() => useXxx(...)}`：每次 render 是新的函式，但它只在 `Viewer` 裡、每次都以同樣順序呼叫同樣的 hook——符合 hooks 的規則。biome 的 `useHookAtTopLevel` 若誤判，照實回報。

- [ ] **Step 4: 跑測試確認通過**：同 Step 2；`git diff --stat tests/` 只有新增的測試（與第 4 點刻意調整的斷言）。

- [ ] **Step 5: 突變**（各自改、跑、確認紅、改回）：
  - `MealPhoto` 改回 `useMealPhoto(meal.id)`（原圖）→ meal-photo 新的那條紅。
  - `Viewer` 的遮罩條件拿掉 `event.target === event.currentTarget`（點哪都關）→「點圖本身不會」紅。

- [ ] **Step 6: 全部前端檢查**；本機 api 重建（Task 1 的後端）並跑全部 e2e。Expected：e2e 29 passed。

- [ ] **Step 7: 用眼睛看一次**：截飲食頁有照片的卡片、點開大圖（390×844、淺色與深色），存 scratchpad 的 `zoom-*.png`，描述看到的。

- [ ] **Step 8: Commit**

```
feat(photos): 清單與好友動態用縮圖，點了全螢幕看原圖

新元件 ZoomablePhoto：打開時才抓原圖（先顯示縮圖）；關閉、Esc、點遮罩都能關，
焦點進出都有處理。編輯這一餐的預覽照舊用原圖。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/api/photos.ts frontend/src/api/queries.ts frontend/src/components/ZoomablePhoto.tsx frontend/src/components/ZoomablePhoto.module.css frontend/src/screens/MealList.tsx frontend/src/components/FriendMealCard.tsx frontend/tests/zoomable-photo.test.tsx frontend/tests/meal-photo.test.tsx frontend/tests/friend-feed.test.tsx frontend/tests/edit-meal.test.tsx
```

（加上新增了設計變數的話，`frontend/src/index.css` 與 `css-tokens.test.ts` 的對比度測試。）

---

## Task 3：交接文件

- [ ] 規格狀態改成「已實作」。
- [ ] `docs/handover.md` §8.2「照片縮圖：清單頁載入多張 1280px 圖會慢，等前端量到再說」改成已完成：上傳時存 640 縮圖、舊照片第一次被要時補做（不用跑指令）、`?size=thumb`、清孤兒指令把縮圖算進被引用、清單用縮圖＋點了看原圖。
- [ ] 新的綠燈說謊或技術坑（有的話）寫進 §6／§7。
- [ ] Commit：`docs: 交接文件——照片縮圖`
