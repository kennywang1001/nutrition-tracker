FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml requirements-lock.txt ./
COPY app/__init__.py ./app/__init__.py
# production 映像不裝 [dev]（pytest / mypy / ruff / httpx / pytest-cov）：
# 這些在 production 沒有用途，只會把映像變大、把攻擊面變寬（陷阱 4）。
# CI 不受影響——CI 是直接在 runner 上 `pip install -e ".[dev]"`，不經過這個
# Dockerfile（見 .github/workflows/ci.yml），已實測確認。
# 本機開發也不受影響——測試一律透過 .venv（host）執行，從不在容器內跑 pytest。
RUN pip install --no-cache-dir -c requirements-lock.txt -e .

COPY . .

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
