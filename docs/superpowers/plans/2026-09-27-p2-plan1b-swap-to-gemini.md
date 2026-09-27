# P2 計畫一 b：把 Anthropic 換成 Gemini Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `AnthropicEstimator` 換成 `GeminiEstimator`，其餘一律不動。

**Architecture:** `NutritionEstimator` Protocol 不變，所以端點、額度、一致性檢查、以及所有注入假 estimator 的測試都不受影響。只換 Protocol 背後那一個實作。

**Tech Stack:** Python 3.12 · google-genai 2.25.0 · Pydantic v2 · pytest

**規格：** [2026-09-27-p2-ai-analysis-design.md](../specs/2026-09-27-p2-ai-analysis-design.md)
**前一份：** [計畫一：AI 分析的後端](2026-09-27-p2-plan1-backend.md)（已合併，PR #14）

---

## 為什麼有這一份

使用者決定用 Gemini 而不是 Anthropic。

**這正好驗證了 Task 4 的一個設計決定。** 當時寫：

> Protocol 不是為了「將來換供應商」寫的，是為了測試能斷言它沒被呼叫。

結果它兩件事都做到了。556 則測試裡，**只有 Task 4 那 15 條會受影響** ——
而且是因為它們測的是 Anthropic 特有的回應形狀，不是因為架構綁死。

---

## 開工前必讀

### 1. 計畫的文字不是權威

發現實際情況跟計畫寫的不一樣就**停下來報告**。前一份計畫六個 task 裡有
四個回報了計畫的錯，那四個回報是那幾個 task 最有價值的產出。

### 2. 綠燈在被觀察到失敗之前不算證據

### 3. 指令（Windows + Git Bash）

```bash
cd F:/wallet && ./.venv/Scripts/python.exe -m pytest -q          # 全套約 70 秒
cd F:/wallet && ./.venv/Scripts/ruff.exe check .
cd F:/wallet && ./.venv/Scripts/mypy.exe app
```

**不要跑 `ruff format`**。**不要真的打 Gemini API**（沒有金鑰，而且會花錢）。

### 4. 基準線

```
後端 pytest  556 passed
ruff check   All checks passed
mypy app     no issues in 56 source files
```

---

## 開工前已經查證過的事實

**`google-genai` 2.25.0 已經裝進 `.venv`**（為了查形狀），以下全部是實際
inspect 出來的，不是從記憶裡寫的：

| 事實 | 怎麼查的 |
|---|---|
| `google.genai.Client(api_key=…)`，非同步走 `client.aio` | `inspect.signature(Client.__init__)`、`hasattr(Client, "aio")` |
| `client.aio.models.generate_content(*, model, contents, config)` | `inspect.signature(AsyncModels.generate_content)` |
| `contents` **直接吃 `PIL.Image.Image`**（也吃 `str` / `Part` / list） | 同上的型別註解 |
| `types.Part.from_bytes` 存在 | `hasattr` |
| `GenerateContentConfig` 有 `response_mime_type` / `response_schema` / `system_instruction` / `temperature` | `model_fields` |
| 回應有 **`.text`**，**沒有 `.parsed`** | `dir(GenerateContentResponse)` |
| 錯誤類別：`APIError` / `ClientError` / `ServerError` / `UnknownApiResponseError` | `dir(google.genai.errors)` |

### 比 Anthropic 那版簡單的三處

| | Anthropic（現況） | Gemini |
|---|---|---|
| 圖片 | base64 block + `media_type` 四選一 `Literal` | `contents` 直接吃 `PIL.Image.Image`，**而 `pillow` 早就是相依** |
| 回應 | `list[ContentBlock]` 判別聯集，要 `isinstance(block, TextBlock)` | `response.text` |
| 結構化輸出 | `output_config` + `transform_schema` | `response_mime_type="application/json"` + `response_schema` |

### ⚠️ 安裝時降級了 websockets

`pip install google-genai` 把 `websockets` 從 17.1 降到 16.1.1，而
`uvicorn[standard]` 用 websockets。**實測 556 則測試仍然全過**，但這件事
要在 lock 檔的 diff 裡看得到，不要當作沒發生。

### ⚠️ NAS 的 PyPI 連線會逾時

上一次部署（PR #14 合併之後）失敗：

```
ReadTimeoutError: HTTPSConnectionPool(host='files.pythonhosted.org'): Read timed out.
failed to solve: pip install --no-cache-dir -c requirements-lock.txt -e .
```

**所以 NAS 上目前還是舊映像（沒有 AI 端點）。** 而 `google-genai` 拉的
相依比 `anthropic` **多得多**（`cryptography`、`google-auth`、`requests`、
`urllib3`、`tenacity`…），在一條會逾時的線路上只會更糟。

**這是部署時的已知風險，不是這份計畫要解決的問題** —— 但收尾時要正視它，
不要假裝 `up -d --build` 一定會成功。

### 模型名稱不要猜

`ai_model` 是設定值。**預設填什麼請在實作時查證**，不要從記憶裡寫 ——
這個專案每次從記憶裡拿模型名稱、API 形狀、欄位名都錯過。

如果查不到權威來源，**就把預設留成一個明顯需要使用者設定的值，並在
`.env.production.example` 裡講清楚**，讓第一次真的呼叫時由 API 的錯誤
訊息告訴我們有哪些合法值。那比猜一個看起來合理、實際上不存在的名字好 ——
後者的失敗訊息會是「model not found」，而人會先去懷疑金鑰或網路。

---

## Task 1: 換掉實作

**Files:**
- Modify: `pyproject.toml`（拿掉 `anthropic`，加 `google-genai`）
- Modify: `requirements-lock.txt`
- Modify: `app/config.py`（`anthropic_api_key` → `gemini_api_key`，`ai_model` 預設值）
- Modify: `app/ai/estimator.py`（`AnthropicEstimator` → `GeminiEstimator`）
- Modify: `app/api/deps.py`（`get_estimator()` 讀新的設定）
- Modify: `tests/test_config.py`
- Modify: `tests/test_ai_estimator.py`
- Modify: `.env.production.example`
- Modify: `docker-compose.yml`
- Modify: `docs/deployment.md`

### 什麼不能動

**`NutritionEstimator` Protocol、`RawEstimate`、`parse_raw_estimate()` 都不要改。**

- `parse_raw_estimate()` 只吃字串，跟供應商無關 —— 它那 15 條測試裡，
  **只有斷言錯誤訊息措辭的那幾條可能要動**，解析邏輯本身一條都不用改
- `app/api/routes/ai.py` **一行都不要動**
- `tests/test_ai_analyze.py` **一行都不要動**（它注入假 estimator）
- `tests/test_ai_consistency.py` **一行都不要動**（純算術）

**如果你發現非改不可，停下來報告** —— 那代表 Protocol 的邊界劃錯了，
而那是一個比「換供應商」更重要的發現。

### 空字串金鑰的正規化要跟著改名

`app/config.py` 的 `_empty_key_is_no_key` validator 目前綁在
`anthropic_api_key` 上。**改名之後那個 validator 要跟著指到新欄位。**

漏掉的話：compose 傳的 `${GEMINI_API_KEY:-}` 在沒設值時是**空字串**，
Pydantic 解析成 `''` 不是 `None`，於是 `is None` 為 False，程式拿一把空
金鑰去打 API —— **使用者看到的是 Google 的認證錯誤，而不是「你沒設定
AI」。看起來是開著的比明確關閉更糟。**

那個缺陷**只有在容器裡才看得到**（本機 `.env` 沒有那個變數），所以
`tests/test_config.py` 那兩條成對的測試（空字串變 `None`、**而真的金鑰
不能被吃掉**）也要跟著改名並保留。第二條是必要的 —— 只有第一條的話，
一個「永遠回 `None`」的 validator 也會全綠，而那會讓 AI 永遠開不了。

### prompt 照搬，只改結構化輸出的接法

現有的 system prompt 四個硬要求跟供應商無關，**照搬**：

1. 回 JSON，欄位名跟 `RawEstimate` 對齊（含 `serving_` 前綴）
2. 要求它估「一份」是幾克
3. **只回一樣食物**，不要陣列（規格 §9）
4. **不要在 prompt 裡要求它自己檢查 Atwater** —— 那是 `consistency.py`
   的工作，而那一層的價值就在於它不是 LLM 說的

- [ ] **Step 1: 查證 `response_schema` 吃什麼形狀**

```bash
cd F:/wallet && ./.venv/Scripts/python.exe -c "
from google.genai import types
f = types.GenerateContentConfig.model_fields['response_schema']
print('response_schema 型別:', f.annotation)
"
```

它可能吃 pydantic model、可能吃 dict schema，**兩者的行為不同**。
把結果寫進報告。

- [ ] **Step 2: 改設定與相依**

`pyproject.toml`：拿掉 `anthropic>=0.40`，加 `google-genai>=2.25`。

```bash
cd F:/wallet && ./.venv/Scripts/python.exe -m pip uninstall -y anthropic 2>&1 | tail -2
cd F:/wallet && ./.venv/Scripts/python.exe -m pip install -e ".[dev]" 2>&1 | tail -3
cd F:/wallet && ./.venv/Scripts/python.exe -m pip freeze > requirements-lock.txt
```

> **`pip freeze` 會寫進一行 `-e git+https://…#egg=wallet`**，而那一行留在
> lock 檔裡**會炸 Docker build** —— `Dockerfile` 用
> `pip install -c requirements-lock.txt -e .`，pip 不允許 constraints 含
> editable 需求。**手動移除那一行**（前一份計畫 Task 1 踩過並實測確認）。
>
> 跑完用 `git diff requirements-lock.txt` 看清楚增減，寫進報告。

- [ ] **Step 3: 改實作**

- [ ] **Step 4: 改測試**

- [ ] **Step 5: 全套驗證**

```bash
cd F:/wallet && ./.venv/Scripts/python.exe -m pytest -q
cd F:/wallet && ./.venv/Scripts/ruff.exe check . && ./.venv/Scripts/mypy.exe app
```

**`tests/test_ai_analyze.py` 的 10 條與 `tests/test_ai_consistency.py` 的
6 條必須一條都沒改就全綠。** 那是這次換供應商「只動一個實作」的證據 ——
**在報告裡明確說出這兩個檔案的 `git diff` 是空的。**

- [ ] **Step 6: 突變驗證**

> **必須成立：** 把 `_empty_key_is_no_key` 的正規化拿掉，至少一條測試紅。
>
> **實測填回：** ——

> **必須成立：** 把 `get_estimator()` 的「沒設金鑰就拋 503」拿掉，
> 至少一條測試紅。
>
> **實測填回：** ——

- [ ] **Step 7: 確認 API 表面沒被動到**

改設定不該動到 `openapi.json`，**但要確認**：

```bash
cd F:/wallet && docker compose up -d --build
cd F:/wallet/frontend && npm run gen:api
cd F:/wallet && git diff --stat frontend/src/api/schema.d.ts
```

**預期沒有 diff。** 有 diff 的話代表 API 表面被動到了 —— 停下來報告。

- [ ] **Step 8: Commit**

---

## 收尾

- [ ] 把「實測填回」填上
- [ ] **部署到 NAS** —— 注意 PyPI 逾時的已知風險
- [ ] **用真的金鑰打一次文字入口與一次圖片入口**，把完整回應貼出來
- [ ] **評估估算品質** —— 那會決定前端「確認／修改」的形狀。如果 AI 對
      使用者實際吃的東西常常估很爛，「需要修改」就不該是次要按鈕
