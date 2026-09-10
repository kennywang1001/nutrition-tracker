"""Pytest 根目錄 conftest.py。

在任何測試模組匯入 `app` 之前，先把測試用的 JWT_SECRET 灌進環境變數。

為什麼要獨立成根目錄的檔案，而不是加在 `tests/conftest.py` 開頭：
`tests/conftest.py` 一開始就 import 了一串標準函式庫與第三方套件，最後才
`from app.db import get_db` / `from app.main import app`（匯入 `app.db` 會
連帶匯入 `app.config`，`Settings()` 在那個當下就會被建立）。如果把設定
環境變數的呼叫插在 `tests/conftest.py` 現有的那串 import 中間，後面所有的
import 都會被 ruff 的 E402（module level import not at top of file）擋下來——
只要檔案裡出現一個非 import 的陳述式，之後的 import 就不再算是「檔案開頭」。

pytest 會先載入 rootdir 的 conftest.py，再載入子目錄的 conftest.py
（`tests/conftest.py` 在 `tests/` 底下，是子目錄），所以只要這個檔案
放在專案根目錄，就保證會在任何測試模組——包含 `tests/conftest.py`
——匯入 `app` 之前執行。這個檔案本身完全不 import 任何 `app.*`，
所以不會有 E402 的兩難：`import os` 是檔案裡唯一的 import，
之後只有一行呼叫，順序上完全合法。

這裡用 `setdefault` 而不是直接指派：如果使用者的殼層已經自己設了
JWT_SECRET（例如想測「production 設定」在本機的行為），要尊重那個值，
不要覆蓋掉。
"""

import os

os.environ.setdefault(
    "JWT_SECRET",
    "pytest-only-secret-do-not-use-outside-tests",
)
