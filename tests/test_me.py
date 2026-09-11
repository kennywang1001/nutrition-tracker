from app.security.tokens import create_access_token
from tests.factories import create_user


async def test_can_update_timezone(client, db_session):
    user = await create_user(db_session)
    assert user.timezone == "Asia/Taipei"  # server_default，見計畫 3 Task 1
    user_id = user.id
    token = create_access_token(user_id)

    response = await client.patch(
        "/api/me",
        json={"timezone": "America/New_York"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert response.json()["timezone"] == "America/New_York"

    await db_session.refresh(user)
    assert user.timezone == "America/New_York"


async def test_can_update_display_name(client, db_session):
    user = await create_user(db_session, display_name="舊名字")
    user_id = user.id
    token = create_access_token(user_id)

    response = await client.patch(
        "/api/me",
        json={"display_name": "新名字"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert response.json()["display_name"] == "新名字"

    await db_session.refresh(user)
    assert user.display_name == "新名字"


async def test_updating_one_field_leaves_the_other_untouched(client, db_session):
    """只帶一個欄位時，另一個欄位必須完全不動 —— 這是 exclude_unset 存在的理由。

    field 不在請求裡 ⇒ 不在 model_dump(exclude_unset=True) 的結果裡 ⇒ 不會被
    setattr。如果實作換成 exclude_none 或乾脆整包塞回去，這個測試不會分辨得出來
    差異——因為「沒帶」在這兩種寫法下結果一樣（都是 None，都被排除）。
    但這個測試釘住的是「沒帶的欄位真的沒被寫入」這件事本身，這是後續要加
    可為 null 欄位時，exclude_unset vs exclude_none 分岔的地基。
    """
    user = await create_user(db_session, display_name="原本的名字")
    assert user.timezone == "Asia/Taipei"  # server_default，見計畫 3 Task 1
    user_id = user.id
    token = create_access_token(user_id)

    response = await client.patch(
        "/api/me",
        json={"timezone": "America/New_York"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["timezone"] == "America/New_York"
    assert body["display_name"] == "原本的名字"

    await db_session.refresh(user)
    assert user.display_name == "原本的名字"
    assert user.timezone == "America/New_York"


async def test_invalid_timezone_is_rejected(client, db_session):
    user = await create_user(db_session)
    assert user.timezone == "Asia/Taipei"  # server_default，見計畫 3 Task 1
    user_id = user.id
    token = create_access_token(user_id)

    response = await client.patch(
        "/api/me",
        json={"timezone": "Mars/Olympus"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 422
    body = response.json()
    assert body["error"]["code"] == "VALIDATION_ERROR"
    # 只斷言狀態碼不夠：漏接 ZoneInfoNotFoundError 或 ValueError 其中一個，
    # 狀態碼可能還是 422，只是訊息換成 zoneinfo 的內部訊息。這裡要確認
    # 回應裡真的是我們自己寫的那句話。
    messages = [error["msg"] for error in body["error"]["details"]["errors"]]
    assert any("不是合法的 IANA 時區名稱" in message for message in messages)

    await db_session.refresh(user)
    assert user.timezone == "Asia/Taipei"


async def test_update_me_requires_a_token(client):
    response = await client.patch("/api/me", json={"display_name": "新名字"})

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "NOT_AUTHENTICATED"


async def test_an_explicit_null_timezone_is_rejected_not_a_500(client, db_session):
    """`{"timezone": null}` 必須是 422。

    這裡曾經是一個真的缺陷：欄位宣告成 `X | None = None`，其中 None 是拿來當
    「沒帶這個欄位」的哨兵，但 Pydantic 在型別層無法區分「沒帶」和「明確送 null」
    —— 兩者都通過驗證。而路由用的 `exclude_unset` 正確地保留了明確的 null，
    於是 None 一路流到 setattr，撞上資料庫的 NOT NULL，變成未認證即可觸發的
    500（`asyncpg.NotNullViolationError`）。

    修法不是改成 `exclude_none`（那會把明確的 null 悄悄吞掉），
    而是在 schema 層明講「這兩個欄位不接受 null」。
    """
    user = await create_user(db_session)
    token = create_access_token(user.id)

    response = await client.patch(
        "/api/me",
        json={"timezone": None},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 422


async def test_an_explicit_null_display_name_is_rejected_not_a_500(client, db_session):
    user = await create_user(db_session)
    token = create_access_token(user.id)

    response = await client.patch(
        "/api/me",
        json={"display_name": None},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 422
