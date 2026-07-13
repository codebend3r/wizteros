FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY store.py wizarr.py stripe_wizarr_bridge.py .
ENV MAP_DB_PATH=/data/bridge.db
VOLUME ["/data"]
CMD ["uvicorn", "stripe_wizarr_bridge:app", "--host", "0.0.0.0", "--port", "8000"]
