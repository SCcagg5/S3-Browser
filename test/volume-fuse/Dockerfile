# syntax=docker/dockerfile:1.7
# The container of the FUSE test of the volumes: weed mount (the pinned SeaweedFS release of test/seaweedfs), FUSE 3,
# the Go toolchain for the Go tests of the volumes on the mount, and the static S3-Browser binary. compose.yaml gives
# this container /dev/fuse and SYS_ADMIN for the mount. No other container of the tests has them.
ARG GO_VERSION=1.22
FROM golang:${GO_VERSION}

ARG TARGETARCH
ARG SEAWEEDFS_VERSION=4.41
ARG SEAWEEDFS_LINUX_AMD64_SHA256=730f1ede19972c12954ee407b2d97679a2e4486d24fd987d371761ec395571b8
ARG SEAWEEDFS_LINUX_ARM64_SHA256=ecfb79fb8e0f235ea537948c9ea6041cec87c545746d369bf1f10e3ca10aa186

RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends fuse3; \
    rm -rf /var/lib/apt/lists/*; \
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

WORKDIR /src
COPY src/ ./
RUN CGO_ENABLED=0 go build -tags=netgo,osusergo -trimpath -o /usr/local/bin/s3-browser .

COPY test/volume-fuse/scripts/entrypoint.sh /bin/entrypoint.sh
ENTRYPOINT ["/bin/sh", "/bin/entrypoint.sh"]
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=20 \
  CMD ["/usr/local/bin/s3-browser", "healthcheck", "-c", "/config/config.hcl"]
