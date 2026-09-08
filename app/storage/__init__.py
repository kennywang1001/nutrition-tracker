"""檔案儲存：所有跟檔案系統打交道的程式碼集中在這個套件底下（規格第 8 節）。

真要把儲存後端換成 MinIO 之類的物件儲存，改動範圍就是 `app/storage/photos.py`，
呼叫端（`app/api/routes/meals.py`）完全不用碰。刻意不預先抽象出一個
storage interface —— 現在只有一種實作，抽象只會是猜測。
"""
