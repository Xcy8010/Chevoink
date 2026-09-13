# Build context MUST be workers/document-import, never the repository or its .env files.
# Official library/debian OCI index digest verified via registry-1.docker.io on 2026-09-13.
# Tested worker image must separately be pinned by its own ID before execution.
ARG BASE_IMAGE=debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132
FROM ${BASE_IMAGE}
ARG BASE_IMAGE
RUN case "$BASE_IMAGE" in debian:trixie-slim@sha256:*) ;; *) exit 2 ;; esac
COPY dependencies.lock /app/dependencies.lock
RUN apt-get update \
    && xargs -r apt-get install -y --no-install-recommends < /app/dependencies.lock \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 importer \
    && useradd --uid 10001 --gid 10001 --home-dir /work --no-create-home --shell /usr/sbin/nologin importer \
    && mkdir -p /work /input \
    && chown 10001:10001 /work \
    && dpkg-query -W > /app/installed-packages.txt \
    && sha256sum /usr/share/tesseract-ocr/5/tessdata/eng.traineddata /usr/share/tesseract-ocr/5/tessdata/chi_sim.traineddata /usr/share/tesseract-ocr/5/tessdata/chi_tra.traineddata > /app/language-data.sha256
COPY --chown=0:0 *.py /app/
COPY --chown=0:0 tests/container_smoke.py /app/tests/container_smoke.py
COPY --chown=0:0 tests/native_gold.py /app/tests/native_gold.py
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 HOME=/work TMPDIR=/tmp LANG=C.UTF-8 OMP_THREAD_LIMIT=1
USER 10001:10001
ENTRYPOINT ["/usr/bin/python3", "/app/main.py"]
