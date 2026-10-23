# The Garage of the browser test stack: one node with a replication factor of 1. The official image has the binary only
# (no shell), so this image copies the binary into Alpine for the scripts. The digest pins the multi-arch image.
ARG GARAGE_IMAGE=dxflrs/garage:v2.4.1@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020

FROM ${GARAGE_IMAGE} AS garage

FROM alpine:3.21

COPY --from=garage /garage /usr/local/bin/garage
COPY ./scripts/entrypoint.sh /bin/entrypoint.sh
COPY ./scripts/healthcheck.sh /bin/healthcheck.sh

EXPOSE 3900

ENTRYPOINT ["/bin/sh", "/bin/entrypoint.sh"]
HEALTHCHECK --interval=10s --timeout=3s \
            --start-period=0s --start-interval=2s \
            --retries=5 \
            CMD ["/bin/sh", "/bin/healthcheck.sh"]
