FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml requirements-lock.txt ./
COPY app ./app
RUN pip install --no-cache-dir -c requirements-lock.txt -e ".[dev]"

COPY . .

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
