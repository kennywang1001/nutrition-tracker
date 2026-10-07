import io
import os
import threading
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


def _write_original(rel_path: str, content: bytes) -> Path:
    target = _root() / rel_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    return target


@pytest.mark.parametrize(
    "content",
    [
        b"definitely not a jpeg",
        _jpeg_bytes(800, 600)[:400],  # 檔頭完整、像素資料被截斷
    ],
    ids=["garbage", "truncated"],
)
def test_an_undecodable_original_is_served_as_is(content):
    """補做縮圖時原圖壞了：給原圖的 bytes（使用者至少看得到原本的東西），
    不 500、也不留下縮圖。"""
    rel_path = "1/broken.jpg"
    _write_original(rel_path, content)

    assert read_thumbnail(rel_path) == content
    assert not (_root() / thumbnail_path(rel_path)).exists()


def test_an_oversized_original_is_served_as_is(monkeypatch):
    """補做的路徑也要在 load() 之前自己比尺寸（跟 save_photo 一樣不靠 Pillow 的警告）。"""
    rel_path = save_photo(_jpeg_bytes(800, 600), user_id=1)
    (_root() / thumbnail_path(rel_path)).unlink()
    original = (_root() / rel_path).read_bytes()
    monkeypatch.setattr(photos, "MAX_IMAGE_PIXELS", 100)

    assert read_thumbnail(rel_path) == original
    assert not (_root() / thumbnail_path(rel_path)).exists()


def test_a_failed_thumbnail_write_leaves_no_temp_file_and_still_serves(monkeypatch):
    """Windows 上別的請求正開著目的檔時 os.replace 會 PermissionError；磁碟滿也類似。"""
    rel_path = save_photo(_jpeg_bytes(2000, 1000), user_id=1)
    (_root() / thumbnail_path(rel_path)).unlink()

    def refuse(src, dst):
        raise PermissionError("目的檔正被別人開著")

    monkeypatch.setattr(photos.os, "replace", refuse)

    content = read_thumbnail(rel_path)

    assert _size_of(content)[0] > 0  # 是一張圖
    assert list((_root() / rel_path).parent.glob("*.tmp")) == []
    assert not (_root() / thumbnail_path(rel_path)).exists()


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


async def test_a_non_friend_cannot_get_a_thumbnail(client, db_session):
    alice = await create_user(db_session)
    stranger = await create_user(db_session)
    meal = await _meal_with_photo(client, db_session, alice)

    response = await client.get(
        f"/api/friends/{alice.id}/meals/{meal.id}/photo",
        headers=auth(stranger),
        params={"size": "thumb"},
    )

    assert response.status_code == 404


async def test_a_broken_original_still_comes_back_as_a_thumbnail_request(client, db_session):
    user = await create_user(db_session)
    rel_path = f"{user.id}/broken.jpg"
    _write_original(rel_path, b"definitely not a jpeg")
    meal = await create_meal(db_session, user=user, photo_path=rel_path)

    response = await client.get(
        f"/api/meals/{meal.id}/photo", headers=auth(user), params={"size": "thumb"}
    )

    assert response.status_code == 200
    assert response.content == b"definitely not a jpeg"


async def test_upload_encodes_off_the_event_loop(client, db_session, monkeypatch):
    """上傳時要編兩張 JPEG（原圖＋縮圖），不能卡住 event loop（同 test_rate_limit 的
    「verify_password 在執行緒裡跑」）。"""
    user = await create_user(db_session)
    meal = await create_meal(db_session, user=user)
    main_thread_id = threading.get_ident()
    seen_thread_ids: list[int] = []

    def recording_save(content, *, user_id):
        seen_thread_ids.append(threading.get_ident())
        return save_photo(content, user_id=user_id)

    monkeypatch.setattr("app.api.routes.meals.save_photo", recording_save)

    response = await client.post(
        f"/api/meals/{meal.id}/photo",
        headers=auth(user),
        files={"file": ("a.jpg", _jpeg_bytes(900, 600), "image/jpeg")},
    )

    assert response.status_code == 200
    assert seen_thread_ids, "save_photo 應該有被呼叫到"
    assert seen_thread_ids[0] != main_thread_id
