FROM alpine:3.20

ARG FRP_VERSION=0.71.0
ARG TARGETARCH

RUN ARCH="${TARGETARCH:-amd64}" \
 && apk add --no-cache ca-certificates \
 && wget -qO- "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${ARCH}.tar.gz" \
    | tar xz -C /tmp \
 && mv /tmp/frp_${FRP_VERSION}_linux_${ARCH}/frps /usr/local/bin/frps \
 && rm -rf /tmp/frp_*

COPY frps.toml /etc/frp/frps.toml

CMD ["frps", "-c", "/etc/frp/frps.toml"]
