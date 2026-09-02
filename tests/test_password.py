from app.security.password import hash_password, verify_password


def test_hash_is_not_the_plain_password():
    hashed = hash_password("my-secret-password")
    assert hashed != "my-secret-password"
    assert hashed.startswith("$argon2")


def test_same_password_produces_different_hashes():
    """每次雜湊都要用不同的 salt，否則相同密碼的使用者會有相同雜湊值。"""
    assert hash_password("same") != hash_password("same")


def test_verify_accepts_the_correct_password():
    hashed = hash_password("my-secret-password")
    assert verify_password("my-secret-password", hashed) is True


def test_verify_rejects_the_wrong_password():
    hashed = hash_password("my-secret-password")
    assert verify_password("wrong-password", hashed) is False


def test_verify_rejects_a_malformed_hash():
    assert verify_password("anything", "not-a-real-hash") is False
