FROM python:3.12-slim
# nodejs: yt-dlp runs YouTube's own scripts to find the audio address. ffmpeg: for the rare format that needs it.
RUN apt-get update && apt-get install -y --no-install-recommends nodejs ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -U yt-dlp
WORKDIR /app
COPY server.py .
ENV PORT=8080
EXPOSE 8080
CMD ["python", "server.py"]
