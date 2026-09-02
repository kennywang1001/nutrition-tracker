from app.config import Settings


def test_settings_have_sensible_defaults():
    settings = Settings()

    assert settings.jwt_algorithm == "HS256"
    assert settings.access_token_ttl_minutes == 15
    assert settings.refresh_token_ttl_days == 14


def test_settings_can_be_overridden():
    settings = Settings(jwt_secret="from-test", access_token_ttl_minutes=1)

    assert settings.jwt_secret == "from-test"
    assert settings.access_token_ttl_minutes == 1
