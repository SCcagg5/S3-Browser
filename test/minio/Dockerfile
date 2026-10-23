# The MinIO of the browser test stack: one server with one drive. The MinIO project does not publish a server image or
# a server binary now, and its repository is archived. The image builds the last release from its Git tag. The build
# checks the commit of the tag, and go.sum checks each module.
FROM golang:1.24-alpine AS build

ARG MINIO_VERSION=RELEASE.2025-10-15T17-29-55Z
ARG MINIO_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a

RUN apk add --no-cache git
RUN set -eu; \
    git clone --quiet --depth 1 --branch "$MINIO_VERSION" https://github.com/minio/minio.git /src; \
    test "$(git -C /src rev-parse HEAD)" = "$MINIO_COMMIT"
WORKDIR /src
RUN CGO_ENABLED=0 GOTOOLCHAIN=local go build -trimpath -tags kqueue \
      -ldflags "-s -w -X github.com/minio/minio/cmd.Version=$(echo "$MINIO_VERSION" | sed 's/^RELEASE\.//; s/T\([0-9]*\)-\([0-9]*\)-\([0-9]*\)Z/T\1:\2:\3Z/') -X github.com/minio/minio/cmd.ReleaseTag=$MINIO_VERSION -X github.com/minio/minio/cmd.CommitID=$MINIO_COMMIT" \
      -o /out/minio .

FROM alpine:3.21

RUN apk add --no-cache curl
COPY --from=build /out/minio /usr/local/bin/minio
COPY ./scripts/entrypoint.sh /bin/entrypoint.sh
COPY ./scripts/healthcheck.sh /bin/healthcheck.sh

EXPOSE 9000

ENTRYPOINT ["/bin/sh", "/bin/entrypoint.sh"]
HEALTHCHECK --interval=10s --timeout=3s \
            --start-period=0s --start-interval=2s \
            --retries=5 \
            CMD ["/bin/sh", "/bin/healthcheck.sh"]
