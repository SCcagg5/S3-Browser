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

RUN go test ./...

ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN set -eux; \
    CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" \
      go build \
        -tags=netgo,osusergo \
        -trimpath \
        -ldflags="-s -w -buildid= -X main.buildVersion=${VERSION} -X main.buildCommit=${COMMIT} -X main.buildDate=${BUILD_DATE}" \
        -o /out/rootfs/s3-browser .; \
    mkdir -p /out/rootfs/config /out/rootfs/etc/ssl/certs; \
    cp /etc/ssl/certs/ca-certificates.crt /out/rootfs/etc/ssl/certs/ca-certificates.crt

# The runtime contains only the static binary and CA bundle. The application
# does not require a writable filesystem, a data volume, or /tmp.
FROM scratch AS runtime
COPY --from=builder /out/rootfs/ /
USER 65532:65532
WORKDIR /
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/s3-browser"]
CMD ["-c", "/config/config.hcl"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/s3-browser", "healthcheck", "-c", "/config/config.hcl"]
