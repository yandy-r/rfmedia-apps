# FROM ghcr.io/hotio/lidarr:pr-plugins
FROM ghcr.io/linuxserver-labs/prarr:lidarr-plugins

RUN apk add --no-cache ffmpeg
