"""餐點照片的儲存：解碼、驗證、去除 EXIF、縮放、存檔，全部集中在這裡
（計畫 3 Task 13，規格第 8 節）。

上傳的圖片內容是使用者能完全控制的輸入，這個模組是整個計畫攻擊面最大的一支：

1. **絕不信任副檔名或 client 宣告的 Content-Type。** 是不是圖片、是什麼格式，
   一律用 Pillow 實際解碼的結果判斷。
2. **絕不用使用者送的檔名。** 檔名由伺服器產生（`uuid4().hex + ".jpg"`），
   路徑穿越、覆寫別人的檔案、Windows 保留字三類問題一次解決。
3. **EXIF（含 GPS）一律不保留。** 這是飲食紀錄 app，照片在家裡和餐廳拍，
   手機預設會把 GPS 座標寫進 EXIF；原樣存下來再透過 API 發出去，
   等於附贈一份使用者的位置歷史。
4. **解壓縮炸彈要擋在解碼像素之前。** 檔案可以只有幾十個 bytes，
   卻宣告一個解碼後要佔用幾 GB 記憶體的尺寸。
"""

import io
import logging
import uuid
from pathlib import Path

from PIL import Image

from app.config import settings

logger = logging.getLogger(__name__)

# 存檔前縮放的長邊上限：只縮不放。手機照片通常遠大於這個尺寸，縮小是為了
# 控制儲存空間與之後讀取的頻寬；已經比較小的圖不該被放大到失真（計畫刻意
# 不做縮圖，這個尺寸就是清單與詳情共用的唯一一份）。
MAX_DIMENSION = 1280

# Pillow 對「宣告尺寸」的預設行為分兩段：超過 MAX_IMAGE_PIXELS 只發
# DecompressionBombWarning（警告，不是例外）；只有超過兩倍才會無條件硬拋
# DecompressionBombError。我們的測試跑在 `-W error` 下，警告會被轉成例外，
# 但正式環境不會有這個設定 —— 所以不能只靠設這個屬性，save_photo() 裡
# 還會自己明確比對一次尺寸，那個檢查不受警告過濾器影響（見下方）。
#
# 60,000,000 像素（6000 萬）：涵蓋絕大多數手機相機的預設輸出（旗艦機的
# 「一般拍照」模式輸出多半在 12～50 MP），同時遠低於典型解壓縮炸彈的量級
# ——那些通常是數億到數十億像素、檔案本身卻只有幾十個 bytes 到幾 KB。
MAX_IMAGE_PIXELS = 60_000_000
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS

# 分塊讀取上傳內容時用的區塊大小；也是路由層 (`app/api/routes/meals.py`)
# 讀取 UploadFile 時使用的常數，放在這裡讓「跟檔案有關的參數」只有一處。
UPLOAD_CHUNK_SIZE = 64 * 1024


class InvalidImageError(Exception):
    """上傳的內容無法被解碼成圖片，或宣告的尺寸超過允許上限（疑似解壓縮炸彈）。"""


def _photo_root() -> Path:
    # 每次呼叫都重新讀 settings.photo_dir，不要在 import 時就快取成常數 ——
    # 測試要能用 `monkeypatch.setattr(settings, "photo_dir", ...)` 換成
    # tmp_path，快取常數的話這個換法會失效（跟 app/security/tokens.py
    # 讀 settings 的方式一致）。
    return Path(settings.photo_dir)


def _assert_within_photo_root(path: Path, root: Path) -> None:
    """寫檔前的 containment 檢查。

    檔名是伺服器自己用 `uuid4().hex` 產生的，理論上這個檢查永遠會通過 ——
    保留它是因為成本只有兩行，換到的是「就算日後有人改了檔名產生邏輯，
    也不會意外寫出 photo_dir 之外的檔案」這種等級的保護（計畫 3 Task 13）。
    """
    resolved = path.resolve()
    root_resolved = root.resolve()
    if resolved != root_resolved and root_resolved not in resolved.parents:
        raise RuntimeError(f"拒絕寫入 photo_dir 之外的路徑：{resolved}")


def _resized(image: Image.Image) -> Image.Image:
    width, height = image.size
    longest = max(width, height)
    if longest <= MAX_DIMENSION:
        return image
    scale = MAX_DIMENSION / longest
    new_size = (round(width * scale), round(height * scale))
    return image.resize(new_size, Image.Resampling.LANCZOS)


def save_photo(content: bytes, *, user_id: int) -> str:
    """把上傳內容解碼、驗證、去除 EXIF、視需要縮小，存成 JPEG。

    回傳相對於 `photo_dir` 的路徑（用 "/" 分隔，不受作業系統影響），
    這就是要寫進 `meals.photo_path` 的值 —— 資料庫只存相對路徑，
    volume 掛載點換了不會全毀。

    路徑分層 `<photo_dir>/<user_id>/<uuid>.jpg`：依使用者分資料夾，
    真的要用 Synology 內建工具瀏覽備份時才好找（規格第 8 節）。
    """
    try:
        # 明確標成 Image.Image（基底類別）而不是讓 mypy 從 Image.open() 的回傳型別
        # （ImageFile，子類別）推斷 —— 底下 convert() / resize() 都回傳 Image.Image，
        # 如果 image 的推斷型別是 ImageFile，之後的重新賦值在 strict mypy 下會報
        #「incompatible types in assignment」。
        image: Image.Image = Image.open(io.BytesIO(content))
        width, height = image.size
    except Exception as exc:
        # 內容不是 Pillow 認得的圖片格式（例如把 .txt 改副檔名）。
        # Image.open() 只解析檔頭，這裡還沒有真的解碼像素 —— 對一般的
        # 非圖片輸入，這一步就會失敗，不需要等到 load() 才發現。
        raise InvalidImageError("無法識別的圖片格式") from exc

    if width * height > MAX_IMAGE_PIXELS:
        # 明確擋下，不依賴 Image.open() 內建的 DecompressionBombWarning ——
        # 那個機制在「介於上限與兩倍上限之間」的尺寸只會警告、不會拋例外，
        # 正式環境（沒有 -W error）會直接放行，等於沒擋。這裡的比較不受
        # 警告過濾器影響：不管有沒有 -W error，結果都一樣。
        # 而且這個檢查一定要在 image.load() 之前，避免真的把巨大的像素
        # 資料解壓進記憶體。
        raise InvalidImageError("圖片尺寸超過允許上限，疑似解壓縮炸彈")

    try:
        image.load()  # 到這裡才真的解碼像素；尺寸檢查已經先做完了
    except Exception as exc:
        raise InvalidImageError("無法識別的圖片格式") from exc

    image = image.convert("RGB")  # JPEG 不支援 alpha；PNG/RGBA 輸入要先轉
    image = _resized(image)

    filename = f"{uuid.uuid4().hex}.jpg"
    rel_path = f"{user_id}/{filename}"
    root = _photo_root()
    dest = root / str(user_id) / filename
    _assert_within_photo_root(dest, root)

    dest.parent.mkdir(parents=True, exist_ok=True)
    # 刻意不傳 exif 參數：Pillow 重新編碼時預設就不會帶 EXIF，GPS 座標
    # （手機預設會寫入）因此不會被存下來，也不會透過 API 洩漏出去。
    image.save(dest, format="JPEG", quality=85)

    return rel_path


def delete_photo(rel_path: str) -> None:
    """盡力刪除一張照片；檔案本來就不存在就當作成功（best-effort）。

    規格第 8 節：兩種孤兒檔案的嚴重性不對稱 —— 多一個沒人引用的檔案只是
    浪費磁碟，少一個被引用的檔案是壞掉的功能。所以刪除永遠是「盡力」，
    失敗只記一筆警告，不讓呼叫端的請求因此失敗。
    """
    target = _photo_root() / rel_path
    try:
        target.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        logger.warning("刪除照片檔案失敗：%s", target, exc_info=True)
