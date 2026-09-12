from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models.session import RefreshSession
from app.security.sessions import ReuseDetectedError, revoke_session, rotate_session, start_session
from app.security.tokens import (
    TokenError,
    create_refresh_token,
    decode_access_token,
    decode_refresh_token,
)
from tests.factories import DEFAULT_PASSWORD, create_user


def _session_row(user_id: int, *, jti=None, family_id=None) -> RefreshSession:
    now = datetime.now(UTC)
    return RefreshSession(
        user_id=user_id,
        jti=jti or uuid4(),
        family_id=family_id or uuid4(),
        issued_at=now,
        expires_at=now + timedelta(days=14),
    )


async def test_a_session_row_can_be_stored_and_read_back(db_session):
    user = await create_user(db_session)
    row = _session_row(user.id)

    db_session.add(row)
    await db_session.commit()
    await db_session.refresh(row)

    assert row.id is not None
    assert row.used_at is None
    assert row.revoked_at is None
    # DateTime(timezone=True) 必須回 aware 的 datetime —— Task 6 的比較
    # （Python 時鐘 vs 這個欄位）建立在這上面，naive 的話會直接 TypeError。
    assert row.issued_at.tzinfo is not None
    assert row.expires_at.tzinfo is not None


async def test_jti_is_unique(db_session):
    """jti 是查詢的鍵。重複的 jti 代表兩條不同的鏈共用一個識別，撤銷其中一條
    會誤傷另一條 —— 這要由資料庫擋，不是靠「uuid4 不會碰撞」這個假設。
    """
    user = await create_user(db_session)
    jti = uuid4()
    db_session.add(_session_row(user.id, jti=jti))
    await db_session.commit()

    db_session.add(_session_row(user.id, jti=jti))
    with pytest.raises(IntegrityError):
        await db_session.commit()
    # conftest 開頭列的已知邊界 4：接住 commit 丟出的例外之後一定要 rollback，
    # 否則同一個測試後續所有資料庫操作都會炸 PendingRollbackError，
    # 而且錯誤訊息看起來跟真正的原因完全無關。
    await db_session.rollback()


async def test_sessions_are_deleted_when_the_user_is_deleted(db_session):
    """ON DELETE CASCADE —— 不留孤兒列。"""
    user = await create_user(db_session)
    db_session.add(_session_row(user.id))
    await db_session.commit()

    await db_session.delete(user)
    await db_session.commit()

    remaining = (await db_session.scalars(select(RefreshSession))).all()
    assert remaining == []


async def test_a_family_cannot_have_two_live_tokens(db_session):
    """鏈分岔就是這張表要防的 bug（規格 §3.1）。Task 4 的條件式 UPDATE 保證了它，
    但那是程式碼；這條測試證明資料庫也擋。

    **沒有這條測試，把部分唯一索引從 model 與 migration 同時刪掉，
    `alembic check` 乾淨、整套測試全綠、不變量安靜消失。**
    alembic check 抓的是「模型與 migration 不一致」，兩邊一起刪它看不見。
    """
    user = await create_user(db_session)
    family_id = uuid4()
    db_session.add(_session_row(user.id, family_id=family_id))
    await db_session.commit()

    db_session.add(_session_row(user.id, family_id=family_id))
    with pytest.raises(IntegrityError) as exc:
        await db_session.commit()
    assert "one_live_per_family" in str(exc.value)
    await db_session.rollback()


async def test_used_and_revoked_rows_free_the_family_slot(db_session):
    """索引只約束**活**票 —— 否則輪替會在第二次換發就炸。

    這條跟上面那條是一對：上面證明它會擋，這條證明它擋對了東西。
    只有上面那條的話，把述詞寫成「family_id 唯一」也是綠的。
    """
    user = await create_user(db_session)
    family_id = uuid4()
    spent = _session_row(user.id, family_id=family_id)
    spent.used_at = datetime.now(UTC)
    db_session.add(spent)
    await db_session.commit()

    db_session.add(_session_row(user.id, family_id=family_id))
    await db_session.commit()  # 不該炸


async def test_expires_at_must_be_after_issued_at(db_session):
    """Task 4 刻意不檢查 expires_at，所以壞掉的值在程式碼裡不會報錯 ——
    使用者只會莫名被登出。由 CHECK 擋住。

    用 expires_at == issued_at 這個邊界值，不是明顯更小的值：
    `>=` 與 `>` 的差別只有這個輸入分得出來。
    """
    user = await create_user(db_session)
    row = _session_row(user.id)
    row.expires_at = row.issued_at
    db_session.add(row)
    with pytest.raises(IntegrityError) as exc:
        await db_session.commit()
    assert "expires_after_issued" in str(exc.value)
    await db_session.rollback()


async def test_start_session_writes_a_row_matching_the_issued_token(db_session):
    user = await create_user(db_session)

    issued = await start_session(db_session, user.id)

    claims = decode_refresh_token(issued.refresh_token)
    assert decode_access_token(issued.access_token) == user.id

    row = await db_session.scalar(
        select(RefreshSession).where(RefreshSession.jti == claims.jti)
    )
    assert row is not None
    assert row.user_id == user.id
    assert row.used_at is None
    assert row.revoked_at is None


async def test_two_logins_start_two_separate_families(db_session):
    """每次登入是獨立的一條鏈 —— 否則在手機上登出會把桌機也一起登出，
    而規格 §1 的整個出發點就是要能只撤銷一台裝置。

    如果 `start_session` 改成每次都用同一個固定 family_id，第二次
    `start_session` 會先在 Task 1 那個部分唯一索引撞
    `IntegrityError`（一個 family 最多一張活票）——最下面那行
    assertion 其實根本跑不到。這條測試仍然值得留著（它釘住的是
    「這裡呼叫的是 start_session，行為應該是兩條獨立的鏈」這個意圖），
    但如果日後有人弱化那個索引，讓它不再擋，這行 assertion 才是
    真正在守這個不變量的最後一道防線。
    """
    user = await create_user(db_session)

    first = await start_session(db_session, user.id)
    second = await start_session(db_session, user.id)

    first_family = (
        await db_session.scalar(
            select(RefreshSession).where(
                RefreshSession.jti == decode_refresh_token(first.refresh_token).jti
            )
        )
    ).family_id
    second_family = (
        await db_session.scalar(
            select(RefreshSession).where(
                RefreshSession.jti == decode_refresh_token(second.refresh_token).jti
            )
        )
    ).family_id

    assert first_family != second_family


async def test_login_endpoint_creates_a_session_row(client, db_session):
    """端點層：登入回的 refresh token 必須真的對應到一列。

    只測 start_session 不夠 —— login() 有可能繞過它自己簽一張票，
    那樣所有 sessions.py 的單元測試都還是綠的。
    """
    user = await create_user(db_session)

    response = await client.post(
        "/api/auth/login",
        json={"email": user.email, "password": DEFAULT_PASSWORD},
    )

    assert response.status_code == 200
    claims = decode_refresh_token(response.json()["refresh_token"])
    row = await db_session.scalar(
        select(RefreshSession).where(RefreshSession.jti == claims.jti)
    )
    assert row is not None
    assert row.user_id == user.id


async def test_start_session_commits_the_row(db_session):
    """**這條測試守的是這個 task 唯一真正的決定：sessions.py 自己管交易。**

    `commit` 不能弱化成 `flush`，也不能省略 —— production 的 `get_db` 是
    per-request，session 一關就把沒 commit 的 INSERT 丟掉，登入會發出一張
    沒有對應資料列的票，Task 4 之後每一次換發都 401。

    而預設情況下這件事**測不出來**：測試的 `db_session` 用 create_savepoint，
    `commit()` 只是 RELEASE SAVEPOINT，對同一個 session 來說「有沒有 commit」
    不可觀察（實測：把 commit 整行刪掉，476 個測試全綠）。

    下面那行 `rollback()` 就是把它變成可觀察的：沒 commit 的話那一列還在
    savepoint 裡，rollback 會把它抹掉；commit 過的不會。
    """
    user = await create_user(db_session)
    issued = await start_session(db_session, user.id)

    await db_session.rollback()

    claims = decode_refresh_token(issued.refresh_token)
    row = await db_session.scalar(
        select(RefreshSession).where(RefreshSession.jti == claims.jti)
    )
    assert row is not None


async def test_rotation_issues_a_new_token_in_the_same_family(db_session):
    user = await create_user(db_session)
    first = await start_session(db_session, user.id)

    second = await rotate_session(db_session, first.refresh_token)

    first_row = await db_session.scalar(
        select(RefreshSession).where(
            RefreshSession.jti == decode_refresh_token(first.refresh_token).jti
        )
    )
    second_row = await db_session.scalar(
        select(RefreshSession).where(
            RefreshSession.jti == decode_refresh_token(second.refresh_token).jti
        )
    )

    assert first_row.used_at is not None
    assert second_row.used_at is None
    assert second_row.family_id == first_row.family_id


async def test_the_old_token_stops_working_after_rotation(db_session):
    """**這個專案要修的就是這一件事。**

    注意「換發後新票可用」那種測試對這個缺陷零鑑別力 —— 它在修好之前
    就是綠的，修好之後也是綠的，跟缺陷的重疊區間是空的（§6 第 6 條）。
    有鑑別力的形狀只有一種：拿【舊】票再換一次，必須失敗。
    """
    user = await create_user(db_session)
    first = await start_session(db_session, user.id)
    await rotate_session(db_session, first.refresh_token)

    with pytest.raises(TokenError):
        await rotate_session(db_session, first.refresh_token)


async def test_reusing_a_spent_token_revokes_the_whole_family(db_session):
    """三層鏈，不是兩層。

    A → B → C 之後拿 B 重用：B 失效是本來就會發生的事（它已經 used_at 了），
    真正要證明的是 **C 也一起死**。只驗兩層的話，把「撤銷整個 family」
    改成「只撤銷這一列」，測試照樣綠。
    """
    user = await create_user(db_session)
    a = await start_session(db_session, user.id)
    b = await rotate_session(db_session, a.refresh_token)
    c = await rotate_session(db_session, b.refresh_token)

    with pytest.raises(ReuseDetectedError):
        await rotate_session(db_session, b.refresh_token)

    # C 必須也死了
    with pytest.raises(TokenError):
        await rotate_session(db_session, c.refresh_token)


async def test_replaying_a_token_from_an_already_revoked_family_is_a_plain_token_error(
    db_session,
):
    """`_reject` 判定重用的條件是 `row.revoked_at is None and row.used_at is not None`
    ——`revoked_at is None` 這半沒有任何測試釘住（審查者實測：拿掉它、只留
    `row.used_at is not None`，21 passed，沒有任何東西變紅）。

    今天拿掉它行為差異是零，但這個條件很快就會控制一條安全日誌（重用偵測會
    記一筆 warning）：拿掉之後，每次有人重放一張**早就死掉**的票（family
    已經因為之前的重用事件被整條撤銷），都會再發一次重用警報，把真正的
    事件淹掉。

    重建 test_reusing_a_spent_token_revokes_the_whole_family 的狀態
    （A → B → C，重放 B 觸發整條撤銷），然後**再重放一次 B**（不是 C——
    C 的 `used_at` 從來沒被設定過，不管 `revoked_at` 那半條件在不在，
    C 都會落到單純 TokenError 那條路，對這個條件零鑑別力）。
    這次 B 的 `used_at` 與 `revoked_at` 都已經被設定，必須是單純的
    TokenError，不能是 ReuseDetectedError。
    """
    user = await create_user(db_session)
    a = await start_session(db_session, user.id)
    b = await rotate_session(db_session, a.refresh_token)
    await rotate_session(db_session, b.refresh_token)

    with pytest.raises(ReuseDetectedError):
        await rotate_session(db_session, b.refresh_token)

    with pytest.raises(TokenError) as exc_info:
        await rotate_session(db_session, b.refresh_token)
    assert not isinstance(exc_info.value, ReuseDetectedError)


async def test_reuse_detection_persists_the_revocation(db_session):
    """撤銷必須真的寫進資料庫，不能只是「拋了例外」。

    §6 第 3 條與第 7 條的組合：例外拋出後路由不會 commit，如果撤銷是靠
    呼叫端 commit 的，它會被 rollback 掉 —— 結果是「回了 401，但票還活著」，
    而只斷言例外的測試完全看不到這件事。
    """
    user = await create_user(db_session)
    # 先把 id 取出來。下面的 rollback() 會讓 user 這個 ORM 物件過期，
    # 之後再讀 user.id 會觸發一次同步的 refresh 查詢，在 async 環境下
    # 直接炸 MissingGreenlet —— 那會讓這條測試以「崩潰」而不是
    # 「斷言失敗」的方式變紅，而崩潰是偶然的守衛（見本計畫開頭那一節）。
    user_id = user.id
    a = await start_session(db_session, user_id)
    # 不賦值：這裡只需要「A 已經被輪替過一次」這件事，留著未使用的變數
    # ruff 會報 F841。
    await rotate_session(db_session, a.refresh_token)

    with pytest.raises(ReuseDetectedError):
        await rotate_session(db_session, a.refresh_token)

    # **這一行不能省。** 沒有它，這個測試證明的只是「撤銷在記憶體裡」——
    # 測試的 db_session 用 create_savepoint，commit 只是 RELEASE SAVEPOINT，
    # 「有沒有 commit」對同一個 session 不可觀察（見本計畫開頭那一節）。
    # rollback 之後還讀得到的，才是真的寫進資料庫的。
    await db_session.rollback()

    # 選欄位而不是實體，同樣是為了不在 rollback 之後碰 ORM 屬性。
    revoked_at_values = (
        await db_session.scalars(
            select(RefreshSession.revoked_at).where(RefreshSession.user_id == user_id)
        )
    ).all()
    assert len(revoked_at_values) == 2
    assert all(value is not None for value in revoked_at_values)


async def test_revoking_one_family_leaves_another_family_alone(db_session):
    """手機外洩不該把桌機一起弄掉。"""
    user = await create_user(db_session)
    phone = await start_session(db_session, user.id)
    desktop = await start_session(db_session, user.id)
    await rotate_session(db_session, phone.refresh_token)

    with pytest.raises(ReuseDetectedError):
        await rotate_session(db_session, phone.refresh_token)

    # 桌機那條鏈完全沒被波及：仍然能正常輪替，而且新列沒有被撤銷
    # （斷言 access_token 非空沒有鑑別力——JWT 字串永遠非空）。
    rotated = await rotate_session(db_session, desktop.refresh_token)
    rotated_row = await db_session.scalar(
        select(RefreshSession).where(
            RefreshSession.jti == decode_refresh_token(rotated.refresh_token).jti
        )
    )
    assert rotated_row.revoked_at is None


async def test_rotation_rejects_a_token_whose_row_does_not_exist(db_session):
    """簽章有效、jti 格式正確，但資料庫裡沒有這一列 —— 例如上線前發出的票
    （規格 §7），或資料庫被還原到更早的時間點。

    user_id 用任意整數就好，不需要真的建一個使用者：rotate_session 從頭到尾
    只查 refresh_sessions 這張表，不會查 users（使用者被刪除時 ON DELETE
    CASCADE 已經處理掉了，見 rotate_session 的呼叫端註解）。
    """
    orphan = create_refresh_token(999_999, uuid4())

    with pytest.raises(TokenError):
        await rotate_session(db_session, orphan)


async def test_logout_revokes_the_whole_family(db_session):
    """三層鏈：登出時手上那張可能已經輪替過好幾輪，撤銷必須及於整條鏈。

    **端點層測不到這件事**：鏈上任一張票在登出後都回 401，不管是因為
    「已撤銷」還是因為「已用過」——那兩條路徑刻意回同一個 401。
    """
    user = await create_user(db_session)
    user_id = user.id
    a = await start_session(db_session, user_id)
    b = await rotate_session(db_session, a.refresh_token)

    await revoke_session(db_session, b.refresh_token)

    revoked = (
        await db_session.scalars(
            select(RefreshSession.revoked_at).where(RefreshSession.user_id == user_id)
        )
    ).all()
    assert len(revoked) == 2
    assert all(value is not None for value in revoked)


async def test_logout_persists_the_revocation(db_session):
    """撤銷必須真的寫進資料庫。rollback 之後還讀得到的才算數
    （見本計畫開頭那一節）。
    """
    user = await create_user(db_session)
    user_id = user.id
    issued = await start_session(db_session, user_id)

    await revoke_session(db_session, issued.refresh_token)
    await db_session.rollback()

    revoked = (
        await db_session.scalars(
            select(RefreshSession.revoked_at).where(RefreshSession.user_id == user_id)
        )
    ).all()
    assert revoked and all(value is not None for value in revoked)
