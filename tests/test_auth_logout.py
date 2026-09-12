from tests.factories import DEFAULT_PASSWORD, create_user


async def _login(client, user) -> dict[str, str]:
    response = await client.post(
        "/api/auth/login", json={"email": user.email, "password": DEFAULT_PASSWORD}
    )
    assert response.status_code == 200
    return response.json()


async def test_logout_kills_the_refresh_token(client, db_session):
    """**斷言的是伺服器上那張票死了，不是回應碼。**

    只斷言「回 204」或「前端回到登入頁」，證明的是狀態碼與前端狀態 ——
    把 logout 寫成「什麼都不做直接回 204」，那種測試照樣綠（§6 第 3 條）。
    """
    user = await create_user(db_session)
    tokens = await _login(client, user)

    logout = await client.post(
        "/api/auth/logout", json={"refresh_token": tokens["refresh_token"]}
    )
    assert logout.status_code == 204

    again = await client.post(
        "/api/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    assert again.status_code == 401


async def test_logout_kills_the_whole_family_not_just_the_last_token(client, db_session):
    """登出時手上那張票可能已經輪替過好幾輪。撤銷必須及於整條鏈，
    否則鏈上任何一張還沒用過的票都還活著。
    """
    user = await create_user(db_session)
    tokens = await _login(client, user)
    rotated = await client.post(
        "/api/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    newest = rotated.json()["refresh_token"]

    await client.post("/api/auth/logout", json={"refresh_token": newest})

    again = await client.post("/api/auth/refresh", json={"refresh_token": newest})
    assert again.status_code == 401


async def test_logout_is_idempotent(client, db_session):
    """登出是冪等的。「讓我登出」在票已經死掉時已經達成了 ——
    回錯誤只會逼前端在登出流程裡多寫一段沒有意義的錯誤處理。
    """
    user = await create_user(db_session)
    tokens = await _login(client, user)

    first = await client.post(
        "/api/auth/logout", json={"refresh_token": tokens["refresh_token"]}
    )
    second = await client.post(
        "/api/auth/logout", json={"refresh_token": tokens["refresh_token"]}
    )

    assert first.status_code == 204
    assert second.status_code == 204


async def test_logout_accepts_garbage_without_leaking_whether_it_was_valid(client):
    """對無效的 token 一樣回 204。回 401 等於提供一個「這張票還活著嗎」的探針。"""
    response = await client.post("/api/auth/logout", json={"refresh_token": "nope"})
    assert response.status_code == 204


async def test_logout_only_affects_the_device_that_logged_out(client, db_session):
    """**規格 §1 的核心產出。** 手機登出，桌機不受影響。"""
    user = await create_user(db_session)
    phone = await _login(client, user)
    desktop = await _login(client, user)

    await client.post("/api/auth/logout", json={"refresh_token": phone["refresh_token"]})

    still_alive = await client.post(
        "/api/auth/refresh", json={"refresh_token": desktop["refresh_token"]}
    )
    assert still_alive.status_code == 200


async def test_logout_all_kills_every_device(client, db_session):
    user = await create_user(db_session)
    phone = await _login(client, user)
    desktop = await _login(client, user)

    response = await client.post(
        "/api/auth/logout-all",
        headers={"Authorization": f"Bearer {desktop['access_token']}"},
    )
    assert response.status_code == 204

    for tokens in (phone, desktop):
        refreshed = await client.post(
            "/api/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
        )
        assert refreshed.status_code == 401


async def test_logout_all_requires_authentication(client):
    response = await client.post("/api/auth/logout-all")
    assert response.status_code == 401


async def test_logout_all_does_not_touch_another_users_sessions(client, db_session):
    user = await create_user(db_session)
    other = await create_user(db_session)
    other_tokens = await _login(client, other)
    mine = await _login(client, user)

    await client.post(
        "/api/auth/logout-all",
        headers={"Authorization": f"Bearer {mine['access_token']}"},
    )

    refreshed = await client.post(
        "/api/auth/refresh", json={"refresh_token": other_tokens["refresh_token"]}
    )
    assert refreshed.status_code == 200


async def test_an_access_token_still_works_after_logout_and_that_is_deliberate(
    client, db_session
):
    """**這個測試在斷言一個弱點存在，而且那是刻意的（規格 §4）。**

    access token 不查資料庫。每個請求都去查一次 session 表，等於把無狀態
    驗證的全部好處丟掉，換來最多 15 分鐘的延遲改善 —— 對這個規模不划算。
    所以撤銷的真實語意是：「再也換不到新票，但手上這張最多還能用 15 分鐘」。

    沒有這個測試的話，日後有人在 get_current_user 裡「順手補上」一次
    DB 查詢，不會有任何東西變紅提醒他剛剛付出了什麼代價。
    """
    user = await create_user(db_session)
    tokens = await _login(client, user)

    await client.post("/api/auth/logout", json={"refresh_token": tokens["refresh_token"]})

    me = await client.get(
        "/api/me", headers={"Authorization": f"Bearer {tokens['access_token']}"}
    )
    assert me.status_code == 200, (
        "access token 在登出後的剩餘壽命內仍然有效是刻意的設計（規格 §4）。"
        "如果這個斷言失敗，代表有人讓 access token 開始查資料庫了 —— "
        "那是一個需要被討論的效能取捨，不是一個順手的修正。"
    )
