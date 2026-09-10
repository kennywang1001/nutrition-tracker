"""`app/storage/photos.py` 的純函式層級測試 —— 完全不經過 HTTP（計畫 3 Task 13）。

這是整個計畫攻擊面最大的一支：檔案內容是使用者能完全控制的輸入。
五個安全性質，每一個都要有測試「證明擋得住」，而不是只證明「正常輸入能過」。
"""

import io
import warnings
from pathlib import Path

import pytest
from PIL import Image
from PIL.ExifTags import IFD
from PIL.ExifTags import Base as ExifBase
from PIL.TiffImagePlugin import IFDRational

from app.config import settings
from app.storage.photos import (
    MAX_DIMENSION,
    MAX_IMAGE_PIXELS,
    InvalidImageError,
    delete_photo,
    save_photo,
)


def _jpeg_bytes(width: int, height: int) -> bytes:
    image = Image.new("RGB", (width, height), color=(200, 100, 50))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG")
    return buffer.getvalue()


def _png_bytes(width: int, height: int) -> bytes:
    image = Image.new("RGBA", (width, height), color=(10, 20, 30, 255))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _jpeg_with_gps_exif() -> bytes:
    """建一張真的帶 GPS EXIF 的 JPEG —— 手機拍照預設會寫入的那種標籤。

    用 Pillow 自己的 `Image.Exif` 建，不靠第三方 exif 函式庫：GPSInfo 是
    tag 0x8825（34853），指向一個嵌套的 IFD，裡面放緯度／經度
    （度、分、秒三個 RATIONAL）與方向參考（N／E）—— 跟真實手機寫的 EXIF
    結構一致，不是隨便塞一個假欄位。
    """
    image = Image.new("RGB", (2000, 1500), color=(200, 100, 50))
    exif = image.getexif()
    exif[ExifBase.Make.value] = "TestPhone"

    def rational(numerator: int, denominator: int = 1) -> IFDRational:
        return IFDRational(numerator, denominator)

    gps_ifd = {
        1: "N",  # GPSLatitudeRef
        2: (rational(25), rational(2), rational(30)),  # GPSLatitude：25°2'30"N
        3: "E",  # GPSLongitudeRef
        4: (rational(121), rational(30), rational(0)),  # GPSLongitude：121°30'0"E
    }
    exif[ExifBase.GPSInfo.value] = gps_ifd

    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", exif=exif)
    return buffer.getvalue()


def _solid_color_bomb_png(width: int, height: int) -> bytes:
    """一個真正的解壓縮炸彈：檔案幾百 KB，但宣告／解碼出來的尺寸是幾千萬像素。

    刻意用**純色**畫布：DEFLATE 對高度重複的資料壓縮率極好，讓一張
    `width * height` 上億像素的圖片壓縮後只有幾百 KB —— 這正是解壓縮炸彈
    的攻擊手法本身（小檔案、巨大的解碼後記憶體用量）。

    這裡刻意不用「只有 IHDR、沒有真正像素資料」的截斷檔案（那是這個測試
    第一版寫法，之後在突變測試時發現的問題）：那種檔案在拿掉 save_photo()
    明確的尺寸檢查之後，會在 `image.load()` 那一步因為「資料截斷」而
    失敗 —— 測試看起來還是紅燈變綠燈，但擋下它的其實是解碼錯誤，不是
    尺寸檢查，等於測試從一開始就沒有鑑別力（計畫繼承規矩第 8 條：
    測試沒被觀察到用正確原因失敗過，就不算數）。這裡改用一張真的能被
    完整解碼的圖片，拿掉尺寸檢查後 `image.load()` 會成功、`save_photo()`
    會正常寫出檔案 —— 測試才會真的因為「沒有擋下巨大尺寸」而失敗，
    而不是巧合地因為別的原因失敗。
    """
    image = Image.new("L", (width, height), color=128)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", compress_level=1)
    return buffer.getvalue()




def test_saving_a_normal_jpeg_returns_a_relative_path_and_the_file_exists():
    rel_path = save_photo(_jpeg_bytes(800, 600), user_id=42)

    assert not Path(rel_path).is_absolute()
    assert rel_path.startswith("42/")
    assert rel_path.endswith(".jpg")
    saved = Path(settings.photo_dir) / rel_path
    assert saved.is_file()


def test_a_photo_wider_than_1280_is_shrunk_to_exactly_1280_on_the_long_side():
    rel_path = save_photo(_jpeg_bytes(2000, 1000), user_id=1)

    # `with` 是刻意的：Image.open() 對真正的檔案路徑是惰性開檔，不主動關閉的話
    # 底層的 file handle 要等垃圾回收才會關，在 -W error 下會變成
    # ResourceWarning -> 例外，而且看起來跟這個測試在驗證的事完全無關。
    with Image.open(Path(settings.photo_dir) / rel_path) as saved:
        size = saved.size
    assert max(size) == MAX_DIMENSION
    assert size == (1280, 640)  # 比例不變：2000:1000 == 1280:640


def test_a_photo_smaller_than_1280_is_not_upscaled():
    rel_path = save_photo(_jpeg_bytes(600, 400), user_id=1)

    with Image.open(Path(settings.photo_dir) / rel_path) as saved:
        size = saved.size
    assert size == (600, 400)


def test_a_png_upload_is_saved_as_a_jpeg():
    rel_path = save_photo(_png_bytes(500, 500), user_id=1)

    with Image.open(Path(settings.photo_dir) / rel_path) as saved:
        fmt = saved.format
    assert fmt == "JPEG"


def test_gps_exif_does_not_survive_saving():
    """第 5 項：這是飲食紀錄 app，照片在家裡和餐廳拍，手機預設會把 GPS 寫進
    EXIF。原樣存下來再透過 API 發出去，等於附贈一份使用者的位置歷史。
    """
    raw = _jpeg_with_gps_exif()

    # 先確認 fixture 本身真的帶了 GPS —— 不然「存完是空的」這個斷言對一張
    # 本來就沒有 GPS 的圖片永遠是空轉的（計畫繼承規矩第 8 條：測試沒被
    # 觀察到失敗過就不算證據）。
    before = Image.open(io.BytesIO(raw))
    before_gps = dict(before.getexif().get_ifd(IFD.GPSInfo))
    assert before_gps, f"測試 fixture 本身沒有 GPS EXIF，這個測試會是空轉的：{before_gps}"
    assert before.info.get("exif") is not None

    rel_path = save_photo(raw, user_id=1)

    with Image.open(Path(settings.photo_dir) / rel_path) as after:
        after_exif = dict(after.getexif())
        after_gps = dict(after.getexif().get_ifd(IFD.GPSInfo))
        after_info_exif = after.info.get("exif")
    assert after_exif == {}, f"存檔後不該留有任何 EXIF，實際上還有：{after_exif}"
    assert after_gps == {}, f"存檔後不該留有 GPS，實際上還有：{after_gps}"
    assert after_info_exif is None


def test_non_image_content_raises_invalid_image_error():
    with pytest.raises(InvalidImageError):
        save_photo(b"this is definitely not an image, just some plain text", user_id=1)


def test_a_declared_decompression_bomb_is_rejected():
    """第 7 項：尺寸刻意選在「超過上限、但不到兩倍上限」的區間 ——
    Pillow 內建機制在這個區間只發 `DecompressionBombWarning`（警告，不是
    例外），只有超過兩倍上限才會無條件硬拋 `DecompressionBombError`。

    但光是選對區間還不夠。專案的 pytest 設定帶 `-W error`，它會把那個警告
    轉成例外，於是這個測試在平常的跑法下**走的是警告那條路，根本碰不到
    我們的守衛** —— 守衛只有在不帶 `-W error` 時才會被執行到。
    也就是說：套件平常的跑法從來沒有真的測過它。

    所以這裡主動把那個警告消音，讓 `save_photo()` 裡明確的尺寸檢查成為
    **唯一可能拋例外的東西**，並且比對錯誤訊息確認是它拋的。這樣一來，
    `-W error` 是開是關，這個測試驗證的都是同一件事。

    （先前的做法是在驗收時額外手動跑一次不帶 `-W error` 的驗證。
    那種驗證留不下來 —— 它不在套件裡，就保護不了任何人。）
    """
    bomb_pixels = 9_000 * 7_000
    assert MAX_IMAGE_PIXELS < bomb_pixels < 2 * MAX_IMAGE_PIXELS
    bomb = _solid_color_bomb_png(9_000, 7_000)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", Image.DecompressionBombWarning)
        with pytest.raises(InvalidImageError, match="解壓縮炸彈"):
            save_photo(bomb, user_id=1)


def test_delete_photo_of_a_missing_file_does_not_raise():
    delete_photo("no-such-user/no-such-file.jpg")
