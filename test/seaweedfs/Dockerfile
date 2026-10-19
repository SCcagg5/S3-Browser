# The SeaweedFS of the test stacks: one process (master, volume, filer and S3 API), from the pinned GitHub release.
# The version and the checksums are the ones of the Home repository (versions.lock).
FROM alpine:3.21

ARG TARGETARCH
ARG SEAWEEDFS_VERSION=4.41
ARG SEAWEEDFS_LINUX_AMD64_SHA256=730f1ede19972c12954ee407b2d97679a2e4486d24fd987d371761ec395571b8
ARG SEAWEEDFS_LINUX_ARM64_SHA256=ecfb79fb8e0f235ea537948c9ea6041cec87c545746d369bf1f10e3ca10aa186

RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) sha="$SEAWEEDFS_LINUX_AMD64_SHA256" ;; \
      arm64) sha="$SEAWEEDFS_LINUX_ARM64_SHA256" ;; \
      *) echo "unsupported architecture ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    wget -q -O /tmp/weed.tgz "https://github.com/seaweedfs/seaweedfs/releases/download/${SEAWEEDFS_VERSION}/linux_${TARGETARCH:-amd64}.tar.gz"; \
    echo "${sha}  /tmp/weed.tgz" | sha256sum -c -; \
    tar -xzf /tmp/weed.tgz -C /usr/local/bin weed; \
    chmod +x /usr/local/bin/weed; \
    rm -f /tmp/weed.tgz

COPY ./scripts/entrypoint.sh /bin/entrypoint.sh
COPY ./scripts/healthcheck.sh /bin/healthcheck.sh

EXPOSE 8333

ENTRYPOINT ["/bin/sh", "/bin/entrypoint.sh"]
HEALTHCHECK --interval=10s --timeout=3s \
            --start-period=0s --start-interval=3s \
            --retries=5 \
            CMD ["/bin/sh", "/bin/healthcheck.sh"]
