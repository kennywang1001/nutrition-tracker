"""`POST /api/meals/{id}/photo`（計畫 3 Task 14）。

檔案內容驗證、解壓縮炸彈、EXIF 去除這些安全性質已經在 `tests/test_photo_storage.py`
的純函式層級測試過了；這裡測的是這條路由自己的責任：擁有權、大小上限、
取代舊照片的順序、以及跟 `GET /api/meals/{id}` 之間的一致性。
"""

import io
from pathlib import Path

import pytest
from PIL import Image

from app.api.routes.meals import MAX_PHOTO_BYTES, _read_upload_within_limit
from app.config import settings
from app.errors import PayloadTooLargeError
from app.security.tokens import create_token
from app.storage.photos import delete_photo
from tests.factories import create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


def _create_payload(**overrides):
    payload = {
        "eaten_at": "2026-09-04T12:30:00+08:00",
        "meal_type": "lunch",
        "note": "測試用的一餐",
        "items": [],
    }
    payload.update(overrides)
    return payload


def _jpeg_bytes(width: int = 400, height: int = 300) -> bytes:
    image = Image.new("RGB", (width, height), color=(200, 100, 50))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG")
    return buffer.getvalue()


@pytest.fixture(autouse=True)
def _photo_dir_in_tmp_path(tmp_path, monkeypatch):
    # 絕對不能讓這個檔案的測試寫進真的 data/photos。
    monkeypatch.setattr(settings, "photo_dir", str(tmp_path))


async def _create_meal(client, user) -> int:
    response = await client.post("/api/meals", headers=auth(user), json=_create_payload())
    meal_id: int = response.json()["id"]
    return meal_id


# ---------------------------------------------------------------------------
# 8 個必要測試
# ---------------------------------------------------------------------------


async def test_uploading_a_photo_returns_200_with_a_photo_path(client, db_session):
    user = await create_user(db_session)
    meal_id = await _create_meal(client, user)

    response = await client.post(
        f"/api/meals/{meal_id}/photo",
        headers=auth(user),
        files={"file": ("food.jpg", _jpeg_bytes(), "image/jpeg")},
    )

    assert response.status_code == 200
    photo_path = response.json()["photo_path"]
    assert photo_path
    saved = Path(settings.photo_dir) / photo_path
    assert saved.is_file()


async def test_uploading_a_photo_to_someone_elses_meal_is_not_found(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    meal_id = await _create_meal(client, alice)

    response = await client.post(
        f"/api/meals/{meal_id}/photo",
        headers=auth(bob),
        files={"file": ("food.jpg", _jpeg_bytes(), "image/jpeg")},
    )

    assert response.status_code == 404

    reread = await client.get(f"/api/meals/{meal_id}", headers=auth(alice))
    assert reread.json()["photo_path"] is None


async def test_uploading_non_image_content_is_rejected(client, db_session):
    """也是「內容型別由解碼決定，不是 client 宣告的 Content-Type」的證據：
    這裡故意把 Content-Type 宣告成 image/jpeg，內容卻是純文字，還是要被擋下來。
    """
    user = await create_user(db_session)
    meal_id = await _create_meal(client, user)

    response = await client.post(
        f"/api/meals/{meal_id}/photo",
        headers=auth(user),
        files={
            "file": (
                "not-a-photo.jpg",
                b"just some plain text pretending to be a jpeg",
                "image/jpeg",
            )
        },
    )

    assert response.status_code == 422

    reread = await client.get(f"/api/meals/{meal_id}", headers=auth(user))
    assert reread.json()["photo_path"] is None


async def test_uploading_an_oversized_photo_is_rejected(client, db_session):
    user = await create_user(db_session)
    meal_id = await _create_meal(client, user)

    oversized = b"a" * (MAX_PHOTO_BYTES + 1)
    response = await client.post(
        f"/api/meals/{meal_id}/photo",
        headers=auth(user),
        files={"file": ("huge.jpg", oversized, "image/jpeg")},
    )

    assert response.status_code == 413

    reread = await client.get(f"/api/meals/{meal_id}", headers=auth(user))
    assert reread.json()["photo_path"] is None


async def test_upload_photo_requires_authentication(client, db_session):
    user = await create_user(db_session)
    meal_id = await _create_meal(client, user)

    response = await client.post(
        f"/api/meals/{meal_id}/photo",
        files={"file": ("food.jpg", _jpeg_bytes(), "image/jpeg")},
    )

    assert response.status_code == 401


async def test_reuploading_a_photo_replaces_the_old_one_and_deletes_the_old_file(
    client, db_session
):
    user = await create_user(db_session)
    meal_id = await _create_meal(client, user)

    first = await client.post(
        f"/api/meals/{meal_id}/photo",
        headers=auth(user),
        files={"file": ("a.jpg", _jpeg_bytes(100, 100), "image/jpeg")},
    )
    first_path = first.json()["photo_path"]
    first_file = Path(settings.photo_dir) / first_path
    assert first_file.is_file()

    second = await client.post(
        f"/api/meals/{meal_id}/photo",
        headers=auth(user),
        files={"file": ("b.jpg", _jpeg_bytes(200, 200), "image/jpeg")},
    )

    assert second.status_code == 200
    second_path = second.json()["photo_path"]
    assert second_path != first_path
    assert not first_file.is_file(), "舊檔案應該已經被刪掉"
    assert (Path(settings.photo_dir) / second_path).is_file()

    reread = await client.get(f"/api/meals/{meal_id}", headers=auth(user))
    assert reread.json()["photo_path"] == second_path


async def test_uploaded_photo_is_visible_via_get_meal(client, db_session):
    user = await create_user(db_session)
    meal_id = await _create_meal(client, user)

    before = await client.get(f"/api/meals/{meal_id}", headers=auth(user))
    assert before.json()["photo_path"] is None

    upload = await client.post(
        f"/api/meals/{meal_id}/photo",
        headers=auth(user),
        files={"file": ("food.jpg", _jpeg_bytes(), "image/jpeg")},
    )
    photo_path = upload.json()["photo_path"]

    reread = await client.get(f"/api/meals/{meal_id}", headers=auth(user))
    assert reread.status_code == 200
    assert reread.json()["photo_path"] == photo_path


async def test_missing_file_field_is_rejected(client, db_session):
    user = await create_user(db_session)
    meal_id = await _create_meal(client, user)

    response = await client.post(f"/api/meals/{meal_id}/photo", headers=auth(user))

    assert response.status_code == 422


# ---------------------------------------------------------------------------
# 額外測試：取代順序（commit 必須先於刪除舊檔）與大小上限的提早中止。
# 這兩個都是「寫完就是綠的」測試會空轉的地方（計畫繼承規矩第 8 條），
# 用突變證明過（見任務報告），這裡留下能重複驗證的斷言。
# ---------------------------------------------------------------------------


async def test_the_old_file_is_deleted_only_after_the_db_commit_succeeds(
    client, db_session, monkeypatch
):
    """直接記錄 commit 與刪除舊檔的實際發生順序，而不是只看最終結果 ——
    最終結果（`test_reuploading_a_photo_replaces_the_old_one_and_deletes_the_old_file`）
    沒辦法分辨『先刪再 commit』跟『先 commit 再刪』，因為兩種順序在沒有任何
    失敗發生時的最終狀態長得一模一樣。這裡把兩個動作都包一層 spy，
    直接斷言事件發生的先後。
    """
    user = await create_user(db_session)
    meal_id = await _create_meal(client, user)

    first = await client.post(
        f"/api/meals/{meal_id}/photo",
        headers=auth(user),
        files={"file": ("a.jpg", _jpeg_bytes(100, 100), "image/jpeg")},
    )
    old_path = first.json()["photo_path"]
    old_file = Path(settings.photo_dir) / old_path
    assert old_file.is_file()

    events: list[str] = []
    original_commit = db_session.commit

    async def spying_commit():
        await original_commit()
        events.append("commit")

    def spying_delete(rel_path: str) -> None:
        events.append("delete")
        delete_photo(rel_path)  # 呼叫真正的實作，確保檔案真的被清掉

    monkeypatch.setattr(db_session, "commit", spying_commit)
    monkeypatch.setattr("app.api.routes.meals.delete_photo", spying_delete)

    second = await client.post(
        f"/api/meals/{meal_id}/photo",
        headers=auth(user),
        files={"file": ("b.jpg", _jpeg_bytes(200, 200), "image/jpeg")},
    )

    assert second.status_code == 200
    assert events == ["commit", "delete"], f"commit 必須先於 delete，實際順序：{events}"
    assert not old_file.is_file()


class _FakeUploadFile:
    """假的 UploadFile：`_read_upload_within_limit` 只需要一個 async `read(size)`。

    用一個「宣告總大小遠超過上限」但每次只吐出固定大小區塊、並計數被呼叫
    幾次的假物件，證明中止發生在讀完全部內容**之前**，不需要真的配置
    好幾 GB 記憶體來證明這件事。
    """

    def __init__(self, total_size: int, chunk_size: int) -> None:
        self._remaining = total_size
        self._chunk_size = chunk_size
        self.chunks_served = 0

    async def read(self, size: int) -> bytes:
        if self._remaining <= 0:
            return b""
        n = min(size, self._remaining, self._chunk_size)
        self._remaining -= n
        self.chunks_served += 1
        return b"x" * n


async def test_read_upload_within_limit_aborts_before_reading_the_whole_body():
    """大小上限必須在讀進記憶體之前擋（計畫 3 Task 14）：`await file.read()`
    不設上限的話，一個幾 GB 的上傳會在檢查長度之前就把記憶體吃光。

    這裡宣告的「檔案總大小」是 10 GiB，如果實作是先整包讀完再檢查，
    這個測試會需要真的等待／配置 10 GiB —— 用一個會計數呼叫次數的假物件，
    直接證明中止發生在遠早於讀完全部內容之前：上限 1024 bytes、
    每個 chunk 256 bytes，最多讀 5 個 chunk 就一定會中止，
    不可能讀到「10 GiB 對應的四千萬個 chunk」。
    """
    huge_declared_size = 10 * 1024 * 1024 * 1024
    limit = 1024
    fake_file = _FakeUploadFile(total_size=huge_declared_size, chunk_size=256)

    with pytest.raises(PayloadTooLargeError):
        await _read_upload_within_limit(fake_file, limit)

    assert fake_file.chunks_served <= 5


# ---------------------------------------------------------------------------
# Task 15：GET /api/meals/{id}/photo —— 5 個必要測試
#
# 規格第 8 節：照片不透過靜態檔案服務提供，一律先驗 JWT 與擁有權，
# 每一次讀取都要經過這個端點。
# ---------------------------------------------------------------------------


async def _upload_photo(client, user, meal_id, *, width=400, height=300) -> str:
    response = await client.post(
        f"/api/meals/{meal_id}/photo",
        headers=auth(user),
        files={"file": ("food.jpg", _jpeg_bytes(width, height), "image/jpeg")},
    )
    photo_path: str = response.json()["photo_path"]
    return photo_path


async def test_getting_own_photo_returns_the_exact_bytes_that_were_saved(client, db_session):
    """狀態碼、content-type、位元組都要對：不能只驗其中一個。

    位元組比較的對象是 `save_photo` 實際寫到磁碟上的內容，不是上傳時送進去的
    原始檔案 —— Pillow 重新編碼過（縮放、去 EXIF、轉 JPEG），跟原始上傳內容
    本來就不會逐位元組相同，那不是這個端點要保證的事。
    """
    user = await create_user(db_session)
    meal_id = await _create_meal(client, user)
    photo_path = await _upload_photo(client, user, meal_id)
    saved_bytes = (Path(settings.photo_dir) / photo_path).read_bytes()

    response = await client.get(f"/api/meals/{meal_id}/photo", headers=auth(user))

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert response.content == saved_bytes


async def test_getting_someone_elses_photo_is_not_found(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    meal_id = await _create_meal(client, alice)
    await _upload_photo(client, alice, meal_id)

    response = await client.get(f"/api/meals/{meal_id}/photo", headers=auth(bob))

    assert response.status_code == 404


async def test_getting_photo_for_a_meal_without_one_is_not_found(client, db_session):
    user = await create_user(db_session)
    meal_id = await _create_meal(client, user)

    response = await client.get(f"/api/meals/{meal_id}/photo", headers=auth(user))

    assert response.status_code == 404


async def test_get_photo_requires_authentication(client, db_session):
    user = await create_user(db_session)
    meal_id = await _create_meal(client, user)
    await _upload_photo(client, user, meal_id)

    response = await client.get(f"/api/meals/{meal_id}/photo")

    assert response.status_code == 401


async def test_missing_photo_file_on_disk_returns_404_not_500(client, db_session):
    """DB 有 `photo_path` 但檔案不在磁碟上，是正常操作下可達的狀態 ——
    `delete_photo()` 是 best-effort 設計（規格第 8 節：容許檔案暫時落後於
    DB），所以「DB 指著一個已經不存在的檔案」不是只存在於理論上的邊界案例。

    這裡直接繞過 API、在檔案系統層面刪掉檔案來重現這個狀態，不依賴任何
    競態條件或真的讓 delete_photo 失敗。
    """
    user = await create_user(db_session)
    meal_id = await _create_meal(client, user)
    photo_path = await _upload_photo(client, user, meal_id)
    (Path(settings.photo_dir) / photo_path).unlink()

    response = await client.get(f"/api/meals/{meal_id}/photo", headers=auth(user))

    assert response.status_code == 404


async def test_no_static_files_mount_serves_the_photo_directory():
    """規格第 8 節的陷阱：如果之後有人為了方便掛 `StaticFiles(directory=photo_dir)`，
    上面 5 個測試全部打 `/api/meals/{id}/photo` 這條路徑，一個都不會變紅 ——
    它們從來沒有問過『還有沒有第二條路徑也能拿到這個檔案』。

    這裡誠實地換一種方式測：不透過 HTTP 去『猜』有沒有其他路徑能讀到檔案
    （猜不到就是假陰性，猜得到也只證明了那一個路徑，不是全部），而是直接
    檢查 app 的路由表本身——掃過 `app.routes`，斷言沒有任何一個是 `StaticFiles`
    掛載。這是這個陷阱唯一能被自動化測試釘住的方式。

    範圍要誠實講清楚：這個測試抓得到「掛 StaticFiles 到任何路徑」這個計畫
    明講的陷阱（已用突變驗證，見任務報告），抓不到「日後有人寫一個全新的、
    忘記加認證的一般端點去讀檔案再回傳」——那是程式邏輯錯誤，不是路由表
    能看出來的東西，只能靠程式碼審查或端點層級的隔離掃描守住。
    """
    from starlette.staticfiles import StaticFiles

    from app.main import app

    static_mounts = [
        route.path for route in app.routes if isinstance(getattr(route, "app", None), StaticFiles)
    ]

    assert static_mounts == [], (
        f"發現 StaticFiles 掛載：{static_mounts} —— "
        "照片一律要經過 /api/meals/{id}/photo 驗證擁有權，不可以被繞過"
    )


# ---------------------------------------------------------------------------
# Task 16：DELETE /api/meals/{id}/photo + 刪整餐時的孤兒檔案清理 —— 4 個必要測試
#
# 一律「先 DB、後檔案」：檔案刪除失敗只記下來，不讓請求失敗
# （規格第 8 節：多一個沒人引用的檔案只是浪費磁碟，少一個被引用的檔案是
# 壞掉的功能，所以要讓 DB 先正確）。
# ---------------------------------------------------------------------------


async def test_deleting_a_photo_returns_204_clears_photo_path_and_deletes_the_file(
    client, db_session
):
    user = await create_user(db_session)
    meal_id = await _create_meal(client, user)
    photo_path = await _upload_photo(client, user, meal_id)
    photo_file = Path(settings.photo_dir) / photo_path
    assert photo_file.is_file()

    response = await client.delete(f"/api/meals/{meal_id}/photo", headers=auth(user))

    assert response.status_code == 204
    assert not photo_file.is_file()

    reread = await client.get(f"/api/meals/{meal_id}", headers=auth(user))
    assert reread.json()["photo_path"] is None


async def test_deleting_someone_elses_photo_is_not_found(client, db_session):
    """『404』和『真的沒刪掉』是兩件事（繼承自 Task 11 的教訓）——
    這裡連檔案是否還在磁碟上、DB 裡的 photo_path 是否還在，都要真的重查一次。
    """
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    meal_id = await _create_meal(client, alice)
    photo_path = await _upload_photo(client, alice, meal_id)
    photo_file = Path(settings.photo_dir) / photo_path

    response = await client.delete(f"/api/meals/{meal_id}/photo", headers=auth(bob))

    assert response.status_code == 404
    assert photo_file.is_file(), "別人的照片檔案不能被刪掉"

    reread = await client.get(f"/api/meals/{meal_id}", headers=auth(alice))
    assert reread.json()["photo_path"] == photo_path


async def test_deleting_photo_when_meal_has_none_is_not_found(client, db_session):
    user = await create_user(db_session)
    meal_id = await _create_meal(client, user)

    response = await client.delete(f"/api/meals/{meal_id}/photo", headers=auth(user))

    assert response.status_code == 404


async def test_deleting_a_meal_also_deletes_its_photo_file(client, db_session):
    """刪整餐時照片檔案也要被清掉（Task 16 的孤兒檔案清理）。"""
    user = await create_user(db_session)
    meal_id = await _create_meal(client, user)
    photo_path = await _upload_photo(client, user, meal_id)
    photo_file = Path(settings.photo_dir) / photo_path
    assert photo_file.is_file()

    response = await client.delete(f"/api/meals/{meal_id}", headers=auth(user))

    assert response.status_code == 204
    assert not photo_file.is_file(), "刪整餐時照片檔案也要被清掉"


async def test_the_file_is_deleted_only_after_the_db_commit_succeeds_on_photo_delete(
    client, db_session, monkeypatch
):
    """跟 Task 14 上傳那個順序測試同構：直接記錄 commit 與刪檔的實際先後順序，
    不能只看最終結果 —— 最終結果沒辦法分辨『先刪檔案再 commit』跟
    『先 commit 再刪檔案』，因為兩種順序在沒有任何失敗發生時的最終狀態
    長得一模一樣（見任務報告：這個順序被實際突變驗證過，`DELETE .../photo`
    原本並沒有任何測試會因為調換順序而變紅）。
    """
    user = await create_user(db_session)
    meal_id = await _create_meal(client, user)
    photo_path = await _upload_photo(client, user, meal_id)
    photo_file = Path(settings.photo_dir) / photo_path
    assert photo_file.is_file()

    events: list[str] = []
    original_commit = db_session.commit

    async def spying_commit():
        await original_commit()
        events.append("commit")

    def spying_delete(rel_path: str) -> None:
        events.append("delete")
        delete_photo(rel_path)  # 呼叫真正的實作，確保檔案真的被清掉

    monkeypatch.setattr(db_session, "commit", spying_commit)
    monkeypatch.setattr("app.api.routes.meals.delete_photo", spying_delete)

    response = await client.delete(f"/api/meals/{meal_id}/photo", headers=auth(user))

    assert response.status_code == 204
    assert events == ["commit", "delete"], f"commit 必須先於 delete，實際順序：{events}"
    assert not photo_file.is_file()
