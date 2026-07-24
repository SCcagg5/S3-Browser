# syntax=docker/dockerfile:1.7

ARG GO_VERSION=1.22
FROM golang:${GO_VERSION}-alpine AS builder
ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_DATE=
WORKDIR /src

RUN apk add --no-cache ca-certificates && update-ca-certificates

COPY src/go.mod src/go.sum ./
RUN go mod download
COPY src/ ./

# A release can be unpacked over an older source tree. Remove the retired
# media-pipeline files before testing so stale files cannot re-enter the image.
RUN rm -f \
      media_sessions.go \
      media_sessions_test.go \
      media_process_unix_test.go \
      media_source_cache.go \
      media_source_cache_test.go \
      process_other.go \
      process_unix.go \
    && go test ./...

ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN set -eux; \
    CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" \
      go build \
        -tags=netgo,osusergo \
        -trimpath \
        -ldflags="-s -w -buildid= -X main.buildVersion=${VERSION} -X main.buildCommit=${COMMIT} -X main.buildDate=${BUILD_DATE}" \
        -o /out/rootfs/s3-browser .; \
    mkdir -p \
      /out/rootfs/config \
      /out/rootfs/data \
      /out/rootfs/etc/ssl/certs \
      /out/rootfs/tmp; \
    cp /etc/ssl/certs/ca-certificates.crt /out/rootfs/etc/ssl/certs/ca-certificates.crt; \
    printf 'nonroot:x:65532:65532:nonroot:/data:/sbin/nologin\n' > /out/rootfs/etc/passwd; \
    printf 'nonroot:x:65532:\n' > /out/rootfs/etc/group; \
    chown -R 65532:65532 /out/rootfs/data /out/rootfs/tmp; \
    chmod 0700 /out/rootfs/data; \
    chmod 1777 /out/rootfs/tmp

# The default and release runtime is a true scratch image. The statically
# linked Go binary, CA bundle, writable runtime directories, and numeric user
# metadata are the only files copied into it.
FROM scratch AS runtime
COPY --from=builder /out/rootfs/ /
USER 65532:65532
WORKDIR /data
ENV HOME=/data \
    TMPDIR=/tmp \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
VOLUME ["/data"]
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/s3-browser"]
CMD ["-c", "/config/config.hcl"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/s3-browser", "healthcheck", "--url", "http://127.0.0.1:8080/healthz"]
