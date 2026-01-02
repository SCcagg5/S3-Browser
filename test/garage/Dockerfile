FROM alpine:3.21

COPY ./binaries/garage-v2.1.0-linux-amd64.tgz /tmp/garage.tgz

RUN tar -xzf /tmp/garage.tgz -C /bin \
    && chmod +x /bin/garage \
    && rm -f /tmp/garage.tgz

COPY ./scripts/entrypoint.sh /bin/entrypoint.sh
COPY ./scripts/healthcheck.sh /bin/healthcheck.sh

EXPOSE 3900 3901 3902 3903

ENTRYPOINT ["/bin/sh", "/bin/entrypoint.sh"]
HEALTHCHECK --interval=10s --timeout=1s \
            --start-period=0s --start-interval=5s \
            --retries=3 \
            CMD ["/bin/sh", "/bin/healthcheck.sh"]
