FROM python:3.12-slim
WORKDIR /app
RUN groupadd --gid 10001 workstation && useradd --uid 10001 --gid workstation --no-create-home workstation \
    && mkdir /data && chown workstation:workstation /data
COPY --chown=10001:10001 cloud_server.py /app/cloud_server.py
USER 10001:10001
ENV CLOUD_DATA_DIR=/data PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
EXPOSE 8787
ENTRYPOINT ["python", "/app/cloud_server.py"]
CMD ["serve", "--host", "0.0.0.0", "--port", "8787"]
