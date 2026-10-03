FROM busybox:1.36.1

ARG FIXTURE_VARIANT
ARG FIXTURE_HEALTHY=true

ENV FIXTURE_VARIANT=${FIXTURE_VARIANT}
ENV FIXTURE_HEALTHY=${FIXTURE_HEALTHY}

RUN printf '%s\n' "${FIXTURE_VARIANT}" > /fixture-variant

HEALTHCHECK --interval=1s --timeout=1s --start-period=1s --retries=2 \
  CMD test "${FIXTURE_HEALTHY}" = "true"

CMD ["sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 1; done"]
