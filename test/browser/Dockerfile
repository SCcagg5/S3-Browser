FROM golang:1.22-alpine AS builder
WORKDIR /src
RUN apk add --no-cache ca-certificates

COPY src/go.mod src/go.sum ./
RUN go mod download
COPY src/ ./
RUN go test ./...
ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/s3-browser . && \
    mkdir -p /out/data && chown 65532:65532 /out/data

FROM alpine:3.22
RUN apk add --no-cache ca-certificates ffmpeg imagemagick && \
    mkdir -p /data && chown 65532:65532 /data
COPY --from=builder /out/s3-browser /s3-browser
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/s3-browser"]
CMD ["-c", "/config/config.hcl"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/s3-browser", "healthcheck", "--url", "http://127.0.0.1:8080/healthz"]
