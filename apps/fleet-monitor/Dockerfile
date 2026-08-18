FROM python:3.12-slim
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY fleet_monitor/ ./fleet_monitor/
ENV FM_DB_PATH=/data/fleet.db
VOLUME ["/data"]
CMD ["uvicorn", "fleet_monitor.api:app", "--host", "0.0.0.0", "--port", "8010"]
