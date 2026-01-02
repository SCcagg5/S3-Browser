FROM golang:1.22-alpine AS builder
WORKDIR /src
RUN apk add --no-cache ca-certificates

COPY src/go.mod ./
COPY src/main.go ./
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o /out/s3-browser

FROM alpine:3.20 AS assets
WORKDIR /work
RUN apk add --no-cache curl
COPY src/public /public

FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /out/s3-browser /s3-browser
COPY --from=assets /public /public
EXPOSE 8080
ENV PORT=8080
ENTRYPOINT ["/s3-browser"]
