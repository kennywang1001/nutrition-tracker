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
